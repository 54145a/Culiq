import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { AgentEvent } from "@shared/agent/types";
import type {
	AssistantContent,
	ContextContent,
	Message,
	TextContent,
	ToolCallContent,
	ToolResultContent,
	ToolResultMessage,
} from "@shared/ai/types";
import type { BgToPanel, ChatContextMode, PanelToBg } from "@shared/transport/protocol";
import { agentEventToChunk } from "@shared/ai/agent-event-to-chunk";

/**
 * Convert the UI message history (`useChat`'s UIMessage[]) into the agent's
 * `Message[]` format, preserving every part — especially tool calls/results and
 * context blocks. The previous implementation joined only `type: "text"` parts,
 * which silently dropped all tool interactions from the history the agent saw.
 */
function uiMessagesToAgentMessages(messages: UIMessage[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const text = m.parts
				.filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
				.map((p) => p.text)
				.join("");
			out.push({ role: "user", content: text });
			continue;
		}
		if (m.role !== "assistant") continue;

		const content: AssistantContent[] = [];
		const results: ToolResultMessage[] = [];
		for (const part of m.parts) {
			const type = (part as { type?: string }).type;
			if (type === "text" && (part as { text?: string }).text) {
				content.push({ type: "text", text: (part as { text: string }).text } as TextContent);
			} else if (type === "data-context") {
				const data = (part as { data?: unknown }).data;
				if (typeof data === "string" && data) content.push({ type: "context", text: data } as ContextContent);
			} else if (type === "data-compress") {
				const data = (part as { data?: unknown }).data;
				if (typeof data === "string" && data) content.push({ type: "context", text: data } as ContextContent);
			} else if (type === "tool-invocation") {
				const tp = part as { toolCallId: string; toolName: string; input?: unknown; output?: unknown; errorText?: string };
				content.push({
					type: "toolCall",
					id: tp.toolCallId,
					name: tp.toolName,
					arguments: (tp.input ?? {}) as Record<string, unknown>,
				} as ToolCallContent);
				if (tp.output != null) {
					results.push(toolResult(tp.toolCallId, tp.output));
				} else if (tp.errorText) {
					results.push(toolResult(tp.toolCallId, tp.errorText));
				}
			} else if (typeof type === "string" && type.startsWith("tool-")) {
				const tp = part as { toolCallId: string; input: unknown; output?: unknown; errorText?: string };
				content.push({
					type: "toolCall",
					id: tp.toolCallId,
					name: type.slice(5),
					arguments: (tp.input ?? {}) as Record<string, unknown>,
				} as ToolCallContent);
				if (tp.output != null) {
					results.push(toolResult(tp.toolCallId, tp.output));
				} else if (tp.errorText) {
					results.push(toolResult(tp.toolCallId, tp.errorText));
				}
			}
		}
		out.push({ role: "assistant", content, stopReason: "end" });
		out.push(...results);
	}
	return out;
}

function toolResult(toolCallId: string, output: unknown): ToolResultMessage {
	const text = typeof output === "string" ? output : JSON.stringify(output);
	return {
		role: "toolResult",
		toolCallId,
		content: [{ type: "text", text } as ToolResultContent],
	};
}

type SendFn = (msg: PanelToBg) => void;
type OnMessageFn = (cb: (msg: BgToPanel) => void) => () => void;

/**
 * A ChatTransport that bridges Chrome extension message passing
 * (BgConnection) to the AI SDK's ReadableStream<UIMessageChunk> protocol.
 */
export class ExtensionChatTransport implements ChatTransport<UIMessage> {
	private sendFn: SendFn;
	private contextMode?: ChatContextMode;
	private windowId?: number;
	private enabledCustomTools?: string[];
	private reasoning?: string;
	private handlers = new Map<string, (event: AgentEvent) => void>();

	constructor(sendFn: SendFn, onMessageFn: OnMessageFn) {
		this.sendFn = sendFn;
		// One lifetime listener: route each agent_event to the active stream for
		// its turnId. This guarantees no listener accumulation across sends.
		onMessageFn((bgMsg: BgToPanel) => {
			if (bgMsg.type !== "agent_event") return;
			this.handlers.get(bgMsg.turnId)?.(bgMsg.event);
		});
	}

	setContextMode(mode: ChatContextMode | undefined): void {
		this.contextMode = mode;
	}

	setWindowId(id: number | undefined): void {
		this.windowId = id;
	}

	setCustomTools(tools: string[] | undefined): void {
		this.enabledCustomTools = tools;
	}

	setReasoning(level: string | undefined): void {
		this.reasoning = level;
	}

	async sendMessages(options: {
		trigger: "submit-message" | "regenerate-message";
		chatId: string;
		messageId: string | undefined;
		messages: UIMessage[];
		abortSignal: AbortSignal | undefined;
	}): Promise<ReadableStream<UIMessageChunk>> {
		const turnId = crypto.randomUUID();

		const panelMessages = uiMessagesToAgentMessages(options.messages);

		const msg: PanelToBg = {
			type: "chat_send",
			turnId,
			messages: panelMessages as never,
			...(this.contextMode ? { contextMode: this.contextMode } : {}),
			...(this.windowId !== undefined ? { windowId: this.windowId } : {}),
			...(options.chatId ? { sessionId: options.chatId } : {}),
			...(this.enabledCustomTools ? { enabledCustomTools: this.enabledCustomTools } : {}),
			...(this.reasoning ? { reasoning: this.reasoning } : {}),
		};

		return new ReadableStream<UIMessageChunk>({
			start: (controller) => {
				let closed = false;
				const textStartSent = new Set<string>();
				let activeSubtaskId: string | null = null;
				const subtaskEvents = new Map<string, AgentEvent[]>();

				const safeEnqueue = (chunk: UIMessageChunk) => {
					if (!closed) {
						try {
							controller.enqueue(chunk);
						} catch {
							closed = true;
						}
					}
				};

				const finish = () => {
					this.handlers.delete(turnId);
					if (!closed) {
						closed = true;
						controller.close();
					}
				};

			this.handlers.set(turnId, (event: AgentEvent) => {
				if (closed) return;

				try {
					// Subtask event routing
					if (event.type === "tool_execution_start" && event.toolName === "subtask") {
						activeSubtaskId = event.toolCallId;
						subtaskEvents.set(event.toolCallId, []);
						// Emit tool card for the subtask invocation itself
						const chunks = agentEventToChunk(event);
						if (chunks) {
							const arr = Array.isArray(chunks) ? chunks : [chunks];
							for (const chunk of arr) safeEnqueue(chunk as UIMessageChunk);
						}
						return;
					}

					if (event.subtaskId && activeSubtaskId) {
						// Buffer subtask internal events
						const buffered = subtaskEvents.get(activeSubtaskId);
						if (buffered) buffered.push(event);
						return;
					}

					if (event.type === "tool_execution_end" && event.toolCallId === activeSubtaskId) {
						// Subtask finished — emit its collected messages as data-subtask
						const buffered = subtaskEvents.get(event.toolCallId) ?? [];
						const messages = this.buildSubtaskMessages(buffered);
						safeEnqueue({ type: "data-subtask", id: event.toolCallId, data: messages } as UIMessageChunk);
						// Also emit the tool result
						const chunks = agentEventToChunk(event);
						if (chunks) {
							const arr = Array.isArray(chunks) ? chunks : [chunks];
							for (const chunk of arr) safeEnqueue(chunk as UIMessageChunk);
						}
						activeSubtaskId = null;
						subtaskEvents.delete(event.toolCallId);
						return;
					}

					// New LLM call within the same turn: reset so text-start is sent again
					if (event.type === "turn_start") {
						textStartSent.clear();
					}

					// Handle text-delta: ensure text-start is sent first
					if (event.type === "message_update" && event.delta.kind === "text") {
						const id = String(event.delta.contentIndex);
						if (!textStartSent.has(id)) {
							safeEnqueue({ type: "text-start", id } as UIMessageChunk);
							textStartSent.add(id);
						}
						safeEnqueue({ type: "text-delta", delta: event.delta.text, id } as UIMessageChunk);
						return;
					}

					// All other events go through normal conversion
					const result = agentEventToChunk(event);
					if (result) {
						const chunks = Array.isArray(result) ? result : [result];
						for (const chunk of chunks) {
							safeEnqueue(chunk as UIMessageChunk);
						}
					}

					if (event.type === "agent_end") {
						setTimeout(finish, 50);
					}
				} catch (err) {
					console.error("[culiq transport] event handler error:", err);
					safeEnqueue({ type: "finish", finishReason: "error" } as UIMessageChunk);
					setTimeout(finish, 50);
				}
			});

				if (options.abortSignal) {
					options.abortSignal.addEventListener(
						"abort",
						() => {
							finish();
							this.sendFn({ type: "chat_abort", turnId });
						},
						{ once: true },
					);
				}

				this.sendFn(msg);
			},
		});
	}

	/**
	 * Convert buffered subtask agent events into a serializable messages array
	 * that the SubtaskCard can render.
	 */
	private buildSubtaskMessages(events: AgentEvent[]): Array<{
		role: "assistant" | "toolResult";
		content: string;
		toolName?: string;
		usage?: { inputTokens: number; outputTokens: number };
		cumulative?: { inputTokens: number; outputTokens: number };
	}> {
		const messages: Array<{ role: "assistant" | "toolResult"; content: string; toolName?: string; usage?: { inputTokens: number; outputTokens: number }; cumulative?: { inputTokens: number; outputTokens: number } }> = [];
		for (const event of events) {
			if (event.type === "message_update" && event.delta.kind === "text") {
				// Append delta to last assistant message or create new one
				const last = messages[messages.length - 1];
				if (last?.role === "assistant") {
					last.content += event.delta.text;
				} else {
					messages.push({ role: "assistant", content: event.delta.text });
				}
			} else if (event.type === "tool_execution_start") {
				messages.push({ role: "toolResult", content: `[${event.toolName}]`, toolName: event.toolName });
			} else if (event.type === "tool_execution_end") {
				const last = messages[messages.length - 1];
				if (last?.role === "toolResult" && !last.content.includes(": ")) {
					const resultText = event.result.content.map((c) => c.text).join("\n");
					last.content = `[${event.toolName}] ${resultText}`;
				}
			} else if (event.type === "message_usage") {
				// Attach usage to last assistant message
				const last = messages[messages.length - 1];
				if (last?.role === "assistant") {
					last.usage = event.usage;
					last.cumulative = event.cumulative;
				}
			}
		}
		return messages;
	}

	async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
		return null;
	}
}
