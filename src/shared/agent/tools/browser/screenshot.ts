import { getActiveTab } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "../../types";

const PNG_PREFIX = "data:image/png;base64,";
const MAX_EDGE = 1024;
const QUALITY = 0.6;

function base64Bytes(data: string): number {
	return Math.floor((data.length * 3) / 4);
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return btoa(binary);
}

/**
 * Re-encode the capture as WebP with its long edge capped at 1024. Screenshots
 * are re-sent on every request, and one 147KB PNG cost 145k input tokens on an
 * endpoint that tokenises base64 as text. WebP at this size measured ~0.30x of
 * the PNG for a text-heavy UI. The original is kept whenever the result would
 * not be smaller, or when the browser could not produce WebP at all (canvas
 * falls back to PNG silently, so the blob type is checked rather than assumed).
 */
async function shrink(dataUrl: string): Promise<{ data: string; mediaType: "image/png" | "image/webp"; bytes: number }> {
	const original = { data: dataUrl.slice(PNG_PREFIX.length), mediaType: "image/png" as const, bytes: 0 };
	original.bytes = base64Bytes(original.data);
	try {
		const blob = await (await fetch(dataUrl)).blob();
		const bitmap = await createImageBitmap(blob);
		const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) return original;
		ctx.drawImage(bitmap, 0, 0, width, height);
		bitmap.close();
		const out = await canvas.convertToBlob({ type: "image/webp", quality: QUALITY });
		if (out.type !== "image/webp") return original;
		const bytes = new Uint8Array(await out.arrayBuffer());
		if (bytes.length >= original.bytes) return original;
		return { data: toBase64(bytes), mediaType: "image/webp", bytes: bytes.length };
	} catch {
		return original;
	}
}

export const screenshotTool: AgentTool = {
	name: "screenshot",
	description: CAPABILITY_INFO.screenshot.description,
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

		const image = await shrink(dataUrl);
		const format = image.mediaType === "image/webp" ? `WebP (quality ${QUALITY}, long edge capped at ${MAX_EDGE})` : "PNG";
		return {
			content: [
				{
					type: "text",
					text:
						`Captured the active tab's visible viewport.\n` +
						`title: ${tab.title ?? "(untitled)"}\n` +
						`url: ${tab.url}\n` +
						`image: ${format}, ${image.bytes} bytes\n` +
						`Before relying on it, confirm you can actually see the image by naming one visible detail (a button label, a field value). ` +
						`If you cannot see any image content, say so, do not take another screenshot, tell the user to turn off the \`screenshot\` capability for this model in Settings, and end the turn.\n` +
						`The image is available only during this agent run and is not retained.`,
				},
				{ type: "image", mediaType: image.mediaType, encoding: "base64", data: image.data },
			],
		};
	},
};
