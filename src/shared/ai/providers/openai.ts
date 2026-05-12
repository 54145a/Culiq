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
	ToolCallContent,
} from "../types";

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | OpenAIContentPart[] | null;
	tool_calls?: OpenAIAssistantToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

interface OpenAIContentPart {
	type: "text";
	text: string;
}

interface OpenAIAssistantToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export async function streamOpenAI(
	model: Model,
	context: Context,
	options: StreamOptions,
	stream: EventStream,
): Promise<void> {
	const partial: AssistantMessage = { role: "assistant", content: [], stopReason: "end" };
	stream.push({ type: "start", partial });

	const body = {
		model: model.id,
		messages: toOpenAIMessages(context.systemPrompt, context.messages),
		...(context.tools && context.tools.length > 0
			? {
					tools: context.tools.map((t) => ({
						type: "function" as const,
						function: { name: t.name, description: t.description, parameters: t.parameters },
					})),
				}
			: {}),
		...(options.maxTokens !== undefined ? { max_completion_tokens: options.maxTokens } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		stream: true,
		stream_options: { include_usage: true },
	};

	const baseUrl = options.baseUrl?.replace(/\/+$/, "") || "https://api.openai.com/v1";

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${options.apiKey}`,
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

	const textIndexByChoice = new Map<number, number>();
	const toolIndexToContent = new Map<number, number>();
	const toolPartials = new Map<number, string>();
	let textStartedForChoice0 = false;

	try {
		for await (const ev of parseSSE(response.body, options.signal)) {
			if (!ev.data || ev.data === "[DONE]") continue;
			let payload: any;
			try {
				payload = JSON.parse(ev.data);
			} catch {
				continue;
			}

			if (payload.usage && partial) {
				partial.usage = {
					inputTokens: payload.usage.prompt_tokens ?? 0,
					outputTokens: payload.usage.completion_tokens ?? 0,
				};
				stream.push({ type: "usage", usage: partial.usage, partial });
			}

			const choice = payload.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta ?? {};

			if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
				partial.reasoningContent = (partial.reasoningContent ?? "") + delta.reasoning_content;
			}

			if (typeof delta.content === "string" && delta.content.length > 0) {
				if (!textStartedForChoice0) {
					const text: TextContent = { type: "text", text: "" };
					partial.content.push(text);
					const ci = partial.content.length - 1;
					textIndexByChoice.set(0, ci);
					textStartedForChoice0 = true;
					stream.push({ type: "text_start", contentIndex: ci, partial });
				}
				const ci = textIndexByChoice.get(0);
				if (ci !== undefined) {
					const block = partial.content[ci];
					if (block.type === "text") {
						block.text += delta.content;
						stream.push({ type: "text_delta", contentIndex: ci, delta: delta.content, partial });
					}
				}
			}

			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const idx: number = tc.index;
					let ci = toolIndexToContent.get(idx);
					if (ci === undefined) {
						const block: ToolCallContent = {
							type: "toolCall",
							id: tc.id ?? "",
							name: tc.function?.name ?? "",
							arguments: {},
						};
						partial.content.push(block);
						ci = partial.content.length - 1;
						toolIndexToContent.set(idx, ci);
						toolPartials.set(idx, "");
						stream.push({ type: "toolcall_start", contentIndex: ci, partial });
					}
					const block = partial.content[ci];
					if (block.type !== "toolCall") continue;
					if (!block.id && tc.id) block.id = tc.id;
					if (!block.name && tc.function?.name) block.name = tc.function.name;
					if (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
						const acc = (toolPartials.get(idx) ?? "") + tc.function.arguments;
						toolPartials.set(idx, acc);
						stream.push({
							type: "toolcall_delta",
							contentIndex: ci,
							argsDelta: tc.function.arguments,
							partial,
						});
					}
				}
			}

			if (choice.finish_reason) {
				if (textStartedForChoice0) {
					const ci = textIndexByChoice.get(0);
					if (ci !== undefined) stream.push({ type: "text_end", contentIndex: ci, partial });
				}
				for (const [idx, ci] of toolIndexToContent.entries()) {
					const block = partial.content[ci];
					if (block.type === "toolCall") {
						const raw = toolPartials.get(idx) ?? "";
						if (raw.trim().length > 0) {
							try {
								block.arguments = JSON.parse(raw);
							} catch {
								block.arguments = {};
							}
						}
					}
					stream.push({ type: "toolcall_end", contentIndex: ci, partial });
				}
				partial.stopReason = mapFinishReason(choice.finish_reason);
			}
		}
	} catch (err) {
		fail(partial, stream, options.signal, errorMessage(err));
		return;
	}

	stream.push({ type: "done", message: partial });
	stream.end();
}

function mapFinishReason(reason: string): StopReason {
	switch (reason) {
		case "stop":
			return "end";
		case "tool_calls":
			return "toolUse";
		case "length":
			return "length";
		default:
			return "end";
	}
}

function toOpenAIMessages(systemPrompt: string | undefined, messages: Message[]): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];
	if (systemPrompt) out.push({ role: "system", content: systemPrompt });

	for (const msg of messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : msg.content.map((c) => c.text).join("");
			out.push({ role: "user", content: text });
		} else if (msg.role === "assistant") {
			let text = "";
			const toolCalls: OpenAIAssistantToolCall[] = [];
			for (const block of msg.content) {
				if (block.type === "text") text += block.text;
				else if (block.type === "toolCall") {
					toolCalls.push({
						id: block.id,
						type: "function",
						function: { name: block.name, arguments: JSON.stringify(block.arguments) },
					});
				}
			}
			const entry: OpenAIMessage = { role: "assistant", content: text.length > 0 ? text : null };
			if (toolCalls.length > 0) entry.tool_calls = toolCalls;
			if (msg.reasoningContent && msg.reasoningContent.length > 0) entry.reasoning_content = msg.reasoningContent;
			out.push(entry);
		} else if (msg.role === "toolResult") {
			out.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: msg.content.map((c) => c.text).join(""),
			});
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
