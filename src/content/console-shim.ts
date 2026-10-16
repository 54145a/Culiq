// Runs in the page's MAIN world at document_start — no chrome.* APIs here.
// Wraps console methods in place (calls still reach the page's original
// console, so page behavior is preserved) and forwards serialized entries to
// the isolated content script via window.postMessage. Idempotent: re-injection
// on the same page never double-wraps.
import {
	CONSOLE_TEXT_LIMIT,
	CONSOLE_MAGIC,
	type ConsoleEntry,
	type ConsoleLevel,
} from "@shared/transport/console-rpc";

interface ShimWindow extends Window {
	__culiqConsoleShim?: boolean;
}

const win = window as ShimWindow;
if (win.__culiqConsoleShim) {
	// Already installed by an earlier injection — nothing to do.
} else {
	win.__culiqConsoleShim = true;

	const serialize = (value: unknown, depth: number): string => {
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		const type = typeof value;
		if (type === "string") {
			const text = value as string;
			return text.length > CONSOLE_TEXT_LIMIT ? `${text.slice(0, CONSOLE_TEXT_LIMIT)}…` : text;
		}
		if (type === "number" || type === "boolean" || type === "bigint") return String(value);
		if (type === "function") return `[function ${"name" in (value as object) ? String((value as { name?: unknown }).name ?? "anonymous") : "anonymous"}]`;
		if (type === "symbol") return String(value);
		if (value instanceof Error) {
			const stack = typeof value.stack === "string" ? value.stack : "";
			const head = stack.split("\n").slice(0, 4).join("\n");
			return head.length > CONSOLE_TEXT_LIMIT ? `${head.slice(0, CONSOLE_TEXT_LIMIT)}…` : head || `${value.name}: ${value.message}`;
		}
		if (depth <= 0) return Array.isArray(value) ? "[array]" : "[object]";
		try {
			const seen = new Set<unknown>();
			const json = JSON.stringify(value, (_key, v: unknown) => {
				if (typeof v === "object" && v !== null) {
					if (seen.has(v)) return "[circular]";
					seen.add(v);
				}
				if (typeof v === "bigint") return String(v);
				if (typeof v === "function") return "[function]";
				return v;
			});
			if (json === undefined) return String(value);
			return json.length > CONSOLE_TEXT_LIMIT ? `${json.slice(0, CONSOLE_TEXT_LIMIT)}…` : json;
		} catch {
			return "[unserializable]";
		}
	};

	const format = (args: unknown[]): string =>
		args.map((a) => serialize(a, 2)).join(" ").slice(0, CONSOLE_TEXT_LIMIT);

	const post = (entry: ConsoleEntry) => {
		try {
			window.postMessage({ magic: CONSOLE_MAGIC, entry }, "*");
		} catch {
			// Structured clone can reject on exotic arguments — dropping one
			// entry is better than breaking the page's console call.
		}
	};

	const emit = (level: ConsoleLevel, args: unknown[]): void => {
		const text = format(args);
		// Methods that print nothing on this call (groupEnd, countReset(),
		// time() start) would format as empty text — not worth a buffer slot.
		if (text.length === 0) return;
		post({ t: Date.now(), level, text });
	};

	// Level classification only — any console method not listed here is
	// recorded as "log", so future or nonstandard methods need no changes.
	const LEVELS: Partial<Record<string, ConsoleLevel>> = {
		debug: "debug",
		info: "info",
		warn: "warn",
		error: "error",
		trace: "trace",
	};

	// Enumerate instead of hardcoding method names: every function property of
	// the console object gets wrapped, whatever this browser provides.
	const methods = Object.getOwnPropertyNames(console).filter((name) => {
		if (name === "Console") return false;
		return typeof (console as unknown as Record<string, unknown>)[name] === "function";
	});

	for (const name of methods) {
		const original = (console as unknown as Record<string, (...args: unknown[]) => unknown>)[name].bind(console);
		const wrapped = (...args: unknown[]) => {
			const method = name as keyof typeof LEVELS;
			if (name === "assert") {
				// console.assert only prints on a failing condition — record
				// it the same way instead of on every call.
				if (!args[0]) emit("error", args.slice(1).length > 0 ? ["Assertion failed:", ...args.slice(1)] : ["Assertion failed:"]);
			} else {
				emit(LEVELS[method] ?? "log", args);
			}
			original(...args);
		};
		Object.defineProperty(console, name, {
			value: wrapped,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	window.addEventListener("error", (event) => {
		const error = event.error instanceof Error ? event.error : new Error(event.message);
		post({ t: Date.now(), level: "error", text: format([error]), source: "uncaught" });
	});

	window.addEventListener("unhandledrejection", (event) => {
		const reason = (event as PromiseRejectionEvent).reason;
		post({ t: Date.now(), level: "error", text: format(["Unhandled rejection:", reason]), source: "unhandled-rejection" });
	});

	// The content script acknowledges the shim so it can tell "shim active"
	// from "shim missing" when the agent asks for console output.
	window.addEventListener("message", (event) => {
		if (event.source !== window) return;
		const data = event.data as { magic?: string; ping?: string } | null;
		if (data?.magic === CONSOLE_MAGIC && data.ping === "culiq") {
			window.postMessage({ magic: CONSOLE_MAGIC, pong: true }, "*");
		}
	});
}
