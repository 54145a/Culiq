import {
	CONTENT_ENVELOPE_MAGIC,
	type ContentRequest,
	type ContentResponse,
	type ContentResultMap,
} from "@shared/transport/content-rpc";

const RPC_TIMEOUT_MS = 15_000;
const PROTECTED_URL = /^(chrome|chrome-extension|edge|about|devtools):/i;

export function isProtectedUrl(url: string): boolean {
	return PROTECTED_URL.test(url);
}

let panelWindowId: number | undefined;

/** The window that hosts the active panel; the target tab lives next to it. */
export function setPanelWindow(windowId: number | undefined): void {
	panelWindowId = windowId;
}

/** The active tab of the panel's own window (the tab next to the side panel). */
export async function getPanelWindowTab(): Promise<chrome.tabs.Tab | undefined> {
	if (panelWindowId === undefined) return undefined;
	const [tab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
	if (!tab) return undefined;
	// In popup mode, the panel window only contains the extension page.
	// Return undefined so the fallback in findTargetTab kicks in.
	if (tab.url?.startsWith("chrome-extension://")) return undefined;
	return tab;
}

/**
 * The tab the tools operate on: the tab next to the side panel — the active
 * tab of the panel's own window — NOT the focused window, since the user may
 * have switched windows or be in a PWA. Falls back to any non-protected active
 * tab in a normal window. Never throws; getActiveTab() adds the guards.
 */
export async function findTargetTab(): Promise<chrome.tabs.Tab | undefined> {
	const panelTab = await getPanelWindowTab();
	if (panelTab?.url && !PROTECTED_URL.test(panelTab.url)) return panelTab;

	const windows = await chrome.windows.getAll();
	const byWindow = new Map<number | undefined, chrome.windows.Window>();
	for (const w of windows) byWindow.set(w.id, w);
	const activeTabs = await chrome.tabs.query({ active: true });
	const candidates = activeTabs.filter((t) => byWindow.get(t.windowId)?.type === "normal");
	candidates.sort((a, b) => Number(byWindow.get(b.windowId)?.focused) - Number(byWindow.get(a.windowId)?.focused));
	return candidates.find((t) => t.url && !PROTECTED_URL.test(t.url)) ?? candidates[0];
}

export async function getActiveTab(): Promise<chrome.tabs.Tab> {
	const tab = await findTargetTab();
	if (!tab || tab.id === undefined) throw new Error("No active tab found.");
	if (!tab.url) throw new Error("Active tab has no URL (still loading?).");
	if (PROTECTED_URL.test(tab.url)) throw new Error(`Cannot operate on protected URL: ${tab.url}`);
	return tab;
}

export async function callContent<R extends ContentRequest>(
	request: R,
): Promise<ContentResultMap[R["method"]]> {
	const tab = await getActiveTab();
	const envelope = { magic: CONTENT_ENVELOPE_MAGIC, request };

	const sendPromise = new Promise<ContentResponse>((resolve, reject) => {
		try {
			chrome.tabs.sendMessage(tab.id as number, envelope, (response: ContentResponse | undefined) => {
				const lastErr = chrome.runtime.lastError;
				if (lastErr) {
					reject(new Error(lastErr.message ?? "chrome.runtime.lastError (unknown)"));
					return;
				}
				if (!response) {
					reject(new Error("Empty response from content script."));
					return;
				}
				resolve(response);
			});
		} catch (err) {
			reject(err);
		}
	});

	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`Content script did not respond within ${RPC_TIMEOUT_MS / 1000}s`)), RPC_TIMEOUT_MS),
	);

	try {
		const response = await Promise.race([sendPromise, timeout]);
		if (!response.ok) throw new Error(response.error);
		return response.result as ContentResultMap[R["method"]];
	} catch (err) {
		// If "Receiving end does not exist", inject content script and retry once
		if (err instanceof Error && /receiving end does not exist/i.test(err.message)) {
			const manifest = chrome.runtime.getManifest();
			const csEntry = manifest.content_scripts?.[0];
			if (csEntry?.js?.[0]) {
				await chrome.scripting.executeScript({
					target: { tabId: tab.id as number },
					files: [csEntry.js[0]],
				});
				await new Promise((r) => setTimeout(r, 100));
			}
			const retry = await Promise.race([
				new Promise<ContentResponse>((resolve, reject) => {
					chrome.tabs.sendMessage(tab.id as number, envelope, (response) => {
						const lastErr = chrome.runtime.lastError;
						if (lastErr) { reject(new Error(lastErr.message)); return; }
						if (!response) { reject(new Error("Empty response from content script.")); return; }
						resolve(response);
					});
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Content script did not respond after injection")), RPC_TIMEOUT_MS),
				),
			]);
			if (!retry.ok) throw new Error(retry.error);
			return retry.result as ContentResultMap[R["method"]];
		}
		throw err;
	}
}
