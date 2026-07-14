import { getActiveTab } from "@shared/transport/tab-rpc";
import type { AgentTool } from "../../types";

const PNG_PREFIX = "data:image/png;base64,";

export const screenshotTool: AgentTool = {
	name: "screenshot",
	description:
		"Capture the active tab's currently visible viewport as a PNG for visual analysis. Use it for images, canvas, charts, layout, colors, or visual state that DOM tools cannot reliably describe. This does not capture the full page.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
	executionMode: "sequential",
	async execute(_args, signal) {
		if (signal?.aborted) throw new DOMException("Screenshot aborted.", "AbortError");

		const tab = await getActiveTab();
		if (tab.windowId === undefined) throw new Error("Active tab has no window ID.");
		if (!chrome.tabs.captureVisibleTab) throw new Error("Screenshot capture is not supported by this browser.");

		const dataUrl = await new Promise<string>((resolve, reject) => {
			chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (result) => {
				const lastError = chrome.runtime.lastError;
				if (lastError) {
					reject(new Error(lastError.message ?? "Screenshot capture failed."));
					return;
				}
				if (!result) {
					reject(new Error("Screenshot capture returned an empty result."));
					return;
				}
				resolve(result);
			});
		});

		if (signal?.aborted) throw new DOMException("Screenshot aborted.", "AbortError");
		if (!dataUrl.startsWith(PNG_PREFIX)) throw new Error("Screenshot capture returned an unexpected image format.");

		const data = dataUrl.slice(PNG_PREFIX.length);
		const bytes = Math.floor((data.length * 3) / 4);
		return {
			content: [
				{
					type: "text",
					text: `Captured the active tab's visible viewport.\ntitle: ${tab.title ?? "(untitled)"}\nurl: ${tab.url}\nPNG size: ${bytes} bytes\nThe image is available only during this agent run and is not retained.`,
				},
				{ type: "image", mediaType: "image/png", encoding: "base64", data },
			],
		};
	},
};
