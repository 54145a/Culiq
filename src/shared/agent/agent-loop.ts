import { estimateTokenCount, sliceByTokens } from "tokenx";
import { completeText, streamAssistant } from "../ai";
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

	await maybeCompressContext(context, config, emit, signal);

	let started = false;
	const assistantMessage = await streamAssistant(
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
		{
			onStart: (partial) => {
				started = true;
				emit({ type: "message_start", message: partial });
			},
			onTextDelta: (contentIndex, text, partial) =>
				emit({
					type: "message_update",
					message: partial,
					delta: { kind: "text", contentIndex, text },
				}),
		},
	);

	if (!started) emit({ type: "message_start", message: assistantMessage });
	return assistantMessage;
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

// ---------------------------------------------------------------------------
// Context compression (hybrid: LLM summary of old turns + recent-turn window)
// ---------------------------------------------------------------------------

const IMAGE_TOKENS = 1000;
const SUMMARY_MAX_TOKENS = 2048;
const SUMMARY_INPUT_TOKEN_CAP = 32000;
const DEFAULT_CONTEXT_WINDOW = 64000;

const SUMMARY_PROMPT = `You are compressing the early part of a browser-agent conversation. The transcript below lists tool interactions and model replies from a session that drives a browser on behalf of a user.

Write a concise, information-dense summary that preserves:
- The user's original goal and any later instructions that still apply.
- Every meaningful action taken: URLs opened, content read, elements clicked, text typed, JavaScript evaluated, and notable results.
- Key facts about the pages visited (structure, values, state) that may still matter.
- Any errors encountered and what was learned.
- Any unresolved or in-progress threads the agent should continue.

Omit per-turn filler and repeated narration. Do not add commentary or markdown. Output only the summary text.`;

function resolveContextWindow(override?: number): number {
	if (override !== undefined && override > 0) return override;
	return DEFAULT_CONTEXT_WINDOW;
}

function estimateMessagesTokens(messages: Message[]): number {
	let sum = 0;
	for (const m of messages) {
		if (m.role === "user") {
			sum +=
				typeof m.content === "string"
					? estimateTokenCount(m.content)
					: m.content.reduce((s, c) => s + (c.type === "text" ? estimateTokenCount(c.text) : IMAGE_TOKENS), 0);
		} else if (m.role === "assistant") {
			for (const c of m.content) {
				if (c.type === "text") sum += estimateTokenCount(c.text);
				else if (c.type === "thinking") sum += estimateTokenCount(c.thinking);
				else if (c.type === "toolCall") sum += estimateTokenCount(JSON.stringify(c.arguments));
			}
		} else if (m.role === "toolResult") {
			for (const c of m.content) {
				sum += c.type === "text" ? estimateTokenCount(c.text) : IMAGE_TOKENS;
			}
		}
	}
	return sum;
}

function estimateContextTokens(context: Pick<AgentContext, "systemPrompt" | "tools" | "messages">): number {
	let total = 0;
	if (context.systemPrompt) total += estimateTokenCount(context.systemPrompt);
	for (const tool of context.tools) total += estimateTokenCount(JSON.stringify(toolToLlmSpec(tool)));
	return total + estimateMessagesTokens(context.messages);
}

function splitTurns(messages: Message[]): { turns: Message[][]; tail: Message[] } {
	const turns: Message[][] = [];
	let current: Message[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			if (current.length > 0) turns.push(current);
			current = [m];
		} else {
			current.push(m);
		}
	}
	if (current.length === 0) return { turns, tail: [] };
	if (current[0].role === "user") {
		turns.push(current);
		return { turns, tail: [] };
	}
	return { turns, tail: current };
}

function messageToPlainText(m: Message): string {
	if (m.role === "user") {
		return typeof m.content === "string"
			? m.content
			: m.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
	}
	if (m.role === "assistant") {
		const parts: string[] = [];
		for (const c of m.content) {
			if (c.type === "text") parts.push(c.text);
			else if (c.type === "toolCall") parts.push(`[tool_call] ${c.name}(${JSON.stringify(c.arguments)})`);
		}
		return parts.join("\n");
	}
	if (m.role === "toolResult") {
		return m.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

async function summarizeTurns(turns: Message[][], config: AgentLoopConfig, signal?: AbortSignal): Promise<string> {
	const text = turns.flat().map(messageToPlainText).filter(Boolean).join("\n");
	if (text.length === 0) return "";
	const capped = sliceByTokens(text, 0, SUMMARY_INPUT_TOKEN_CAP);

	try {
		const summary = await completeText(
			config.model,
			{
				systemPrompt: SUMMARY_PROMPT,
				messages: [{ role: "user", content: capped }],
			},
			{
				apiKey: config.apiKey,
				...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
				maxTokens: SUMMARY_MAX_TOKENS,
				...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
				...(signal ? { signal } : {}),
			},
		);
		return summary.trim();
	} catch {
		return "";
	}
}

async function maybeCompressContext(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
): Promise<void> {
	const cm = config.contextManagement;
	if (!cm?.enabled || context.messages.length < 2) return;

	const beforeTokens = estimateContextTokens(context);
	const window = resolveContextWindow(cm.windowOverride);
	const threshold = Math.floor(window * cm.thresholdRatio);
	if (beforeTokens <= threshold) return;

	const { turns, tail } = splitTurns(context.messages);
	if (turns.length <= 1) return;

	let keep = Math.min(cm.keepTurns, turns.length);
	while (keep > 1) {
		const kept = turns.slice(-keep).flat();
		if (estimateContextTokens({ ...context, messages: [...kept, ...tail] }) <= threshold) break;
		keep--;
	}

	const oldTurns = turns.slice(0, -keep);
	if (oldTurns.length === 0) return;

	const summary = await summarizeTurns(oldTurns, config, signal);
	if (!summary) return;

	const summaryMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: summary }],
		stopReason: "end",
	};

	const kept = turns.slice(-keep).flat();
	context.messages = [summaryMessage, ...kept, ...tail];

	emit({
		type: "context_compressed",
		beforeTokens,
		afterTokens: estimateContextTokens(context),
		keptTurns: kept.length,
		summary,
	});
}
