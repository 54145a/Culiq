// @ts-nocheck
/**
 * Repro: drive the REAL @ai-sdk/react Chat class with a mock transport that
 * emits the exact UIMessageChunk sequence Culiq's ExtensionChatTransport
 * produces, then inspect chat.messages for duplicated tool parts.
 *
 * Run: node scripts/ui-stream-repro.mjs
 */
import { Chat } from "@ai-sdk/react";

function makeTransport(chunks) {
	return {
		sendMessages: async () =>
			new ReadableStream({
				start(controller) {
					for (const c of chunks) controller.enqueue(c);
					controller.close();
				},
			}),
		reconnectToStream: async () => null,
	};
}

async function run(label, chunks) {
	const chat = new Chat({ id: "t", transport: makeTransport(chunks) });
	await chat.sendMessage({ text: "go" });
	// sendMessage resolves after the stream is consumed; give the job executor a tick.
	await new Promise((r) => setTimeout(r, 50));

	console.log(`\n=== ${label}: ${chat.messages.length} message(s) ===`);
	for (const m of chat.messages) {
		console.log(`message ${m.id} [${m.role}]`);
		for (const p of m.parts) {
			console.log(`  - ${p.type}${p.toolCallId ? ` id=${p.toolCallId}` : ""} state=${p.state ?? ""}`);
		}
	}
	const toolParts = chat.messages.flatMap((m) => m.parts).filter((p) => p.type.startsWith("tool-"));
	const ids = toolParts.map((p) => p.toolCallId);
	const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
	console.log(dupes.length ? `!!! DUPLICATED toolCallIds: ${[...new Set(dupes)].join(", ")}` : "no duplicated toolCallIds");
}

// 1: native tool — agent_start→start, turn_start→start-step, message_start→start(!), text, tool lifecycle.
await run("native tool, double start", [
	{ type: "start" },
	{ type: "start-step" },
	{ type: "start", messageId: "m1" },
	{ type: "text-start", id: "0" },
	{ type: "text-delta", id: "0", delta: "let me check" },
	{ type: "tool-input-start", toolCallId: "loop-1", toolName: "search" },
	{ type: "tool-input-delta", toolCallId: "loop-1", inputTextDelta: '{"query":"x"}' },
	{ type: "tool-input-available", toolCallId: "loop-1", toolName: "search", input: { query: "x" } },
	{ type: "tool-output-available", toolCallId: "loop-1", output: "results…" },
	{ type: "finish-step" },
	{ type: "finish", finishReason: "stop" },
]);

// 2: sandbox_exec with a bridge hint card inside.
await run("sandbox_exec + bridge hint", [
	{ type: "start" },
	{ type: "start-step" },
	{ type: "start", messageId: "m1" },
	{ type: "tool-input-start", toolCallId: "loop-1", toolName: "sandbox_exec" },
	{ type: "tool-input-available", toolCallId: "loop-1", toolName: "sandbox_exec", input: { code: "…" } },
	{ type: "tool-input-start", toolCallId: "sb-1", toolName: "sandbox.search" },
	{ type: "tool-input-available", toolCallId: "sb-1", toolName: "sandbox.search", input: ["q"] },
	{ type: "tool-output-available", toolCallId: "sb-1", output: "hint results" },
	{ type: "tool-output-available", toolCallId: "loop-1", output: "full results" },
	{ type: "finish-step" },
	{ type: "finish", finishReason: "stop" },
]);

// 3: multi-turn — second step opens before prior tool output arrives.
await run("multi-turn, late output", [
	{ type: "start" },
	{ type: "start-step" },
	{ type: "start", messageId: "m1" },
	{ type: "tool-input-start", toolCallId: "loop-1", toolName: "search" },
	{ type: "tool-input-available", toolCallId: "loop-1", toolName: "search", input: { query: "x" } },
	{ type: "finish-step" },
	{ type: "start-step" },
	{ type: "start", messageId: "m2" },
	{ type: "text-start", id: "0" },
	{ type: "text-delta", id: "0", delta: "answer" },
	{ type: "tool-output-available", toolCallId: "loop-1", output: "late results" },
	{ type: "finish-step" },
	{ type: "finish", finishReason: "stop" },
]);

// 4: REAL agent-loop shape — includes the toolResult-triggered
//    message_start → {type:"start", messageId:""} after tool completion.
await run("real shape: toolResult start('')", [
	{ type: "start" },
	{ type: "start-step" },
	{ type: "start", messageId: "a1" },
	{ type: "text-start", id: "0" },
	{ type: "text-delta", id: "0", delta: "checking" },
	{ type: "tool-input-start", toolCallId: "loop-1", toolName: "search" },
	{ type: "tool-input-delta", toolCallId: "loop-1", inputTextDelta: '{"query":"x"}' },
	{ type: "tool-input-available", toolCallId: "loop-1", toolName: "search", input: { query: "x" } },
	{ type: "tool-output-available", toolCallId: "loop-1", output: "results" },
	{ type: "start", messageId: "" },
	{ type: "finish-step" },
	{ type: "start-step" },
	{ type: "start", messageId: "a2" },
	{ type: "text-start", id: "0" },
	{ type: "text-delta", id: "0", delta: "answer" },
	{ type: "finish-step" },
	{ type: "finish", finishReason: "stop" },
]);

// 5: FIXED mapping — single start from agent_start; turns are steps only.
await run("fixed mapping", [
	{ type: "start" },
	{ type: "start-step" },
	{ type: "text-start", id: "0" },
	{ type: "text-delta", id: "0", delta: "checking" },
	{ type: "tool-input-start", toolCallId: "loop-1", toolName: "search" },
	{ type: "tool-input-delta", toolCallId: "loop-1", inputTextDelta: '{"query":"x"}' },
	{ type: "tool-input-available", toolCallId: "loop-1", toolName: "search", input: { query: "x" } },
	{ type: "tool-output-available", toolCallId: "loop-1", output: "results" },
	{ type: "tool-input-start", toolCallId: "sb-1", toolName: "sandbox.search" },
	{ type: "tool-input-available", toolCallId: "sb-1", toolName: "sandbox.search", input: ["q"] },
	{ type: "tool-output-available", toolCallId: "sb-1", output: "hint" },
	{ type: "finish-step" },
	{ type: "start-step" },
	{ type: "text-start", id: "0" },
	{ type: "text-delta", id: "0", delta: "final answer" },
	{ type: "finish-step" },
	{ type: "finish", finishReason: "stop" },
]);

// 6: screenshot — the tool_execution_end event must reach the panel as
//    { text, images }, the shape ToolCardView renders as an <img>.
const { agentEventToChunk } = await import("../src/shared/ai/agent-event-to-chunk.ts");
const shotChunk = agentEventToChunk({
	type: "tool_execution_end",
	toolCallId: "shot-1",
	toolName: "screenshot",
	isError: false,
	result: {
		content: [
			{ type: "text", text: "Captured the active tab's visible viewport." },
			{ type: "image", mediaType: "image/png", encoding: "base64", data: "aGVsbG8=" },
		],
	},
});
const shotOutput = shotChunk?.output;
const shotOk =
	shotOutput &&
	typeof shotOutput === "object" &&
	shotOutput.text.includes("Captured") &&
	Array.isArray(shotOutput.images) &&
	shotOutput.images.length === 1 &&
	shotOutput.images[0].data === "aGVsbG8=";
console.log(`\n=== screenshot chunk ===\n${shotOk ? "OK: image block preserved in tool output" : `!!! BAD: ${JSON.stringify(shotChunk)}`}`);
if (!shotOk) process.exitCode = 1;

const errChunk = agentEventToChunk({
	type: "tool_execution_end",
	toolCallId: "shot-2",
	toolName: "screenshot",
	isError: true,
	result: { content: [{ type: "text", text: "capture failed" }] },
});
if (errChunk.type !== "tool-output-error" || errChunk.errorText !== "capture failed") {
	console.log(`!!! BAD error chunk: ${JSON.stringify(errChunk)}`);
	process.exitCode = 1;
}

// 7: tool output consumers — the base64 must not leak into display text, and a
//    follow-up turn must still receive the screenshot as an image block.
const { toolOutputText, toolOutputToContent } = await import("../src/shared/ai/tool-output.ts");
const shot = { text: "Captured the active tab's visible viewport.", images: [{ mediaType: "image/png", data: "aGVsbG8=" }] };
const checks = [
	["display text excludes base64", toolOutputText(shot), "Captured the active tab's visible viewport."],
	["plain string output", toolOutputText("plain"), "plain"],
	["object without images still serialises", toolOutputText({ a: 1 }), '{"a":1}'],
	["output with only images", toolOutputText({ images: shot.images }), ""],
];
for (const [label, actual, want] of checks) {
	if (actual !== want) {
		console.log(`!!! BAD ${label}: ${JSON.stringify(actual)} (want ${JSON.stringify(want)})`);
		process.exitCode = 1;
	}
}
const converted = toolOutputToContent(shot);
const imageBlock = converted.find((c) => c.type === "image");
const okContent =
	converted.length === 2 &&
	converted[0].type === "text" &&
	converted[0].text === shot.text &&
	imageBlock?.mediaType === "image/png" &&
	imageBlock?.data === "aGVsbG8=";
if (!okContent) {
	console.log(`!!! BAD image content blocks: ${JSON.stringify(converted)}`);
	process.exitCode = 1;
}
if (toolOutputToContent("plain").length !== 1) {
	console.log("!!! BAD string conversion");
	process.exitCode = 1;
}
console.log(`\n=== tool output consumers ===\n${okContent ? "OK: text for display, image block for the next turn" : "FAILED"}`);

// 8: history pruning — the newest KEPT_IMAGES screenshots stay (comparing a
//    before/after pair is a real workflow), older ones become a note. A real
//    session spent 94% of its input tokens re-sending one image.
const { pruneOldImages, OMITTED_IMAGE_NOTE, KEPT_IMAGES } = await import("../src/shared/ai/history.ts");
const img = (data) => ({ type: "image", mediaType: "image/webp", encoding: "base64", data });
const pruned = pruneOldImages([
	{ role: "toolResult", toolCallId: "s1", content: [{ type: "text", text: "first" }, img("AAAA")] },
	{ role: "assistant", content: [{ type: "text", text: "looked" }] },
	{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "plain result" }] },
	{ role: "toolResult", toolCallId: "s2", content: [{ type: "text", text: "second" }, img("BBBB")] },
	{ role: "toolResult", toolCallId: "s3", content: [{ type: "text", text: "third" }, img("CCCC")] },
	{ role: "toolResult", toolCallId: "s4", content: [{ type: "text", text: "fourth" }, img("DDDD")] },
]);
const images = pruned.flatMap((m) => (m.role === "toolResult" ? m.content.filter((c) => c.type === "image") : []));
const oldestResult = pruned[0];
const plainResult = pruned[2];
const pruneOk =
	KEPT_IMAGES === 3 &&
	images.length === 3 &&
	images.map((c) => c.data).join(",") === "BBBB,CCCC,DDDD" &&
	// the pruned image keeps the surviving text and gains the note
	oldestResult.content.some((c) => c.type === "text" && c.text === "first") &&
	oldestResult.content.some((c) => c.type === "text" && c.text === OMITTED_IMAGE_NOTE) &&
	plainResult.content.length === 1 &&
	plainResult.content[0].text === "plain result";
if (!pruneOk) {
	console.log(`!!! BAD image pruning: ${JSON.stringify(pruned)}`);
	process.exitCode = 1;
}
const untouched = pruneOldImages([{ role: "toolResult", toolCallId: "s1", content: [img("AAAA")] }]);
if (untouched[0].content.some((c) => c.type === "text")) {
	console.log("!!! BAD pruning under the limit");
	process.exitCode = 1;
}
console.log(`\n=== history images ===\n${pruneOk ? `OK: newest ${KEPT_IMAGES} kept, older replaced by a note` : "FAILED"}`);
