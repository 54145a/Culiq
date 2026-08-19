import type { AgentEvent } from "../agent/types";

/**
 * Maps an AgentEvent (from the background service worker) to a UIMessageChunk
 * that can be consumed by the AI SDK's useChat hook via processUIMessageStream.
 */
export function agentEventToChunk(event: AgentEvent): Record<string, unknown> | Record<string, unknown>[] | null {
	switch (event.type) {
		case "agent_start":
			return { type: "start" };

		case "message_start": {
			const id = event.message.role === "assistant"
				? (event.message as { id?: string }).id ?? crypto.randomUUID()
				: "";
			return { type: "start", messageId: id };
		}

		case "message_update": {
			const delta = event.delta;
			if (delta.kind === "text") {
				if (!delta.text) return null;
				return { type: "text-delta", delta: delta.text, id: String(delta.contentIndex) };
			}
			return null;
		}

		case "message_end":
			return null;

		case "tool_execution_start": {
			const inputJson = JSON.stringify(event.args);
			return [
				{ type: "tool-input-start", toolCallId: event.toolCallId, toolName: event.toolName },
				{ type: "tool-input-delta", toolCallId: event.toolCallId, inputTextDelta: inputJson },
				{ type: "tool-input-available", toolCallId: event.toolCallId, toolName: event.toolName, input: event.args },
			];
		}

		case "tool_execution_end":
			if (event.isError) {
				const errorText = event.result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return {
					type: "tool-output-error",
					toolCallId: event.toolCallId,
					errorText,
				};
			}
			return {
				type: "tool-output-available",
				toolCallId: event.toolCallId,
				output: event.result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n"),
			};

		case "turn_start":
			return { type: "start-step" };

		case "turn_end":
			return { type: "finish-step" };

		case "context_sent":
			return {
				type: "data-context",
				id: "context",
				data: event.text,
			};

		case "context_compressed":
			return {
				type: "data-compress",
				id: "compress",
				data: {
					beforeTokens: event.beforeTokens,
					afterTokens: event.afterTokens,
					keptTurns: event.keptTurns,
					summary: event.summary,
				},
			};

		case "agent_end": {
			const finishReason = event.stopReason === "aborted"
				? "abort"
				: event.stopReason === "max_turns"
					? "max-steps"
					: event.stopReason === "error"
						? "error"
						: "stop";
			return { type: "finish", finishReason };
		}

		default:
			return null;
	}
}
