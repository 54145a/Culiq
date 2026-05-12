import {
	type ContentEnvelope,
	type ContentResponse,
	isContentEnvelope,
} from "@shared/transport/content-rpc";
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
