import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { BgToPanel, ChatContextMode, PanelToBg } from "@shared/transport/protocol";
import { agentEventToChunk } from "@shared/ai/agent-event-to-chunk";

type SendFn = (msg: PanelToBg) => void;
type OnMessageFn = (cb: (msg: BgToPanel) => void) => () => void;

/**
 * A ChatTransport that bridges Chrome extension message passing
 * (BgConnection) to the AI SDK's ReadableStream<UIMessageChunk> protocol.
 */
export class ExtensionChatTransport implements ChatTransport<UIMessage> {
	private sendFn: SendFn;
	private onMessageFn: OnMessageFn;
	private contextMode?: ChatContextMode;
	private windowId?: number;

	constructor(sendFn: SendFn, onMessageFn: OnMessageFn) {
		this.sendFn = sendFn;
		this.onMessageFn = onMessageFn;
	}

	setContextMode(mode: ChatContextMode | undefined): void {
		this.contextMode = mode;
	}

	setWindowId(id: number | undefined): void {
		this.windowId = id;
	}

	async sendMessages(options: {
		trigger: "submit-message" | "regenerate-message";
		chatId: string;
		messageId: string | undefined;
		messages: UIMessage[];
		abortSignal: AbortSignal | undefined;
	}): Promise<ReadableStream<UIMessageChunk>> {
		const turnId = crypto.randomUUID();

		const panelMessages = options.messages.map((m) => ({
			role: m.role as "user" | "assistant",
			content: m.parts
				.filter((p): p is { type: "text"; text: string } => p.type === "text")
				.map((p) => p.text)
				.join(""),
		})) as Array<{ role: "user" | "assistant"; content: string }>;

		const msg: PanelToBg = {
			type: "chat_send",
			turnId,
			messages: panelMessages as never,
			...(this.contextMode ? { contextMode: this.contextMode } : {}),
			...(this.windowId !== undefined ? { windowId: this.windowId } : {}),
		};

		return new ReadableStream<UIMessageChunk>({
			start: (controller) => {
				let closed = false;
				const textStartSent = new Set<string>();

			const safeEnqueue = (chunk: UIMessageChunk) => {
				if (!closed) {
					try {
						controller.enqueue(chunk);
						} catch {
							closed = true;
						}
					}
				};

				const unsub = this.onMessageFn((bgMsg: BgToPanel) => {
					if (closed) return;
					if (bgMsg.type !== "agent_event" || bgMsg.turnId !== turnId) return;

					const event = bgMsg.event;

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
						setTimeout(() => {
							if (!closed) {
								closed = true;
								controller.close();
								unsub();
							}
						}, 50);
					}
				});

				if (options.abortSignal) {
					options.abortSignal.addEventListener("abort", () => {
						if (!closed) {
							closed = true;
							controller.close();
							unsub();
							this.sendFn({ type: "chat_abort", turnId });
						}
					}, { once: true });
				}

				this.sendFn(msg);
			},
		});
	}

	async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
		return null;
	}
}
