import { getActiveTab } from "@shared/transport/tab-rpc";
import type { Capability } from "@shared/config";
import { readDomTool, clickTool, typeTool } from "../browser/dom";
import { navigateTool } from "../browser/navigate";
import { fetchUrlTool } from "../browser/fetch-url";
import { useSkillTool } from "../skills/use-skill";
import { listTabsTool, switchTabTool, reloadTabTool } from "../browser/tabs";
import { readText, listDirEntries, write, remove, createDir } from "@shared/opfs";
import { optionalOpts, optsOf, requireNumber, requireString } from "./options";

/**
 * Single source of truth for the sandbox's extension bridge. Each entry
 * declares the public API surface (used to generate the .d.ts injected into the
 * system prompt and the worker-side shims) plus the SW-side `invoke` handler
 * that calls the real chrome.* API. The three derivations never drift.
 */
/** Per-call context handed to each bridge `invoke` by the sandbox session. */
export interface SandboxCtx {
	subagent?: (task: string) => Promise<string>;
}

export interface BridgeSpecEntry {
	description: string;
	invoke: (args: unknown[], ctx: SandboxCtx) => Promise<unknown>;
	/** Internal bridge (called via proxy, not directly by agent). Excluded from docs and shims. */
	internal?: boolean;
}

function bridge(description: string, invoke: BridgeSpecEntry["invoke"]): BridgeSpecEntry {
	return { description, invoke };
}

function internalBridge(description: string, invoke: BridgeSpecEntry["invoke"]): BridgeSpecEntry {
	return { description, invoke, internal: true };
}

function ns(prefix: string, methods: Record<string, BridgeSpecEntry>) {
	return Object.fromEntries(Object.entries(methods).map(([k, v]) => [`${prefix}.${k}`, v]));
}

/** Maps a bridge path to the capability that gates it; entries absent here are always enabled (raw chrome.* / meta helpers). */
const PATH_CAPABILITY: Record<string, Capability> = {
	readDom: "read_dom",
	click: "click",
	type: "type",
	navigate: "navigate",
	fetchUrl: "fetch_url",
	useSkill: "use_skill",
	listTabs: "list_tabs",
	switchTab: "switch_tab",
	reloadTab: "reload_tab",
	evalInTab: "eval_js",
	evalInAllFrames: "eval_js",
	subtask: "subtask",
};

/** Whether a bridge path is allowed given the session's enabled capabilities. */
export function isPathEnabled(path: string, enabled: Set<Capability>): boolean {
	const cap = PATH_CAPABILITY[path];
	return cap === undefined ? true : enabled.has(cap);
}

/** Extract text from a native tool result, throwing if the tool reported an error. */
function toolText(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
	if (result.isError) throw new Error(result.content.map((c) => c.text ?? "").join("\n") || "tool error");
	return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

export const BRIDGE_SPEC: Record<string, BridgeSpecEntry> = {
	// ── Chrome tabs ─────────────────────────────────────────────────────────
	...ns("tabs", {
		query: bridge("Query open tabs (mirrors chrome.tabs.query).", ([q]) => chrome.tabs.query(q as chrome.tabs.QueryInfo)),
		get: bridge("Get a tab by id.", ([id]) => chrome.tabs.get(Number(id))),
		update: bridge("Update a tab, e.g. { active: true } to focus or { url } to navigate.", ([id, props]) =>
			chrome.tabs.update(Number(id), props as chrome.tabs.UpdateProperties)),
		create: bridge("Open a new tab (non-destructive).", ([props]) => chrome.tabs.create(props as chrome.tabs.CreateProperties)),
		duplicate: bridge("Duplicate a tab (non-destructive).", ([id]) => chrome.tabs.duplicate(Number(id))),
		reload: bridge("Reload a tab; defaults to the active tab.", async ([id, props]) => {
			if (id === undefined) {
				const tab = await getActiveTab();
				return chrome.tabs.reload(tab.id as number, props as chrome.tabs.ReloadProperties);
			}
			return chrome.tabs.reload(Number(id), props as chrome.tabs.ReloadProperties);
		}),
		waitForLoad: bridge("Wait for a tab to finish loading (status 'complete'). Default timeout 30s.",
			([id, ms]) => waitForTabLoad(Number(id), ms != null ? Number(ms) : 30_000)),
	}),
	// ── Chrome windows ──────────────────────────────────────────────────────
	...ns("windows", {
		get: bridge("Get a window.", ([id, opts]) =>
			chrome.windows.get(Number(id), opts as chrome.windows.QueryOptions)),
		update: bridge("Update a window, e.g. { focused: true }.", ([id, info]) =>
			chrome.windows.update(Number(id), info as chrome.windows.UpdateInfo)),
	}),
	// ── Tab tools ───────────────────────────────────────────────────────────
	evalInTab: bridge(
		"Evaluate JavaScript in a tab's MAIN or ISOLATED world (mirrors the eval_js tool). Options: { tabId, world?, code }. Returns the serialized result; throws on error. Combine with `sandbox.write` to store page content.",
		(args) => {
			const opts = optsOf(args, "evalInTab");
			return evalInTab(requireNumber(opts, "tabId", "evalInTab"), opts.world === "main" ? "MAIN" : "ISOLATED", requireString(opts, "code", "evalInTab"));
		}),
	evalInAllFrames: bridge(
		"Evaluate JavaScript in every frame of a tab (allFrames: true), piercing iframes. Options: { tabId, world?, code }. Returns one entry per frame with the serialized result or error.",
		(args) => {
			const opts = optsOf(args, "evalInAllFrames");
			return evalInAllFrames(requireNumber(opts, "tabId", "evalInAllFrames"), opts.world === "main" ? "MAIN" : "ISOLATED", requireString(opts, "code", "evalInAllFrames"));
		}),
	readDom: bridge("Read the active page's DOM (identical to the read_dom tool). Options: { mode?, selector?, maxChars? }.",
		(args) => readDomTool.execute(optionalOpts(args, "readDom") as never).then(toolText)),
	click: bridge("Click an element on the active page (identical to the click tool). Options: { selector, index? }. If multiple elements match, returns an error listing all matches.",
		(args) => {
			const opts = optsOf(args, "click");
			return clickTool.execute({ ...opts, selector: requireString(opts, "selector", "click") } as never).then(toolText);
		}),
	type: bridge("Type text into an input on the active page (identical to the type tool). Options: { selector, text, submit?, clear? }.",
		(args) => {
			const opts = optsOf(args, "type");
			return typeTool.execute({ ...opts, selector: requireString(opts, "selector", "type"), text: requireString(opts, "text", "type") } as never).then(toolText);
		}),
	navigate: bridge("Navigate to a URL on the active tab or a new tab (identical to the navigate tool). Options: { url, newTab?, waitForLoad? }.",
		(args) => {
			const opts = optsOf(args, "navigate");
			return navigateTool.execute({ ...opts, url: requireString(opts, "url", "navigate") } as never).then(toolText);
		}),
	useSkill: bridge(
		"Access a skill's index or a file within it (identical to the `use_skill` tool). Options: { name, file?, maxChars? }. Omit `file` for the index, or set `file` (e.g. 'SKILL.md') to read it. `maxChars` truncates file content.",
		(args) => {
			const opts = optsOf(args, "useSkill");
			return useSkillTool.execute({ ...opts, name: requireString(opts, "name", "useSkill") } as never).then(toolText);
		}),
	fetchUrl: bridge(
		"Fetch a URL, load it in a tab, and extract readable content (identical to the `fetch_url` tool). Options: { url, mode?, maxChars?, selector? }. Returns the extracted text. Default mode is 'markdown'.",
		(args) => {
			const opts = optsOf(args, "fetchUrl");
			return fetchUrlTool.execute({ ...opts, url: requireString(opts, "url", "fetchUrl") } as never).then(toolText);
		}),
	listTabs: bridge("List open tabs (id, url, title, active state), excluding internal chrome:// URLs (identical to the `list_tabs` tool). Options: { max? }.",
		(args) => listTabsTool.execute(optionalOpts(args, "listTabs") as never).then(toolText)),
	switchTab: bridge("Activate a tab by id and focus its window (identical to the `switch_tab` tool). Options: { tabId }.",
		(args) => {
			const opts = optsOf(args, "switchTab");
			return switchTabTool.execute({ ...opts, tabId: requireNumber(opts, "tabId", "switchTab") } as never).then(toolText);
		}),
	reloadTab: bridge("Reload a tab (defaults to the active tab); optional `bypassCache` (identical to the `reload_tab` tool). Options: { tabId?, bypassCache? }.",
		(args) => {
			const opts = optionalOpts(args, "reloadTab");
			const tabId = opts.tabId === undefined ? {} : { tabId: requireNumber(opts, "tabId", "reloadTab") };
			return reloadTabTool.execute({ ...opts, ...tabId } as never).then(toolText);
		}),
	subtask: bridge(
		"Run a small sub-agent on a self-contained task and return its final answer (identical to the `subtask` tool). Options: { task }. The sub-agent carries no main-conversation context, so it is token-efficient for quick goals like 'find the submit button and click it'.",
		async (args, ctx) => {
			if (!ctx.subagent) throw new Error("sandbox.subtask is not available");
			return ctx.subagent(requireString(optsOf(args, "subtask"), "task", "subtask"));
		}),
	docs: bridge("Return the sandbox API declarations for a namespace (e.g. 'tabs'), a method (e.g. 'tabs.query'), or everything when omitted. Options: { name? }.",
		async (args) => {
			const name = optionalOpts(args, "docs").name;
			return name ? sandboxDocs(String(name)) : generateSandboxDts();
		}),
	// ── Filesystem (bridge to opfs.ts) ──────────────────────────────────────
	...ns("fs", {
		read: bridge("Read a file from OPFS. Returns the file content as a string.",
			async ([path]) => await readText(String(path)) ?? ""),
		write: bridge("Write a string to a file in OPFS.",
			async ([path, content]) => { await write(String(path), String(content)); }),
		list: bridge("List files and directories in an OPFS path.",
			async ([path]) => listDirEntries(String(path))),
		delete: bridge("Delete a file or directory from OPFS.",
			async ([path]) => { await remove(String(path)); }),
		mkdir: bridge("Create a directory in OPFS.",
			async ([path]) => { await createDir(String(path)); }),
	}),
	tree: bridge("Recursively list all files and directories under a path, returning a formatted tree string.",
		async ([path]) => {
			const p = String(path || "");
			const lines: string[] = [];
			async function walk(dirPath: string, prefix: string) {
				const entries = await listDirEntries(dirPath);
				for (let i = 0; i < entries.length; i++) {
					const child = entries[i];
					const isLast = i === entries.length - 1;
					const connector = isLast ? "└── " : "├── ";
					const childPrefix = isLast ? "    " : "│   ";
					const childPath = dirPath ? `${dirPath}/${child.name}` : child.name;
					if (child.kind === "file") {
						lines.push(`${prefix}${connector}${child.name}`);
					} else {
						lines.push(`${prefix}${connector}${child.name}/`);
						await walk(childPath, `${prefix}${childPrefix}`);
					}
				}
			}
			await walk(p, "");
			return lines.join("\n") || "(empty)";
		}),
	// ── Fetch (bridge to extension context, CORS-free) ──────────────────────
	fetch: bridge("Fetch a URL with CORS-free access (uses extension context). Returns a Response-like object. Call .text(), .json(), or .arrayBuffer() to read the body.",
		async ([input, init]) => {
			const res = await fetch(String(input), init as RequestInit);
			const headers: Record<string, string> = {};
			res.headers.forEach((v, k) => { headers[k] = v; });
			const id = responseStore.size;
			responseStore.set(id, res);
			return { __type: "response", id, status: res.status, ok: res.ok, headers };
		}),
	// ── Response body methods (called via proxy, internal) ──────────────────
	"response.text": internalBridge("Read the response body as text.", async ([id]) => {
		const res = responseStore.get(Number(id));
		if (!res) throw new Error("Response not found (may have been consumed).");
		responseStore.delete(Number(id));
		return await res.text();
	}),
	"response.json": internalBridge("Read the response body as parsed JSON.", async ([id]) => {
		const res = responseStore.get(Number(id));
		if (!res) throw new Error("Response not found (may have been consumed).");
		responseStore.delete(Number(id));
		return await res.json();
	}),
	"response.arrayBuffer": internalBridge("Read the response body as an ArrayBuffer.", async ([id]) => {
		const res = responseStore.get(Number(id));
		if (!res) throw new Error("Response not found (may have been consumed).");
		responseStore.delete(Number(id));
		const buf = await res.arrayBuffer();
		return Array.from(new Uint8Array(buf));
	}),
};

/** Store for response objects created by the fetch bridge. */
const responseStore = new Map<number, Response>();

/** Namespace → method names, derived from the spec. */
function namespaceMap(): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const path of Object.keys(BRIDGE_SPEC)) {
		const dot = path.indexOf(".");
		if (dot === -1) continue;
		// Skip internal response.* methods — they're called via proxy, not directly.
		if (path.startsWith("response.")) continue;
		const ns = path.slice(0, dot);
		const method = path.slice(dot + 1);
		if (!map.has(ns)) map.set(ns, []);
		map.get(ns)!.push(method);
	}
	return map;
}

/**
 * JS source injected into the sandbox worker: the bridge RPC machinery plus
 * `sandbox.chrome.*` and the top-level bridge functions, all derived from the
 * spec so the worker-side surface always matches the declared .d.ts.
 */
export function generateSandboxShims(): string {
	const namespaces: string[] = [];
	for (const [ns, methods] of namespaceMap()) {
		namespaces.push(
			`${ns}: { ${methods.map((m) => `${m}: (...args) => bridgeCall("${ns}.${m}", args)`).join(", ")} }`,
		);
	}

	const topLevel: string[] = [];
	for (const path of Object.keys(BRIDGE_SPEC)) {
		if (path.includes(".")) continue;
		topLevel.push(`${path}: (...args) => bridgeCall("${path}", args)`);
	}

	return [
		`const bridgeCalls = new Map();`,
		`let nextBridgeId = 1;`,
		`function bridgeCall(path, args) {
  return new Promise((resolve, reject) => {
    const id = nextBridgeId++;
    bridgeCalls.set(id, { resolve, reject });
    self.postMessage({ kind: "bridge", id, path, args });
  });
}`,
		`sandbox.chrome = { ${namespaces.join(", ")} };`,
		topLevel.length ? `Object.assign(sandbox, { ${topLevel.join(", ")} });` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Real signatures of the top-level helpers, mirroring
 * `packages/culiq-sandbox/sandbox.d.ts`. Namespace members keep positional
 * arguments (they mirror the chrome.* APIs), so they stay generic.
 */
const TOP_LEVEL_SIGNATURES: Record<string, string> = {
	tree: "tree(path?: string): Promise<string>",
	fetch: "fetch(input: string, init?: unknown): Promise<SandboxResponse>",
	evalInTab: 'evalInTab(options: { tabId: number; world?: "isolated" | "main"; code: string }): Promise<string>',
	evalInAllFrames: 'evalInAllFrames(options: { tabId: number; world?: "isolated" | "main"; code: string }): Promise<string>',
	readDom: "readDom(options?: { mode?: ReadDomMode; selector?: string; maxChars?: number }): Promise<string>",
	click: "click(options: { selector: string; index?: number }): Promise<string>",
	type: "type(options: { selector: string; text: string; submit?: boolean; clear?: boolean }): Promise<string>",
	navigate: "navigate(options: { url: string; newTab?: boolean; waitForLoad?: boolean }): Promise<string>",
	useSkill: "useSkill(options: { name: string; file?: string; maxChars?: number }): Promise<string>",
	fetchUrl: "fetchUrl(options: { url: string; mode?: ReadDomMode; maxChars?: number; selector?: string }): Promise<string>",
	listTabs: "listTabs(options?: { max?: number }): Promise<string>",
	switchTab: "switchTab(options: { tabId: number }): Promise<string>",
	reloadTab: "reloadTab(options?: { tabId?: number; bypassCache?: boolean }): Promise<string>",
	subtask: "subtask(options: { task: string }): Promise<string>",
	docs: "docs(options?: { name?: string }): Promise<string>",
};

/** Compact .d.ts appended to the system prompt when the sandbox is enabled. */
export function generateSandboxDts(): string {
	const out: string[] = [
		"interface SandboxResponse { status: number; ok: boolean; headers: Record<string, string>; text(): Promise<string>; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; }",
		'type ReadDomMode = "markdown" | "html" | "readable_html" | "outline";',
		"declare const sandbox: {",
		"  file(path: string): { text(): Promise<string>; remove(): Promise<void> };",
		"  dir(path: string): { children(): Promise<Array<{ name: string; kind: string }>>; create(): Promise<void>; remove(): Promise<void> };",
		"  write(path: string, content: string): Promise<void>;",
		"  chrome: {",
	];
	for (const [ns, methods] of namespaceMap()) {
		out.push(`    ${ns}: {`);
		for (const m of methods) {
			const desc = BRIDGE_SPEC[`${ns}.${m}`].description;
			out.push(`      // ${desc}`);
			out.push(`      ${m}(...args: unknown[]): Promise<unknown>;`);
		}
		out.push("    },");
	}
	out.push("  },");
	for (const path of Object.keys(BRIDGE_SPEC)) {
		if (path.includes(".")) continue;
		out.push(`  // ${BRIDGE_SPEC[path].description}`);
		out.push(`  ${TOP_LEVEL_SIGNATURES[path] ?? `${path}(...args: unknown[]): Promise<unknown>`}`);
	}
	out.push("};");
	return out.join("\n");
}

/** On-demand declarations for `sandbox.docs(name)`. */
export function sandboxDocs(name: string): string {
	if (name.includes(".")) {
		const entry = BRIDGE_SPEC[name];
		if (!entry) return `Unknown API: ${name}. Available: ${Object.keys(BRIDGE_SPEC).join(", ")}`;
		return `// ${entry.description}\n${name.replace(/\./, "_")}(...args: unknown[]): Promise<unknown>;`;
	}

	if (!name) return generateSandboxDts();

	const methods = namespaceMap().get(name);
	if (methods && methods.length > 0) {
		const out = [`declare const sandbox: { chrome: { ${name}: {`];
		for (const m of methods) {
			out.push(`  // ${BRIDGE_SPEC[`${name}.${m}`].description}`);
			out.push(`  ${m}(...args: unknown[]): Promise<unknown>;`);
		}
		out.push("} } };");
		return out.join("\n");
	}

	const signature = TOP_LEVEL_SIGNATURES[name];
	if (signature && BRIDGE_SPEC[name]) {
		return `// ${BRIDGE_SPEC[name].description}\n${signature};`;
	}

	return `Unknown API: ${name}. Available: ${Object.keys(BRIDGE_SPEC).join(", ")}`;
}

type TabRunnerOutcome = { ok: boolean; value?: string; error?: string };

async function evalInTab(tabId: number, world: "MAIN" | "ISOLATED", code: string): Promise<string> {
	const results = await chrome.scripting.executeScript({
		target: { tabId },
		world,
		func: tabRunner,
		args: [code],
	});
	const outcome = (results[0]?.result as TabRunnerOutcome | undefined) ?? { ok: false, error: "evalInTab: no result" };
	if (!outcome.ok) throw new Error(outcome.error ?? "evalInTab failed");
	return outcome.value ?? "";
}

function waitForTabLoad(tabId: number, timeoutMs: number, signal?: AbortSignal, expectedUrl?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const settleThenFinish = () => {
			if (settled) return;
			settleTimer = setTimeout(() => finish(), 5_000);
		};
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (settleTimer) clearTimeout(settleTimer);
			chrome.tabs.onUpdated.removeListener(onUpdate);
			chrome.tabs.onRemoved.removeListener(onRemoved);
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (err) reject(err); else resolve();
		};
		const onUpdate = (id: number, info: chrome.tabs.OnUpdatedInfo, tab?: chrome.tabs.Tab) => {
			if (id !== tabId) return;
			if (expectedUrl && tab?.url && !tab.url.startsWith(expectedUrl)) return;
			if (info.status === "complete") settleThenFinish();
		};
		const onRemoved = (id: number) => {
			if (id === tabId) finish(new Error("Tab was closed while waiting for load."));
		};
		const onAbort = () => finish(new Error("aborted"));
		const timer = setTimeout(() => finish(new Error(`waitForLoad timed out after ${timeoutMs / 1000}s`)), timeoutMs);
		chrome.tabs.onUpdated.addListener(onUpdate);
		chrome.tabs.onRemoved.addListener(onRemoved);
		signal?.addEventListener("abort", onAbort);
		chrome.tabs.get(tabId).then((tab) => {
			if (tab.status === "complete") settleThenFinish();
		}).catch(() => {});
	});
}

async function evalInAllFrames(
	tabId: number,
	world: "MAIN" | "ISOLATED",
	code: string,
): Promise<Array<{ frameId: number; ok: boolean; value?: string; error?: string }>> {
	const results = await chrome.scripting.executeScript({
		target: { tabId, allFrames: true },
		world,
		func: tabRunner,
		args: [code],
	});
	return results.map((r) => {
		const outcome = (r.result as TabRunnerOutcome | undefined) ?? { ok: false, error: "evalInAllFrames: no result" };
		return outcome.ok
			? { frameId: r.frameId, ok: true, value: outcome.value ?? "" }
			: { frameId: r.frameId, ok: false, error: outcome.error ?? "evalInAllFrames failed" };
	});
}

async function tabRunner(code: string): Promise<TabRunnerOutcome> {
	function safeStringify(value: unknown): string {
		const seen = new WeakSet<object>();
		try {
			return JSON.stringify(
				value,
				function replacer(_key, val) {
					if (val === undefined) return "[undefined]";
					if (val === null) return null;
					if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`;
					if (typeof val === "symbol") return val.toString();
					if (typeof val === "bigint") return `${val.toString()}n`;
					if (val instanceof Error) {
						return { __type: "Error", name: val.name, message: val.message, stack: val.stack };
					}
					if (val instanceof Date) return { __type: "Date", iso: val.toISOString() };
					if (val instanceof RegExp) return val.toString();
					if (val instanceof Map) return { __type: "Map", entries: Array.from(val.entries()).slice(0, 50) };
					if (val instanceof Set) return { __type: "Set", values: Array.from(val.values()).slice(0, 50) };
					if (typeof val === "object") {
						const node = val as { nodeType?: number; tagName?: string; nodeName?: string };
						if (node.nodeType !== undefined && node.tagName !== undefined) {
							const el = val as Element;
							return `[Element <${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}>]`;
						}
						if (node.nodeType !== undefined) return `[Node ${node.nodeName ?? "?"}]`;
						if (seen.has(val as object)) return "[Circular]";
						seen.add(val as object);
					}
					return val;
				},
				2,
			);
		} catch (err) {
			return `[stringify failed: ${err instanceof Error ? err.message : String(err)}]`;
		}
	}

	try {
		const fn = new Function(`return (async function() { ${code} })()`);
		const value = await fn();
		return { ok: true, value: typeof value === "string" ? value : safeStringify(value) };
	} catch (err) {
		const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
		return { ok: false, error: message };
	}
}
