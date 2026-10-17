// @ts-nocheck
/**
 * Smoke test for the "page + screenshot" context mode's message plumbing:
 * a user message may now carry an image block, and it must survive the AI SDK
 * conversion instead of being flattened to text (the bug that lost screenshots
 * in history). Also pins the one-shot guarantees the mode relies on, and the
 * image token estimate the compression trigger uses.
 *
 * Run: node scripts/page-share-smoke.mjs
 */
import { userContentToSdkParts } from "../src/shared/ai/sdk-content.ts";
import { estimateImageTokens } from "../src/shared/ai/image-tokens.ts";
import { pruneOldImages } from "../src/shared/ai/history.ts";
import { deriveTitle } from "../src/shared/sessions.ts";

let pass = 0;
let fail = 0;
const expect = (label, actual, want) => {
	const ok = JSON.stringify(actual) === JSON.stringify(want);
	if (ok) pass++;
	else {
		fail++;
		console.log(`FAIL ${label}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(want)}`);
	}
};

const IMAGE = { type: "image", mediaType: "image/webp", encoding: "base64", data: "AAAA" };

// 1. A plain string user turn still becomes a single text part.
expect("string user content", userContentToSdkParts("hello"), [{ type: "text", text: "hello" }]);

// 2. Text + image blocks: the image must stay a file part, not be dropped.
expect(
	"user content with image",
	userContentToSdkParts([
		{ type: "text", text: "what is on screen?" },
		{ type: "text", text: '[Current page text — "Inbox"]\n\nMail list' },
		IMAGE,
	]),
	[
		{ type: "text", text: "what is on screen?" },
		{ type: "text", text: '[Current page text — "Inbox"]\n\nMail list' },
		{ type: "file", mediaType: "image/webp", data: { type: "data", data: "AAAA" } },
	],
);

// 3. Empty string user content stays an empty content array (unchanged behaviour).
expect("empty user content", userContentToSdkParts(""), []);

// 4. pruneOldImages only rewrites tool results, so the send-time image in a user
// turn is never replaced by the "omitted" note.
const sharedUserMessage = { role: "user", content: [{ type: "text", text: "look" }, IMAGE] };
const pruned = pruneOldImages([sharedUserMessage]);
expect("prune keeps user image", pruned[0].content.some((c) => c.type === "image"), true);

// 5. An image-only user turn contributes no title text.
expect("image-only turn yields no title", deriveTitle([{ role: "user", content: [IMAGE] }]), "New session");

// 6. The token estimate follows the base64 payload: 9600 base64 chars decode to
// 7200 bytes, and this endpoint bills roughly one token per byte.
const sized = (base64Chars) => ({ type: "image", mediaType: "image/webp", encoding: "base64", data: "A".repeat(base64Chars) });
expect("estimate tracks payload size", estimateImageTokens(sized(9600)), 7200);
expect("estimate ignores media type", estimateImageTokens(sized(4000)), 3000);

// 7. The measured cost of a 147,399-byte PNG (196,532 base64 chars) was 145,394
// input tokens. The old flat IMAGE_TOKENS = 1000 was off by ~145x and let the
// compression trigger fire far too late.
const pngEstimate = estimateImageTokens(sized(196532));
expect("large screenshot is not counted as 1000", pngEstimate > 130_000 && pngEstimate < 160_000, true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
