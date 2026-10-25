import type { Message } from "./types";

/**
 * Note left where a dropped screenshot used to be, so the model knows the image
 * existed and can take a fresh one instead of silently losing context.
 */
export const OMITTED_IMAGE_NOTE = "[screenshot from an earlier turn omitted to save context — take a new screenshot if you need to look again]";

/**
 * How many screenshots stay in the history. A few are worth keeping (comparing
 * a before and after state is a real workflow), but they are re-sent on every
 * request: one 147KB PNG cost 145k input tokens per request on an endpoint that
 * tokenises base64 as text, and 94% of that session's input tokens were spent
 * after a single screenshot.
 */
export const KEPT_IMAGES = 3;

/** Keep the newest `keep` images, replace older ones with {@link OMITTED_IMAGE_NOTE}. */
export function pruneOldImages(messages: Message[], keep: number = KEPT_IMAGES): Message[] {
	const out = [...messages];
	let kept = 0;
	for (let i = out.length - 1; i >= 0; i--) {
		const message = out[i];
		if (message.role !== "toolResult") continue;
		if (!message.content.some((block) => block.type === "image")) continue;
		if (kept < keep) {
			kept++;
			continue;
		}
		out[i] = {
			...message,
			content: message.content.map((block) => (block.type === "image" ? { type: "text" as const, text: OMITTED_IMAGE_NOTE } : block)),
		};
	}
	return out;
}
