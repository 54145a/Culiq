import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { AgentEvent } from "@shared/agent/types";
import type {
	AssistantContent,
	AssistantMessage,
	ContextContent,
	Message,
	TextContent,
	ThinkingContent,
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
		let reasoningContent = "";
		for (const part of m.parts) {
			const type = (part as { type?: string }).type;
			if (type === "text" && (part as { text?: string }).text) {
				content.push({ type: "text", text: (part as { text: string }).text } as TextContent);
			} else if (type === "reasoning") {
				const rp = part as { text?: string; signature?: string; providerMetadata?: { anthropic?: { signature?: string } } };
				const text = rp.text ?? "";
				const signature = rp.signature ?? rp.providerMetadata?.anthropic?.signature;
				if (signature) {
					content.push({ type: "thinking", thinking: text, signature } as ThinkingContent);
				} else if (text) {
					reasoningContent = reasoningContent ? `${reasoningContent}\n${text}` : text;
				}
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
				} else {
					results.push(toolResult(tp.toolCallId, INTERRUPTED_TOOL_RESULT));
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
				} else {
					results.push(toolResult(tp.toolCallId, INTERRUPTED_TOOL_RESULT));
				}
			}
		}
		const assistantMessage: AssistantMessage = { role: "assistant", content, stopReason: "end" };
		if (reasoningContent) assistantMessage.reasoningContent = reasoningContent;
		out.push(assistantMessage);
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

/**
 * Answer for a tool call that never produced a result — the turn was aborted, or
 * the stream closed before the tool finished. Providers reject a conversation
 * whose assistant tool call has no matching tool result ("Tool result is
 * missing"), so every tool call must be answered. The session-restore path
 * already synthesises this reply; the live path must do the same or the NEXT
 * message fails to send.
 */
const INTERRUPTED_TOOL_RESULT = "Tool call was interrupted before a result was received.";

/**
 * Sub-agent invocations arrive under two names: the native `subtask` tool and
 * the sandbox bridge's `sandbox.subtask`. Both wrap the same `runSubagent` call
 * and tag their internal events with a `subtaskId`, so both must be routed into
 * the subtask buffer — otherwise the sub-agent's events leak into the main
 * message and its `agent_end` closes the main stream early.
 */
function isSubtaskTool(name: string): boolean {
	return name === "subtask" || name.endsWith(".subtask");
}

/**
 * Session-wide token baseline: sum every per-call usage entry already present
 * in the message history — main `data-usage` parts plus sub-agent calls inside
 * `data-subtask` payloads. Recomputed from raw per-call values on every send
 * (never from stored cumulative totals) so editing history, reloading a stored
 * session, or switching sessions stays exact without double-counting.
 */
function sumPriorUsage(messages: UIMessage[]): { input: number; output: number } {
	let input = 0;
	let output = 0;
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const part of m.parts) {
			const pt = part as { type?: string; data?: unknown };
			if (pt.type === "data-usage") {
				const d = pt.data as { input?: number; output?: number } | undefined;
				if (d && typeof d === "object") {
					input += d.input ?? 0;
					output += d.output ?? 0;
				}
			} else if (pt.type === "data-subtask") {
				const msgs = pt.data as Array<{ usage?: { inputTokens?: number; outputTokens?: number } }> | undefined;
				if (Array.isArray(msgs)) {
					for (const sm of msgs) {
						input += sm.usage?.inputTokens ?? 0;
						output += sm.usage?.outputTokens ?? 0;
					}
				}
			}
		}
	}
	return { input, output };
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
				const reasoningStartSent = new Set<string>();
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

				// The SW's `cumulative` resets on every user send; carry the whole
				// session instead by seeding from prior history and growing it with
				// every API call (main agent and sub-agents alike) as its usage
				// event passes through.
				let sessionTotal = sumPriorUsage(options.messages);

			this.handlers.set(turnId, (rawEvent: AgentEvent) => {
				if (closed) return;
				let event = rawEvent;

				try {
					// Intercept before the subtask buffering below so sub-agent usage
					// counts toward the session total and its card shows session-to-now.
					if (event.type === "message_usage") {
						sessionTotal.input += event.usage.inputTokens;
						sessionTotal.output += event.usage.outputTokens;
						event = { ...event, cumulative: { inputTokens: sessionTotal.input, outputTokens: sessionTotal.output } };
					}

					// Subtask event routing
					if (event.type === "tool_execution_start" && isSubtaskTool(event.toolName)) {
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

					// Every sub-agent event carries a `subtaskId`; it must never reach the
					// main message or the main stream's lifecycle handling. Route it to the
					// buffer of whichever subtask invocation is currently running.
					if (event.subtaskId) {
						const buffered = activeSubtaskId ? subtaskEvents.get(activeSubtaskId) : undefined;
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
						reasoningStartSent.clear();
					}

					// Handle reasoning-delta: ensure reasoning-start is sent first for this
					// id. No early return — the delta itself is mapped by agentEventToChunk.
					if (event.type === "message_update" && event.delta.kind === "reasoning") {
						const id = event.delta.id;
						if (!reasoningStartSent.has(id)) {
							safeEnqueue({ type: "reasoning-start", id } as UIMessageChunk);
							reasoningStartSent.add(id);
						}
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

					// Only the main agent's end closes the stream; a sub-agent's end (already
					// buffered above) must never terminate the outer turn.
					if (event.type === "agent_end" && !event.subtaskId) {
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
					const resultText = event.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
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
