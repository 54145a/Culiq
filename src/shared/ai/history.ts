import type { Message } from "./types";

/**
 * Note left where a dropped screenshot used to be, so the model knows the image
 * existed and can take a fresh one instead of silently losing context.
 */
export const OMITTED_IMAGE_NOTE = "[screenshot from an earlier turn omitted to save context — take a new screenshot if you need to look again]";

/**
 * Keep only the most recent image in a history. Screenshots are large and every
 * request re-sends them; an endpoint that tokenises base64 as text charged
 * ~145k input tokens per request for one 147KB PNG in a real session, and 94%
 * of that session's input tokens were spent after a single screenshot.
 */
export function pruneOldImages(messages: Message[], note: string = OMITTED_IMAGE_NOTE): Message[] {
	const out = [...messages];
	let kept = false;
	for (let i = out.length - 1; i >= 0; i--) {
		const message = out[i];
		if (message.role !== "toolResult") continue;
		if (!message.content.some((block) => block.type === "image")) continue;
		if (!kept) {
			kept = true;
			continue;
		}
		out[i] = {
			...message,
			content: message.content.map((block) => (block.type === "image" ? { type: "text" as const, text: note } : block)),
		};
	}
	return out;
}
