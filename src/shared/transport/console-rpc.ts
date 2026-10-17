/** Wire protocol between the MAIN-world console shim, the isolated content
 *  script (window.postMessage hop) and the service worker (runtime message).
 *  Console capture is a push stream, not request/response — so it does not go
 *  through the ContentRequest envelope used by click/type/read_dom. */

export const CONSOLE_MAGIC = "culiq.console.v1";

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error" | "trace";

export interface ConsoleEntry {
	/** Epoch ms, taken in the page (main world) at call time. */
	t: number;
	level: ConsoleLevel;
	/** Serialized arguments joined with a space. */
	text: string;
	/** `uncaught` / `unhandled-rejection` when the entry came from an error event. */
	source?: "uncaught" | "unhandled-rejection";
}

/** Message the shim posts onto the page window for the content script. */
export interface ConsoleWindowMessage {
	magic: typeof CONSOLE_MAGIC;
	entry: ConsoleEntry;
}

/** Message the content script forwards to the service worker. */
export interface ConsoleRuntimeMessage {
	type: "console_entry";
	tabId?: number;
	frame?: number;
	entry: ConsoleEntry;
}

export function isConsoleWindowMessage(value: unknown): value is ConsoleWindowMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { magic?: unknown }).magic === CONSOLE_MAGIC
	);
}

/** Ring-buffer bounds kept in the service worker (per tab). */
export const CONSOLE_BUFFER_LIMIT = 500;
/** Per-entry text cap applied in the page before posting. */
export const CONSOLE_TEXT_LIMIT = 2_000;
