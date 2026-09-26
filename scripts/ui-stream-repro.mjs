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
