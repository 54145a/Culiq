import { getActiveTab } from "@shared/transport/tab-rpc";
import type { AgentTool } from "../../types";

const EVAL_TIMEOUT_MS = 30_000;

type RunnerOutcome = { ok: true; kind: string; value: string } | { ok: false; error: string };

export const evalJsTool: AgentTool = {
	name: "eval_js",
	description:
		"Execute JavaScript in the active tab. Always choose `world` explicitly: use `main` for reverse engineering, page globals, framework state, or fetch/XHR hooks; use `isolated` only for DOM-only operations that do not need page JavaScript state. Write a function body and `return` the value (top-level await supported). Result is JSON-stringified with truncation; DOM nodes, functions, errors, circular refs are stringified safely.",
	parameters: {
		type: "object",
		properties: {
			code: {
				type: "string",
				description:
					"JavaScript body. Use `return X` to send back a value. Example: `return document.querySelectorAll('a').length`.",
			},
			world: {
				type: "string",
				enum: ["isolated", "main"],
				description:
					"Required execution context. Use 'main' for page JavaScript state and reverse engineering; use 'isolated' only for DOM-only operations.",
			},
			maxChars: {
				type: "number",
				description: "Truncate the serialized result to this many chars. Default 8000.",
			},
		},
		required: ["code", "world"],
		additionalProperties: false,
	},
	async execute(args, signal) {
		const code = String(args.code);
		const world = args.world === "main" ? "MAIN" : "ISOLATED";
		const maxChars = typeof args.maxChars === "number" ? Math.max(100, args.maxChars) : 8_000;

		const tab = await getActiveTab();

		const exec = chrome.scripting.executeScript({
			target: { tabId: tab.id as number },
			world: world as chrome.scripting.ExecutionWorld,
			func: pageRunner,
			args: [code],
		});

		const timeout = new Promise<never>((_, reject) => {
			const id = setTimeout(() => reject(new Error(`eval_js timed out after ${EVAL_TIMEOUT_MS / 1000}s`)), EVAL_TIMEOUT_MS);
			signal?.addEventListener("abort", () => {
				clearTimeout(id);
				reject(new Error("aborted"));
			});
		});

		const results = await Promise.race([exec, timeout]);
		const first = Array.isArray(results) ? results[0] : undefined;
		const outcome = (first as { result?: RunnerOutcome } | undefined)?.result;

		if (!outcome) {
			return {
				content: [{ type: "text", text: "eval_js: no result returned (script may have crashed silently)." }],
				isError: true,
			};
		}

		if (!outcome.ok) {
			return {
				content: [{ type: "text", text: `world: ${world.toLowerCase()}\nerror:\n${outcome.error}` }],
				isError: true,
			};
		}

		let value = outcome.value;
		const truncated = value.length > maxChars;
		if (truncated) value = `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} more chars]`;

		const header = `world: ${world.toLowerCase()} · type: ${outcome.kind}${truncated ? " · truncated" : ""}`;
		return {
			content: [{ type: "text", text: `${header}\n${value}` }],
		};
	},
};

async function pageRunner(code: string): Promise<RunnerOutcome> {
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
							const id = el.id ? `#${el.id}` : "";
							return `[Element <${el.tagName.toLowerCase()}${id}>]`;
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

	function classify(value: unknown): string {
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		const t = typeof value;
		if (t !== "object") return t;
		const proto = Object.getPrototypeOf(value as object);
		const name = proto?.constructor?.name;
		return name && name !== "Object" ? name : "object";
	}

	try {
		const fn = new Function(`return (async function() { ${code} })()`);
		const value = await fn();
		const kind = classify(value);
		const serialized = typeof value === "string" ? value : safeStringify(value);
		return { ok: true, kind, value: serialized };
	} catch (err) {
		const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
		return { ok: false, error: message };
	}
}
