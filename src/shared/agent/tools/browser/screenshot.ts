import { getActiveTab } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/config";
import type { ImageContent } from "@shared/ai/types";
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

interface ShrunkScreenshot {
	data: string;
	mediaType: "image/png" | "image/webp";
	bytes: number;
}

/**
 * Re-encode the capture as WebP with its long edge capped at 1024. Screenshots
 * are re-sent on every request, and one 147KB PNG cost 145k input tokens on an
 * endpoint that tokenises base64 as text. WebP at this size measured ~0.30x of
 * the PNG for a text-heavy UI. The original is kept whenever the result would
 * not be smaller, or when the browser could not produce WebP at all (canvas
 * falls back to PNG silently, so the blob type is checked rather than assumed).
 */
async function shrink(dataUrl: string): Promise<ShrunkScreenshot> {
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

function screenshotFormatLabel(mediaType: "image/png" | "image/webp"): string {
	return mediaType === "image/webp" ? `WebP (quality ${QUALITY}, long edge capped at ${MAX_EDGE})` : "PNG";
}

/**
 * The check a model that may not actually accept images has to run. Part of the
 * screenshot prompt, so the send-time "page + screenshot" context mode gets it
 * too: an attached screenshot is as invisible to a text-only model as a
 * captured one, and both cost the same input tokens.
 */
const SCREENSHOT_VISION_CHECK =
	`Before relying on it, confirm you can actually see the image by naming one visible detail (a button label, a field value). ` +
	`If you cannot see any image content, say so, do not take another screenshot, tell the user to turn off the \`screenshot\` capability for this model in Settings, and end the turn.`;

/**
 * Capture the target tab's visible viewport and shrink it.
 */
async function captureVisibleScreenshot(signal?: AbortSignal): Promise<{ image: ShrunkScreenshot; tab: chrome.tabs.Tab }> {
	if (signal?.aborted) throw new DOMException("Screenshot aborted.", "AbortError");

	const tab = await getActiveTab();
	if (tab.windowId === undefined) throw new Error("Active tab has no window ID.");
	if (!chrome.tabs.captureVisibleTab) throw new Error("Screenshot capture is not supported by this browser.");

	const dataUrl = await new Promise<string>((resolve, reject) => {
		chrome.tabs.captureVisibleTab(tab.windowId as number, { format: "png" }, (result) => {
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

	return { image: await shrink(dataUrl), tab };
}

export interface CapturedScreenshot {
	/** Text the model sees alongside the image. Produced here so every caller sends the same prompt. */
	prompt: string;
	image: ImageContent;
	mediaType: "image/png" | "image/webp";
	bytes: number;
	tab: chrome.tabs.Tab;
}

/**
 * The one screenshot capture: tab lookup, WebP shrink, and the prompt that goes
 * with the image. Used by the `screenshot` tool and by the send-time
 * "page + screenshot" context mode, so both pay the same bytes and get the same
 * can-you-actually-see-it instruction.
 */
export async function captureScreenshotContent(signal?: AbortSignal): Promise<CapturedScreenshot> {
	const { image, tab } = await captureVisibleScreenshot(signal);
	return {
		prompt:
			`Captured the active tab's visible viewport.\n` +
			`title: ${tab.title ?? "(untitled)"}\n` +
			`url: ${tab.url}\n` +
			`image: ${screenshotFormatLabel(image.mediaType)}, ${image.bytes} bytes\n` +
			`${SCREENSHOT_VISION_CHECK}\n` +
			`The image is available only during this agent run and is not retained.`,
		image: { type: "image", mediaType: image.mediaType, encoding: "base64", data: image.data },
		mediaType: image.mediaType,
		bytes: image.bytes,
		tab,
	};
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
		const shot = await captureScreenshotContent(signal);
		return { content: [{ type: "text", text: shot.prompt }, shot.image] };
	},
};
