const LOAD_TIMEOUT_MS = 30_000;
// Extra settle after `status: complete` so JS-rendered / SPA content finishes
// painting before we read the page. Applies to both navigate and fetch_url.
const SETTLE_MS = 5_000;

export function waitForTabComplete(tabId: number, signal?: AbortSignal, expectedUrl?: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const settleThenFinish = () => {
			if (settled) return;
			settleTimer = setTimeout(() => finish(), SETTLE_MS);
		};
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (settleTimer) clearTimeout(settleTimer);
			chrome.tabs.onUpdated.removeListener(onUpdated);
			chrome.tabs.onRemoved.removeListener(onRemoved);
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (err) reject(err); else resolve();
		};

		const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo, tab?: chrome.tabs.Tab) => {
			if (id !== tabId) return;
			// Wait for the tab to navigate to the expected URL
			if (expectedUrl) {
				if (!tab?.url || !tab.url.startsWith(expectedUrl)) return;
			}
			if (info.status === "complete") settleThenFinish();
		};
		const onRemoved = (id: number) => {
			if (id === tabId) finish(new Error("Tab was closed while waiting for load."));
		};
		const onAbort = () => finish(new Error("aborted"));

		chrome.tabs.onUpdated.addListener(onUpdated);
		chrome.tabs.onRemoved.addListener(onRemoved);
		signal?.addEventListener("abort", onAbort);

		const timer = setTimeout(
			() => finish(new Error(`waitForLoad timed out after ${LOAD_TIMEOUT_MS / 1000}s`)),
			LOAD_TIMEOUT_MS,
		);

		// Wait 1s before checking current status — gives navigation time to start
		setTimeout(() => {
			chrome.tabs.get(tabId).then((tab) => {
				if (tab.status === "complete") {
					if (expectedUrl && (!tab.url || !tab.url.startsWith(expectedUrl))) return;
					settleThenFinish();
				}
			}).catch(() => {});
		}, 1000);
	});
}
