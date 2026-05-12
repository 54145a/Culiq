import {
	CONTENT_ENVELOPE_MAGIC,
	type ContentRequest,
	type ContentResponse,
	type ContentResultMap,
} from "@shared/transport/content-rpc";

const RPC_TIMEOUT_MS = 15_000;

export async function getActiveTab(): Promise<chrome.tabs.Tab> {
	const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	if (!tab || tab.id === undefined) throw new Error("No active tab found.");
	if (!tab.url) throw new Error("Active tab has no URL (still loading?).");
	if (/^(chrome|chrome-extension|edge|about|devtools):/i.test(tab.url)) {
		throw new Error(`Cannot operate on protected URL: ${tab.url}`);
	}
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

	const response = await Promise.race([sendPromise, timeout]);
	if (!response.ok) throw new Error(response.error);
	return response.result as ContentResultMap[R["method"]];
}
