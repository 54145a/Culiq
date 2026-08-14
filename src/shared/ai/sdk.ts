import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	generateText,
	jsonSchema,
	streamText,
	tool as defineTool,
	type LanguageModel,
	type ModelMessage,
	type ToolSet,
} from "ai";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	StopReason,
	StreamOptions,
	ToolCallContent,
	ToolResultContent,
} from "./types";

/**
 * Provider integration backed by the Vercel AI SDK. The AI SDK's own streaming
 * model (`streamText(...).fullStream`) is consumed directly; there is no custom
 * stream protocol in between. Only the message conversion and the finished
 * `AssistantMessage` assembly live here, so all AI-SDK coupling stays inside
 * this module.
 */

export interface StreamAssistantCallbacks {
	/** Called once before streaming begins with the empty assistant message. */
	onStart?: (partial: AssistantMessage) => void;
	/** Called on each text delta with its content-block index. */
	onTextDelta?: (contentIndex: number, delta: string, partial: AssistantMessage) => void;
}

function toSdkContent(blocks: ToolResultContent[]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const b of blocks) {
		if (b.type === "text") {
			out.push({ type: "text", text: b.text });
		} else {
			out.push({ type: "file", mediaType: b.mediaType, data: { type: "data", data: b.data } });
		}
	}
	return out;
}

function toAISdkMessages(messages: Message[], provider: Model["provider"]): ModelMessage[] {
	const out: ModelMessage[] = [];

	const toolNameById = new Map<string, string>();
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "toolCall") toolNameById.set(block.id, block.name);
			}
		}
	}

	for (const m of messages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("");
			out.push({ role: "user", content: text ? [{ type: "text", text }] : [] } as unknown as ModelMessage);
		} else if (m.role === "assistant") {
			const content: Array<Record<string, unknown>> = [];
			if (m.reasoningContent && provider === "openai") {
				content.push({ type: "reasoning", text: m.reasoningContent });
			}
			for (const block of m.content) {
				if (block.type === "text") {
					content.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const part: Record<string, unknown> = { type: "reasoning", text: block.thinking };
					if (block.signature) part.providerOptions = { anthropic: { signature: block.signature } };
					content.push(part);
				} else if (block.type === "toolCall") {
					content.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.arguments });
				}
			}
			out.push({ role: "assistant", content } as unknown as ModelMessage);
		} else if (m.role === "toolResult") {
			const hasImage = m.content.some((c) => c.type === "image");
			let output: Record<string, unknown>;
			if (hasImage) {
				output = { type: "content", value: toSdkContent(m.content) };
			} else {
				const text = m.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("");
				output = m.isError === true ? { type: "error-text", value: text } : { type: "text", value: text };
			}
			out.push({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: m.toolCallId,
						toolName: toolNameById.get(m.toolCallId) ?? "",
						output,
					},
				],
			} as unknown as ModelMessage);
		}
	}
	return out;
}

function createModel(model: Model, options: StreamOptions): LanguageModel {
	if (model.provider === "anthropic") {
		const provider = createAnthropic({
			apiKey: options.apiKey,
			...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
			headers: { "anthropic-dangerous-direct-browser-access": "true" },
		});
		return provider.languageModel(model.id);
	}
	const provider = createOpenAICompatible({
		name: "openai-compatible",
		apiKey: options.apiKey,
		baseURL: options.baseUrl?.replace(/\/+$/, "") || "https://api.openai.com/v1",
	});
	return provider.languageModel(model.id);
}

function mapFinishReason(reason: string | undefined, signal?: AbortSignal): StopReason {
	if (signal?.aborted) return "aborted";
	switch (reason) {
		case "stop":
			return "end";
		case "tool-calls":
			return "toolUse";
		case "length":
			return "length";
		case "error":
			return "error";
		default:
			return "end";
	}
}

export async function streamAssistant(
	model: Model,
	context: Context,
	options: StreamOptions,
	callbacks: StreamAssistantCallbacks = {},
): Promise<AssistantMessage> {
	const partial: AssistantMessage = { role: "assistant", content: [], stopReason: "end" };

	const tools: ToolSet = {};
	for (const t of context.tools ?? []) {
		tools[t.name] = defineTool({ description: t.description, inputSchema: jsonSchema(t.parameters as never) });
	}

	const result = streamText({
		model: createModel(model, options),
		...(context.systemPrompt ? { system: context.systemPrompt } : {}),
		messages: toAISdkMessages(context.messages, model.provider),
		...(Object.keys(tools).length > 0 ? { tools } : {}),
		...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		...(options.signal ? { abortSignal: options.signal } : {}),
	});

	callbacks.onStart?.(partial);

	const indexByPartId = new Map<string, number>();
	const toolIndexes: number[] = [];
	const thinkingByPartId = new Map<string, number>();

	try {
		for await (const part of result.fullStream) {
			switch (part.type) {
				case "text-start": {
					partial.content.push({ type: "text", text: "" });
					indexByPartId.set(part.id, partial.content.length - 1);
					break;
				}
				case "text-delta": {
					const ci = indexByPartId.get(part.id);
					if (ci === undefined) break;
					const block = partial.content[ci];
					if (block.type !== "text") break;
					block.text += part.text;
					callbacks.onTextDelta?.(ci, part.text, partial);
					break;
				}
				case "reasoning-start": {
					if (model.provider === "anthropic") {
						partial.content.push({ type: "thinking", thinking: "" });
						thinkingByPartId.set(part.id, partial.content.length - 1);
					}
					break;
				}
				case "reasoning-delta": {
					if (model.provider === "anthropic") {
						const ci = thinkingByPartId.get(part.id);
						if (ci === undefined) break;
						const block = partial.content[ci];
						if (block.type !== "thinking") break;
						block.thinking += part.text;
						const sig = (part.providerMetadata as { anthropic?: { signature?: string } } | undefined)?.anthropic
							?.signature;
						if (sig) block.signature = (block.signature ?? "") + sig;
					} else {
						partial.reasoningContent = (partial.reasoningContent ?? "") + part.text;
					}
					break;
				}
				case "tool-input-start": {
					const block: ToolCallContent = { type: "toolCall", id: "", name: part.toolName, arguments: {} };
					partial.content.push(block);
					toolIndexes.push(partial.content.length - 1);
					break;
				}
				case "tool-call": {
					const ci = toolIndexes.shift();
					if (ci === undefined) break;
					const block = partial.content[ci];
					if (block.type !== "toolCall") break;
					block.id = part.toolCallId;
					block.arguments = (part.input as Record<string, unknown> | undefined) ?? {};
					break;
				}
				case "finish": {
					partial.stopReason = mapFinishReason(part.finishReason, options.signal);
					if (part.totalUsage) {
						partial.usage = {
							inputTokens: part.totalUsage.inputTokens ?? 0,
							outputTokens: part.totalUsage.outputTokens ?? 0,
						};
					}
					break;
				}
				case "error": {
					partial.stopReason = options.signal?.aborted ? "aborted" : "error";
					partial.errorMessage = part.error instanceof Error ? part.error.message : String(part.error);
					return partial;
				}
			}
		}
	} catch (err) {
		partial.stopReason = options.signal?.aborted ? "aborted" : "error";
		partial.errorMessage = err instanceof Error ? err.message : String(err);
	}

	return partial;
}

/** One-shot non-streaming completion (used for context summarization). */
export async function completeText(model: Model, context: Context, options: StreamOptions): Promise<string> {
	const result = await generateText({
		model: createModel(model, options),
		...(context.systemPrompt ? { system: context.systemPrompt } : {}),
		messages: toAISdkMessages(context.messages, model.provider),
		...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		...(options.signal ? { abortSignal: options.signal } : {}),
	});
	return result.text;
}
