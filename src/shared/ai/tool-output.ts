import type { ToolResultContent } from "./types";

/** The shape the panel uses for tool output that carries images (screenshots). */
interface ToolOutputWithImages {
	text?: unknown;
	images?: Array<{ mediaType: string; data: string }>;
}

function imagesOf(output: unknown): Array<{ mediaType: string; data: string }> | undefined {
	const shaped = output as ToolOutputWithImages | null;
	if (!shaped || typeof shaped !== "object" || !Array.isArray(shaped.images)) return undefined;
	return shaped.images;
}

/**
 * Text of a tool output without ever stringifying image data: a screenshot's
 * base64 must not end up in a card body or in a prompt.
 */
export function toolOutputText(output: unknown): string {
	if (output == null) return "";
	if (typeof output === "string") return output;
	const images = imagesOf(output);
	if (images) {
		const text = (output as ToolOutputWithImages).text;
		return typeof text === "string" ? text : "";
	}
	return JSON.stringify(output);
}

/**
 * Tool output as model/agent content blocks. Images are preserved as image
 * blocks so a follow-up turn keeps the screenshot as multimodal content.
 */
export function toolOutputToContent(output: unknown): ToolResultContent[] {
	if (typeof output === "string") return [{ type: "text", text: output }];
	const images = imagesOf(output);
	if (images) {
		const content: ToolResultContent[] = [];
		const text = (output as ToolOutputWithImages).text;
		if (typeof text === "string" && text) content.push({ type: "text", text });
		for (const img of images) content.push({ type: "image", mediaType: "image/png", encoding: "base64", data: img.data });
		if (content.length > 0) return content;
	}
	return [{ type: "text", text: JSON.stringify(output) }];
}
