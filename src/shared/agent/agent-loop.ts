import { streamSimple } from "../ai";
import type { AssistantMessage, Message, ToolCallContent, ToolResultMessage } from "../ai/types";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool, AgentToolResult } from "./types";
import { toolToLlmSpec } from "./types";

export type AgentEventSink = (event: AgentEvent) => void;

function publicToolResult(message: ToolResultMessage): ToolResultMessage {
	return {
		...message,
		content: message.content.filter((block) => block.type === "text"),
	};
}

function publicMessages(messages: Message[]): Message[] {
	return messages.map((message) => (message.role === "toolResult" ? publicToolResult(message) : message));
}

export async function runAgentLoop(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<void> {
	emit({ type: "agent_start" });

	const maxTurns = config.maxTurns;
	let turnIndex = 0;

	while (true) {
		if (signal?.aborted) {
			emit({ type: "agent_end", messages: publicMessages(context.messages), stopReason: "aborted" });
			return;
		}
		if (maxTurns !== undefined && turnIndex >= maxTurns) {
			emit({ type: "agent_end", messages: publicMessages(context.messages), stopReason: "max_turns" });
			return;
		}

		emit({ type: "turn_start", turnIndex });

		const assistantMessage = await streamAssistantResponse(context, config, emit, signal);
		context.messages.push(assistantMessage);
		emit({ type: "message_end", message: assistantMessage });

		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			emit({ type: "turn_end", assistantMessage, toolResults: [] });
			emit({
				type: "agent_end",
				messages: publicMessages(context.messages),
				stopReason: assistantMessage.stopReason === "aborted" ? "aborted" : "error",
				errorMessage: assistantMessage.errorMessage,
			});
			return;
		}

		const toolCalls = assistantMessage.content.filter((c): c is ToolCallContent => c.type === "toolCall");
		const toolResults: ToolResultMessage[] = [];

		if (toolCalls.length > 0) {
			const hasSequential = toolCalls.some(
				(tc) => context.tools.find((t) => t.name === tc.name)?.executionMode === "sequential",
			);
			const results = hasSequential
				? await executeSequential(context.tools, toolCalls, emit, signal)
				: await executeParallel(context.tools, toolCalls, emit, signal);
			for (const r of results) {
				toolResults.push(r);
				context.messages.push(r);
				const publicResult = publicToolResult(r);
				emit({ type: "message_start", message: publicResult });
				emit({ type: "message_end", message: publicResult });
			}
		}

		emit({ type: "turn_end", assistantMessage, toolResults: toolResults.map(publicToolResult) });

		if (toolCalls.length === 0 || assistantMessage.stopReason !== "toolUse") {
			emit({ type: "agent_end", messages: publicMessages(context.messages), stopReason: "end" });
			return;
		}

		turnIndex++;
	}
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<AssistantMessage> {
	const tools = context.tools.length > 0 ? context.tools.map(toolToLlmSpec) : undefined;

	const stream = streamSimple(
		config.model,
		{
			...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
			messages: context.messages,
			...(tools ? { tools } : {}),
		},
		{
			apiKey: config.apiKey,
			...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
			...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
			...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
			...(signal ? { signal } : {}),
		},
	);

	let started = false;
	for await (const event of stream) {
		if (event.type === "start") {
			started = true;
			emit({ type: "message_start", message: event.partial });
		} else if (event.type === "text_delta") {
			emit({
				type: "message_update",
				message: event.partial,
				delta: { kind: "text", contentIndex: event.contentIndex, text: event.delta },
			});
		} else if (event.type === "done" || event.type === "error") {
			if (!started) emit({ type: "message_start", message: event.message });
			return event.message;
		}
	}
	return stream.result();
}

async function executeParallel(
	tools: AgentTool[],
	toolCalls: ToolCallContent[],
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
	const tasks = toolCalls.map((tc) => runToolCall(tools, tc, emit, signal));
	return Promise.all(tasks);
}

async function executeSequential(
	tools: AgentTool[],
	toolCalls: ToolCallContent[],
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
	const out: ToolResultMessage[] = [];
	for (const tc of toolCalls) {
		out.push(await runToolCall(tools, tc, emit, signal));
	}
	return out;
}

async function runToolCall(
	tools: AgentTool[],
	toolCall: ToolCallContent,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<ToolResultMessage> {
	emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});

	const tool = tools.find((t) => t.name === toolCall.name);
	let result: AgentToolResult;
	let isError = false;

	if (!tool) {
		result = { content: [{ type: "text", text: `Tool not found: ${toolCall.name}` }], isError: true };
		isError = true;
	} else {
		try {
			result = await tool.execute(toolCall.arguments, signal);
			isError = result.isError === true;
		} catch (err) {
			result = {
				content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			};
			isError = true;
		}
	}

	emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result: { ...result, content: result.content.filter((block) => block.type === "text") },
		isError,
	});

	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		content: result.content,
		...(isError ? { isError: true } : {}),
	};
}
