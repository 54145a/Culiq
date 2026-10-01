import type { ImageContent, TextContent, ToolResultContent, UserMessage } from "./types";

function imagePart(block: ImageContent): Record<string, unknown> {
	return { type: "file", mediaType: block.mediaType, data: { type: "data", data: block.data } };
}

/** Tool result blocks as AI SDK content parts: images stay file parts. */
export function toSdkContent(blocks: ToolResultContent[]): Array<Record<string, unknown>> {
	return blocks.map((block) => (block.type === "text" ? { type: "text", text: block.text } : imagePart(block)));
}

/**
 * A user turn as AI SDK content parts. Normally plain text; the "page +
 * screenshot" context mode attaches an image here, and flattening that to text
 * is exactly how screenshots used to be lost on the way to the model.
 */
export function userContentToSdkParts(content: UserMessage["content"]): Array<Record<string, unknown>> {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return content.map((block: TextContent | ImageContent) =>
		block.type === "text" ? { type: "text", text: block.text } : imagePart(block),
	);
}
