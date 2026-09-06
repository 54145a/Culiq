import { getActiveTab } from "@shared/transport/tab-rpc";
import type { Capability } from "@shared/config";
import { readDomTool, queryTool, clickTool, typeTool } from "../browser/dom";
import { navigateTool } from "../browser/navigate";
import { fetchUrlTool } from "../browser/fetch-url";
import { useSkillTool } from "../skills/use-skill";
import { listTabsTool, switchTabTool, reloadTabTool } from "../browser/tabs";
import { file, dir, write } from "@shared/opfs";

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
}

/** Maps a bridge path to the capability that gates it; entries absent here are always enabled (raw chrome.* / meta helpers). */
const PATH_CAPABILITY: Record<string, Capability> = {
	readDom: "read_dom",
	query: "query",
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
	"tabs.query": {
		description: "Query open tabs (mirrors chrome.tabs.query).",
		invoke: async ([queryInfo]) => chrome.tabs.query(queryInfo as chrome.tabs.QueryInfo),
	},
	"tabs.get": {
		description: "Get a tab by id.",
		invoke: async ([tabId]) => chrome.tabs.get(Number(tabId)),
	},
	"tabs.update": {
		description: "Update a tab, e.g. { active: true } to focus or { url } to navigate.",
		invoke: async ([tabId, updateProperties]) =>
			chrome.tabs.update(Number(tabId), updateProperties as chrome.tabs.UpdateProperties),
	},
	"tabs.create": {
		description: "Open a new tab (non-destructive).",
		invoke: async ([createProperties]) => chrome.tabs.create(createProperties as chrome.tabs.CreateProperties),
	},
	"tabs.duplicate": {
		description: "Duplicate a tab (non-destructive).",
		invoke: async ([tabId]) => chrome.tabs.duplicate(Number(tabId)),
	},
	"tabs.reload": {
		description: "Reload a tab; defaults to the active tab.",
		invoke: async ([tabId, reloadProperties]) => {
			if (tabId === undefined) {
				const tab = await getActiveTab();
				return chrome.tabs.reload(tab.id as number, reloadProperties as chrome.tabs.ReloadProperties);
			}
			return chrome.tabs.reload(Number(tabId), reloadProperties as chrome.tabs.ReloadProperties);
		},
	},
	"tabs.waitForLoad": {
		description: "Wait for a tab to finish loading (status 'complete'). Default timeout 30s.",
		invoke: ([tabId, timeoutMs]) => waitForTabLoad(Number(tabId), timeoutMs != null ? Number(timeoutMs) : 30_000),
	},
	"windows.get": {
		description: "Get a window.",
		invoke: async ([windowId, queryOptions]) =>
			chrome.windows.get(Number(windowId), queryOptions as chrome.windows.QueryOptions),
	},
	"windows.update": {
		description: "Update a window, e.g. { focused: true }.",
		invoke: async ([windowId, updateInfo]) =>
			chrome.windows.update(Number(windowId), updateInfo as chrome.windows.UpdateInfo),
	},
	evalInTab: {
		description:
			"Evaluate JavaScript in a tab's MAIN or ISOLATED world (mirrors the eval_js tool). Returns the serialized result; throws on error. Combine with `sandbox.write` to store page content.",
		invoke: async ([tabId, world, code]) => evalInTab(Number(tabId), world === "main" ? "MAIN" : "ISOLATED", String(code)),
	},
	evalInAllFrames: {
		description:
			"Evaluate JavaScript in every frame of a tab (allFrames: true), piercing iframes. Returns one entry per frame with the serialized result or error.",
		invoke: async ([tabId, world, code]) =>
			evalInAllFrames(Number(tabId), world === "main" ? "MAIN" : "ISOLATED", String(code)),
	},
	readDom: {
		description: "Read the active page's DOM (identical to the read_dom tool).",
		invoke: ([options]) => readDomTool.execute((options ?? {}) as never).then(toolText),
	},
	click: {
		description: "Click an element on the active page (identical to the click tool).",
		invoke: ([selector, index]) => clickTool.execute({ selector: String(selector), index: index as number } as never).then(toolText),
	},
	type: {
		description: "Type text into an input on the active page (identical to the type tool).",
		invoke: ([selector, text, options]) =>
			typeTool.execute({ selector: String(selector), text: String(text), ...((options ?? {}) as Record<string, unknown>) } as never).then(toolText),
	},
	navigate: {
		description: "Navigate to a URL on the active tab or a new tab (identical to the navigate tool).",
		invoke: ([url, options]) => navigateTool.execute({ url: String(url), ...((options ?? {}) as Record<string, unknown>) } as never).then(toolText),
	},
	query: {
		description:
			"Locate elements by CSS selector (identical to the `query` tool). Returns an array of match summaries (tag, id, classes, text, attributes, rect, visibility, disabled). Pass `{ all: false }` for the first match only; `limit` caps results.",
		invoke: ([selector, all, limit]) =>
			queryTool.execute({ selector: String(selector), all: all as boolean, limit: limit as number } as never).then(toolText),
	},
	useSkill: {
		description:
			"Access a skill's index or a file within it (identical to the `use_skill` tool). Pass `name`; omit `file` for the index, or set `file` (e.g. 'SKILL.md') to read it. `maxChars` truncates file content.",
		invoke: ([name, file, maxChars]) => useSkillTool.execute({ name: String(name), file: file as string, maxChars: maxChars as number } as never).then(toolText),
	},
	fetchUrl: {
		description:
			"Fetch a URL, load it in a tab, and extract readable content (identical to the `fetch_url` tool). Options: url, mode ('markdown'|'html'|'readable_html'|'outline'), maxChars, selector, afterLoad ('close'|'open'), probeMime. Returns the extracted text.",
		invoke: ([options]) => fetchUrlTool.execute((options ?? {}) as never).then(toolText),
	},
	listTabs: {
		description: "List open tabs (id, url, title, active state), excluding internal chrome:// URLs (identical to the `list_tabs` tool).",
		invoke: ([max]) => listTabsTool.execute({ max: max as number } as never).then(toolText),
	},
	switchTab: {
		description: "Activate a tab by id and focus its window (identical to the `switch_tab` tool).",
		invoke: ([tabId]) => switchTabTool.execute({ tabId: Number(tabId) } as never).then(toolText),
	},
	reloadTab: {
		description: "Reload a tab (defaults to the active tab); optional `bypassCache` (identical to the `reload_tab` tool).",
		invoke: ([tabId, bypassCache]) => reloadTabTool.execute({ tabId: Number(tabId), bypassCache: bypassCache as boolean } as never).then(toolText),
	},
	subtask: {
		description:
			"Run a small sub-agent on a self-contained task and return its final answer (identical to the `subtask` tool). The sub-agent carries no main-conversation context, so it is token-efficient for quick goals like 'find the submit button and click it'.",
		invoke: async ([task], ctx) => {
			if (!ctx.subagent) throw new Error("sandbox.subtask is not available");
			return ctx.subagent(String(task));
		},
	},
	docs: {
		description: "Return the sandbox API declarations for a namespace (e.g. 'tabs'), a method (e.g. 'tabs.query'), or everything when omitted.",
		invoke: async ([name]) => (name ? sandboxDocs(String(name)) : generateSandboxDts()),
	},

	// ── Filesystem (bridge to opfs.ts) ──────────────────────────────────────
	"fs.read": {
		description: "Read a file from OPFS. Returns the file content as a string.",
		invoke: async ([path]) => file(String(path)).text(),
	},
	"fs.write": {
		description: "Write a string to a file in OPFS.",
		invoke: async ([path, content]) => { await write(String(path), String(content)); },
	},
	"fs.list": {
		description: "List files and directories in an OPFS path.",
		invoke: async ([path]) => {
			const children = await dir(String(path)).children();
			return children.map((c) => ({ name: c.name, kind: c.kind }));
		},
	},
	"fs.delete": {
		description: "Delete a file or directory from OPFS.",
		invoke: async ([path]) => { await file(String(path)).remove(); },
	},
	"fs.mkdir": {
		description: "Create a directory in OPFS.",
		invoke: async ([path]) => { await dir(String(path)).create(); },
	},
	tree: {
		description: "Recursively list all files and directories under a path, returning a formatted tree string.",
		invoke: async ([path]) => {
			const p = String(path || "");
			const lines: string[] = [];
			async function walk(d: any, prefix: string) {
				const children = await d.children();
				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					const isLast = i === children.length - 1;
					const connector = isLast ? "└── " : "├── ";
					const childPrefix = isLast ? "    " : "│   ";
					if (child.kind === "file") {
						lines.push(`${prefix}${connector}${child.name}`);
					} else {
						lines.push(`${prefix}${connector}${child.name}/`);
						await walk(child, `${prefix}${childPrefix}`);
					}
				}
			}
			await walk(dir(p), "");
			return lines.join("\n") || "(empty)";
		},
	},

	// ── Fetch (bridge to extension context, CORS-free) ──────────────────────
	fetch: {
		description: "Fetch a URL with CORS-free access (uses extension context). Returns { status, ok, headers, text, json } where text and json are pre-fetched strings.",
		invoke: async ([input, init]) => {
			const res = await fetch(String(input), init as RequestInit);
			const headers: Record<string, string> = {};
			res.headers.forEach((v, k) => { headers[k] = v; });
			const text = await res.text();
			let json: unknown;
			try { json = JSON.parse(text); } catch { /* not JSON */ }
			return { status: res.status, ok: res.ok, headers, text, json };
		},
	},
};

/** Namespace → method names, derived from the spec. */
function namespaceMap(): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const path of Object.keys(BRIDGE_SPEC)) {
		const dot = path.indexOf(".");
		if (dot === -1) continue;
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

/** Compact .d.ts appended to the system prompt when the sandbox is enabled. */
export function generateSandboxDts(): string {
	const out: string[] = [
		"interface ToolResultContent { type: string; text?: string; [key: string]: unknown; }",
		"interface ToolResult { content: ToolResultContent[]; isError?: boolean; }",
		"declare const sandbox: {",
		"  chrome: {",
	];
	for (const [ns, methods] of namespaceMap()) {
		out.push(`    ${ns}: {`);
		for (const m of methods) {
			const desc = BRIDGE_SPEC[`${ns}.${m}`].description;
			out.push(`    // ${desc}`);
			out.push(`    ${m}(args: unknown[]): Promise<ToolResult>`);
		}
		out.push("    },");
	}
	out.push("  },");
	for (const path of Object.keys(BRIDGE_SPEC)) {
		if (path.includes(".")) continue;
		const desc = BRIDGE_SPEC[path].description;
		out.push(`  // ${desc}`);
		out.push(`  ${path}(args: unknown[]): Promise<ToolResult>`);
	}
	out.push("};");
	return out.join("\n");
}

/** On-demand declarations for `sandbox.docs(name)`. */
export function sandboxDocs(name: string): string {
	if (name.includes(".")) {
		const entry = BRIDGE_SPEC[name];
		if (!entry) return `Unknown API: ${name}. Available: ${Object.keys(BRIDGE_SPEC).join(", ")}`;
		return `// ${entry.description}\n${name.replace(/\./, "_")}(args: any[]): Promise<any>;`;
	}

	const methods = namespaceMap().get(name);
	const out: string[] = [];
	if (methods && methods.length > 0) {
		out.push(`declare const sandbox: { chrome: { ${name}: {`);
		for (const m of methods) {
			const entry = BRIDGE_SPEC[`${name}.${m}`];
			out.push(`  // ${entry.description}`);
			out.push(`  ${m}(args: any[]): Promise<any>;`);
		}
		out.push(`} } };`);
	}
	if (!name) {
		out.push("", generateSandboxDts());
	}
	if (out.length === 0) {
		return `Unknown namespace: ${name}. Available: ${Object.keys(BRIDGE_SPEC).join(", ")}`;
	}
	return out.join("\n");
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

function waitForTabLoad(tabId: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
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
		const onUpdate = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
			if (id === tabId && info.status === "complete") settleThenFinish();
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
