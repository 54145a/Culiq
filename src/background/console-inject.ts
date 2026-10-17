const SHIM_FILE = "console-shim.js";
const SHIM_ID = "culiq-console-shim";

interface RegisteredScript {
	id?: string;
	persistAcrossSessions?: boolean;
}

/** Register with persistence where supported. Firefox rejects
 *  persistAcrossSessions: true, so it falls back to a per-session
 *  registration — the SW re-runs this on every cold start anyway. */
async function registerScripts(): Promise<void> {
	const base = {
		id: SHIM_ID,
		matches: ["http://*/*", "https://*/*"],
		js: [SHIM_FILE],
		runAt: "document_start" as const,
		world: "MAIN" as chrome.scripting.ExecutionWorld,
	};
	try {
		await chrome.scripting.registerContentScripts([{ ...base, persistAcrossSessions: true }]);
	} catch (err) {
		// Already registered (SW restart on Chrome) or the browser rejected
		// persistence (Firefox) — retry without it after clearing state.
		const existing = (await chrome.scripting.getRegisteredContentScripts()) as RegisteredScript[];
		if (existing.some((s) => s.id === SHIM_ID)) return;
		await chrome.scripting.unregisterContentScripts({ ids: [SHIM_ID] }).catch(() => {});
		await chrome.scripting.registerContentScripts([{ ...base, persistAcrossSessions: false }]);
		void err;
	}
}

let registered = false;

/** Register the document_start MAIN-world shim. Safe to call on every SW start. */
export async function registerConsoleShim(): Promise<void> {
	if (registered) return;
	await registerScripts();
	registered = true;
}

/** Inject the shim into one tab right now — covers tabs that were already
 *  open before the extension loaded, and any registration gap. Idempotent on
 *  the page side (the shim exits early when its marker is present). */
export async function ensureConsoleShim(tabId: number): Promise<void> {
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			world: "MAIN",
			files: [SHIM_FILE],
		});
	} catch (err) {
		// Protected pages (chrome://, web store) and discarded tabs refuse
		// injection — console capture is simply unavailable there.
		console.warn(`[culiq] console shim injection failed on tab ${tabId}:`, err instanceof Error ? err.message : err);
	}
}
