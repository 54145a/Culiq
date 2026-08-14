const LOAD_TIMEOUT_MS = 30_000;

export function waitForTabComplete(tabId: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			chrome.tabs.onUpdated.removeListener(onUpdated);
			chrome.tabs.onRemoved.removeListener(onRemoved);
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve();
		};

		const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
			if (id === tabId && info.status === "complete") finish();
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

		chrome.tabs.get(tabId).then((tab) => {
			if (tab.status === "complete") finish();
		});
	});
}
