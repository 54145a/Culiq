import { getActiveTab } from "@shared/transport/tab-rpc";

/**
 * Single source of truth for the sandbox's extension bridge. Each entry
 * declares the public signature (used to generate the .d.ts injected into the
 * system prompt and the worker-side shims) plus the SW-side `invoke` handler
 * that calls the real chrome.* API. The three derivations never drift.
 */
export interface BridgeSpecEntry {
	signature: string;
	description: string;
	invoke: (args: unknown[]) => Promise<unknown>;
}

export const BRIDGE_SPEC: Record<string, BridgeSpecEntry> = {
	"tabs.query": {
		signature: "query(queryInfo?: object): Promise<Tab[]>",
		description: "Query open tabs (mirrors chrome.tabs.query).",
		invoke: async ([queryInfo]) => chrome.tabs.query(queryInfo as chrome.tabs.QueryInfo),
	},
	"tabs.get": {
		signature: "get(tabId: number): Promise<Tab>",
		description: "Get a tab by id.",
		invoke: async ([tabId]) => chrome.tabs.get(Number(tabId)),
	},
	"tabs.update": {
		signature: "update(tabId: number, updateProperties: object): Promise<Tab>",
		description: "Update a tab, e.g. { active: true } to focus or { url } to navigate.",
		invoke: async ([tabId, updateProperties]) =>
			chrome.tabs.update(Number(tabId), updateProperties as chrome.tabs.UpdateProperties),
	},
	"tabs.create": {
		signature: "create(createProperties: object): Promise<Tab>",
		description: "Open a new tab (non-destructive).",
		invoke: async ([createProperties]) => chrome.tabs.create(createProperties as chrome.tabs.CreateProperties),
	},
	"tabs.duplicate": {
		signature: "duplicate(tabId: number): Promise<Tab>",
		description: "Duplicate a tab (non-destructive).",
		invoke: async ([tabId]) => chrome.tabs.duplicate(Number(tabId)),
	},
	"tabs.reload": {
		signature: "reload(tabId?: number, reloadProperties?: object): Promise<void>",
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
		signature: "waitForLoad(tabId: number, timeoutMs?: number): Promise<void>",
		description: "Wait for a tab to finish loading (status 'complete'). Default timeout 30s.",
		invoke: ([tabId, timeoutMs]) => waitForTabLoad(Number(tabId), timeoutMs != null ? Number(timeoutMs) : 30_000),
	},
	"windows.get": {
		signature: "get(windowId: number, queryOptions?: object): Promise<Window>",
		description: "Get a window.",
		invoke: async ([windowId, queryOptions]) =>
			chrome.windows.get(Number(windowId), queryOptions as chrome.windows.QueryOptions),
	},
	"windows.update": {
		signature: "update(windowId: number, updateInfo: object): Promise<Window>",
		description: "Update a window, e.g. { focused: true }.",
		invoke: async ([windowId, updateInfo]) =>
			chrome.windows.update(Number(windowId), updateInfo as chrome.windows.UpdateInfo),
	},
	evalInTab: {
		signature: "evalInTab(tabId: number, world: 'main' | 'isolated', code: string): Promise<string>",
		description:
			"Evaluate JavaScript in a tab's MAIN or ISOLATED world (mirrors the eval_js tool). Returns the serialized result; throws on error. Combine with sandbox.fs to store page content.",
		invoke: async ([tabId, world, code]) => evalInTab(Number(tabId), world === "main" ? "MAIN" : "ISOLATED", String(code)),
	},
	evalInAllFrames: {
		signature:
			"evalInAllFrames(tabId: number, world: 'main' | 'isolated', code: string): Promise<{frameId: number, ok: boolean, value?: string, error?: string}[]>",
		description:
			"Evaluate JavaScript in every frame of a tab (allFrames: true), piercing iframes. Returns one entry per frame with the serialized result or error.",
		invoke: async ([tabId, world, code]) =>
			evalInAllFrames(Number(tabId), world === "main" ? "MAIN" : "ISOLATED", String(code)),
	},
	docs: {
		signature: "docs(name?: string): Promise<string>",
		description: "Return the sandbox API declarations for a namespace (e.g. 'tabs'), a method (e.g. 'tabs.query'), or everything when omitted.",
		invoke: async ([name]) => (name ? sandboxDocs(String(name)) : generateSandboxDts()),
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
	const out: string[] = ["declare const sandbox: {", "  chrome: {"];
	for (const [ns, methods] of namespaceMap()) {
		out.push(`    ${ns}: {`);
		for (const m of methods) out.push(`      ${BRIDGE_SPEC[`${ns}.${m}`].signature};`);
		out.push(`    },`);
	}
	out.push("  },");
	for (const path of Object.keys(BRIDGE_SPEC)) {
		if (path.includes(".")) continue;
		out.push(`  ${BRIDGE_SPEC[path].signature};`);
	}
	out.push("};");
	return out.join("\n");
}

/** On-demand declarations with one-line descriptions for `sandbox.docs(name)`. */
export function sandboxDocs(name: string): string {
	if (name.includes(".")) {
		const entry = BRIDGE_SPEC[name];
		if (!entry) return `Unknown API: ${name}. Available: ${Object.keys(BRIDGE_SPEC).join(", ")}`;
		return `/* ${entry.description} */\n${entry.signature};`;
	}

	const methods = namespaceMap().get(name);
	const out: string[] = [];
	if (methods && methods.length > 0) {
		out.push(`declare const sandbox: { chrome: { ${name}: {`);
		for (const m of methods) {
			const entry = BRIDGE_SPEC[`${name}.${m}`];
			out.push(`  /* ${entry.description} */`);
			out.push(`  ${entry.signature};`);
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

function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			chrome.tabs.onUpdated.removeListener(onUpdate);
			clearTimeout(timer);
			err ? reject(err) : resolve();
		};
		const onUpdate = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
			if (id === tabId && info.status === "complete") finish();
		};
		const timer = setTimeout(() => finish(new Error(`waitForLoad timed out after ${timeoutMs / 1000}s`)), timeoutMs);
		chrome.tabs.onUpdated.addListener(onUpdate);
		chrome.tabs.get(tabId).then((tab) => {
			if (tab.status === "complete") finish();
		});
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
