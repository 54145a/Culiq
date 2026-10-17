import {
	type ContentEnvelope,
	type ContentResponse,
	isContentEnvelope,
} from "@shared/transport/content-rpc";
import { CONSOLE_MAGIC, isConsoleWindowMessage, type ConsoleRuntimeMessage } from "@shared/transport/console-rpc";
import { dispatch } from "./dom-driver";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (r: ContentResponse) => void) => {
	if (!isContentEnvelope(message)) return false;
	const envelope = message as ContentEnvelope;
	void (async () => {
		try {
			const result = await dispatch(envelope.request);
			sendResponse({ ok: true, method: envelope.request.method, result });
		} catch (err) {
			sendResponse({
				ok: false,
				method: envelope.request.method,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	})();
	return true;
});

// Relay MAIN-world console entries (posted by console-shim.ts) to the service
// worker. The shim posts with `event.source === window`; anything else on the
// page's message bus is ignored.
window.addEventListener("message", (event) => {
	if (event.source !== window) return;
	if (!isConsoleWindowMessage(event.data)) return;
	if ((event.data as { pong?: unknown }).pong === true) return;
	const msg: ConsoleRuntimeMessage = { type: "console_entry", entry: event.data.entry };
	void chrome.runtime.sendMessage(msg).catch(() => {});
});

// Probe for the shim — it answers with a pong, which the listener above skips.
window.postMessage({ magic: CONSOLE_MAGIC, ping: "culiq" }, "*");
