import { parseSSE } from "../sse";
import type { EventStream } from "../stream";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCallContent,
} from "../types";

interface AnthropicTextBlock {
	type: "text";
	text: string;
}

interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface AnthropicImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: "image/png";
		data: string;
	};
}

interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: (AnthropicTextBlock | AnthropicImageBlock)[];
	is_error?: boolean;
}

type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicThinkingBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContentBlock[];
}

export async function streamAnthropic(
	model: Model,
	context: Context,
	options: StreamOptions,
	stream: EventStream,
): Promise<void> {
	const partial: AssistantMessage = { role: "assistant", content: [], stopReason: "end" };
	stream.push({ type: "start", partial });

	const body = {
		model: model.id,
		messages: toAnthropicMessages(context.messages),
		...(context.systemPrompt ? { system: context.systemPrompt } : {}),
		...(context.tools && context.tools.length > 0
			? {
					tools: context.tools.map((t) => ({
						name: t.name,
						description: t.description,
						input_schema: t.parameters,
					})),
				}
			: {}),
		max_tokens: options.maxTokens ?? 4096,
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		stream: true,
	};

	const baseUrl = options.baseUrl?.replace(/\/+$/, "") || "https://api.anthropic.com";

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": options.apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			body: JSON.stringify(body),
			signal: options.signal,
		});
	} catch (err) {
		fail(partial, stream, options.signal, errorMessage(err));
		return;
	}

	if (!response.ok || !response.body) {
		const text = await safeText(response);
		fail(partial, stream, options.signal, `HTTP ${response.status}: ${text}`);
		return;
	}

	const blockIndexToContent = new Map<number, number>();
	const toolPartials = new Map<number, string>();

	try {
		for await (const ev of parseSSE(response.body, options.signal)) {
			if (!ev.data || ev.data === "[DONE]") continue;
			let payload: any;
			try {
				payload = JSON.parse(ev.data);
			} catch {
				continue;
			}

			const t = payload.type as string;
			if (t === "message_start") {
				const usage = payload.message?.usage;
				if (usage) {
					partial.usage = {
						inputTokens: usage.input_tokens ?? 0,
						outputTokens: usage.output_tokens ?? 0,
					};
				}
			} else if (t === "content_block_start") {
				const block = payload.content_block;
				if (block.type === "text") {
					const text: TextContent = { type: "text", text: "" };
					partial.content.push(text);
					blockIndexToContent.set(payload.index, partial.content.length - 1);
					stream.push({ type: "text_start", contentIndex: partial.content.length - 1, partial });
				} else if (block.type === "thinking") {
					const think: ThinkingContent = { type: "thinking", thinking: block.thinking ?? "" };
					if (block.signature) think.signature = block.signature;
					partial.content.push(think);
					blockIndexToContent.set(payload.index, partial.content.length - 1);
				} else if (block.type === "tool_use") {
					const tc: ToolCallContent = {
						type: "toolCall",
						id: block.id,
						name: block.name,
						arguments: (block.input as Record<string, unknown>) ?? {},
					};
					partial.content.push(tc);
					blockIndexToContent.set(payload.index, partial.content.length - 1);
					toolPartials.set(payload.index, "");
					stream.push({ type: "toolcall_start", contentIndex: partial.content.length - 1, partial });
				}
			} else if (t === "content_block_delta") {
				const ci = blockIndexToContent.get(payload.index);
				if (ci === undefined) continue;
				const delta = payload.delta;
				const block = partial.content[ci];
				if (delta.type === "text_delta" && block.type === "text") {
					block.text += delta.text;
					stream.push({ type: "text_delta", contentIndex: ci, delta: delta.text, partial });
				} else if (delta.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += delta.thinking ?? "";
				} else if (delta.type === "signature_delta" && block.type === "thinking") {
					block.signature = (block.signature ?? "") + (delta.signature ?? "");
				} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
					const acc = (toolPartials.get(payload.index) ?? "") + delta.partial_json;
					toolPartials.set(payload.index, acc);
					stream.push({ type: "toolcall_delta", contentIndex: ci, argsDelta: delta.partial_json, partial });
				}
			} else if (t === "content_block_stop") {
				const ci = blockIndexToContent.get(payload.index);
				if (ci === undefined) continue;
				const block = partial.content[ci];
				if (block.type === "toolCall") {
					const raw = toolPartials.get(payload.index) ?? "";
					if (raw.trim().length > 0) {
						try {
							block.arguments = JSON.parse(raw);
						} catch {
							block.arguments = {};
						}
					}
				}
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex: ci, partial });
				} else if (block.type === "toolCall") {
					stream.push({ type: "toolcall_end", contentIndex: ci, partial });
				}
			} else if (t === "message_delta") {
				if (payload.delta?.stop_reason) {
					partial.stopReason = mapStopReason(payload.delta.stop_reason);
				}
				if (payload.usage?.output_tokens != null && partial.usage) {
					partial.usage.outputTokens = payload.usage.output_tokens;
				}
				if (partial.usage) {
					stream.push({ type: "usage", usage: partial.usage, partial });
				}
			} else if (t === "error") {
				fail(partial, stream, options.signal, payload.error?.message ?? "anthropic stream error");
				return;
			}
		}
	} catch (err) {
		fail(partial, stream, options.signal, errorMessage(err));
		return;
	}

	stream.push({ type: "done", message: partial });
	stream.end();
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
			return "end";
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "end";
	}
}

function toAnthropicToolResultContent(
	content: Extract<Message, { role: "toolResult" }>["content"],
): (AnthropicTextBlock | AnthropicImageBlock)[] {
	return content.map((block) =>
		block.type === "text"
			? { type: "text", text: block.text }
			: {
					type: "image",
					source: { type: "base64", media_type: block.mediaType, data: block.data },
				},
	);
}

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? [{ type: "text" as const, text: msg.content }]
					: msg.content.map((c) => ({ type: "text" as const, text: c.text }));
			out.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const blocks: AnthropicContentBlock[] = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinking.length === 0 && !block.signature) continue;
					const out: AnthropicThinkingBlock = { type: "thinking", thinking: block.thinking };
					if (block.signature) out.signature = block.signature;
					blocks.push(out);
				} else if (block.type === "text") {
					if (block.text.length === 0) continue;
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "toolCall") {
					blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
				}
			}
			if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const results: AnthropicContentBlock[] = [
				{
					type: "tool_result",
					tool_use_id: msg.toolCallId,
					content: toAnthropicToolResultContent(msg.content),
					...(msg.isError ? { is_error: true } : {}),
				},
			];
			let j = i + 1;
			while (j < messages.length && messages[j].role === "toolResult") {
				const next = messages[j] as Extract<Message, { role: "toolResult" }>;
				results.push({
					type: "tool_result",
					tool_use_id: next.toolCallId,
					content: toAnthropicToolResultContent(next.content),
					...(next.isError ? { is_error: true } : {}),
				});
				j++;
			}
			i = j - 1;
			out.push({ role: "user", content: results });
		}
	}
	return out;
}

function fail(
	partial: AssistantMessage,
	stream: EventStream,
	signal: AbortSignal | undefined,
	message: string,
): void {
	partial.stopReason = signal?.aborted ? "aborted" : "error";
	partial.errorMessage = message;
	stream.push({ type: "error", error: message, message: partial });
	stream.end();
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "<no body>";
	}
}
