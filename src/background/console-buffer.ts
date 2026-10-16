import {
	CONSOLE_BUFFER_LIMIT,
	type ConsoleEntry,
	type ConsoleRuntimeMessage,
} from "@shared/transport/console-rpc";

/** Per-tab console ring buffer, persisted in chrome.storage.session so it
 *  survives MV3 service-worker restarts but dies with the browser. */
const STORE_KEY = "culiq.console.buffer.v1";
/** session.storage quota is 10MB; 500 entries * ~2KB text ≈ 1MB per busy tab. */
const TAB_LIMIT = 20;

type Buffer = Record<string, ConsoleEntry[]>;

let cache: Buffer | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

async function readStore(): Promise<Buffer> {
	if (cache) return cache;
	const raw = await chrome.storage.session.get(STORE_KEY);
	cache = (raw[STORE_KEY] as Buffer | undefined) ?? {};
	return cache;
}

let flushQueued = false;
function scheduleFlush(): void {
	if (flushQueued) return;
	flushQueued = true;
	// Coalesce bursts (a chatty page can emit hundreds of entries per second).
	flushTimer = setTimeout(() => {
		flushQueued = false;
		if (cache) void chrome.storage.session.set({ [STORE_KEY]: cache }).catch(() => {});
	}, 500);
}

function trimTabs(buffer: Buffer): void {
	const ids = Object.keys(buffer);
	if (ids.length <= TAB_LIMIT) return;
	// Drop the tabs whose newest entry is the oldest — least recently active.
	ids.sort((a, b) => (buffer[b].at(-1)?.t ?? 0) - (buffer[a].at(-1)?.t ?? 0));
	for (const id of ids.slice(TAB_LIMIT)) delete buffer[id];
}

export async function recordConsoleMessage(msg: ConsoleRuntimeMessage, tabId: number): Promise<void> {
	const buffer = await readStore();
	const entries = buffer[tabId] ?? (buffer[tabId] = []);
	entries.push(msg.entry);
	if (entries.length > CONSOLE_BUFFER_LIMIT) entries.splice(0, entries.length - CONSOLE_BUFFER_LIMIT);
	trimTabs(buffer);
	scheduleFlush();
}

export interface ConsoleSlice {
	entries: ConsoleEntry[];
	/** False when no shim was ever seen on this tab — capture may be inactive. */
	shimSeen: boolean;
}

export async function readConsoleBuffer(tabId: number): Promise<ConsoleSlice> {
	const buffer = await readStore();
	return { entries: buffer[tabId] ?? [], shimSeen: tabId in buffer };
}

export function clearConsoleBuffer(tabId: number): void {
	if (!cache) return;
	// Keep the key: it doubles as the "shim has been seen on this tab" marker.
	cache[tabId] = [];
	scheduleFlush();
}

/** Flush pending writes before the service worker stops. */
export function flushConsoleBuffer(): void {
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = undefined;
	flushQueued = false;
	if (cache) void chrome.storage.session.set({ [STORE_KEY]: cache }).catch(() => {});
}
