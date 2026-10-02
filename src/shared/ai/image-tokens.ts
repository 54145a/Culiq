import type { ImageContent } from "./types";

/**
 * tokenx only counts text, and an image block's base64 payload is what actually
 * fills the window: on the text-tokenising endpoint this project uses, a
 * 147,399-byte PNG was billed as 145,394 input tokens (base64 comes out at
 * ~1.35 chars/token, i.e. ≈1 token per byte). The estimate is therefore the
 * decoded byte count.
 *
 * A vision-aware endpoint bills by pixels instead, so an image is over-counted
 * there; the only consequence is compressing earlier than strictly needed,
 * which beats blowing the window because an image looked like 1000 tokens.
 */
export function estimateImageTokens(image: ImageContent): number {
	return Math.ceil((image.data.length * 3) / 4);
}
