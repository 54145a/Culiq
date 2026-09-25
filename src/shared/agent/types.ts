import type { AssistantMessage, Message, TextContent, Tool, ToolResultContent, ToolResultMessage } from "../ai/types";
import type { ContextManagementConfig } from "../config";

export type ProviderId = string;
export interface AgentToolResult {
	content: ToolResultContent[];
	isError?: boolean;
	/** Optional identifier returned by navigate to pass the tab ID to fetch_url. */
	toolCallId?: string;
}

export interface AgentToolDisplayResult {
	content: TextContent[];
	isError?: boolean;
}

export type AgentToolExecutionMode = "parallel" | "sequential";

export interface AgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	executionMode?: AgentToolExecutionMode;
	/** True for user/built-in custom tools loaded from the sandbox-tool pipeline. Always enabled. */
	custom?: boolean;
	execute(args: Record<string, unknown>, signal?: AbortSignal, emit?: AgentEventSink): Promise<AgentToolResult>;
}

export interface AgentContext {
	systemPrompt?: string;
	messages: Message[];
	tools: AgentTool[];
}

export interface AgentLoopConfig {
	model: { id: string; provider: string };
	maxTokens?: number;
	temperature?: number;
	maxTurns?: number;
	contextManagement?: ContextManagementConfig;
	contextWindow?: number;
	sessionId?: string;
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

type WithSubtaskId<T> = T & { subtaskId?: string };

export type AgentEvent =
	| WithSubtaskId<{ type: "agent_start" }>
	| WithSubtaskId<{ type: "turn_start"; turnIndex: number }>
	| WithSubtaskId<{ type: "context_sent"; text: string }>
	| WithSubtaskId<{ type: "message_start"; message: Message }>
	| WithSubtaskId<{
			type: "message_update";
			message: AssistantMessage;
			delta: { kind: "text"; contentIndex: number; text: string } | { kind: "reasoning"; id: string; text: string; signature?: string };
	  }>
	| WithSubtaskId<{ type: "message_end"; message: Message }>
	| WithSubtaskId<{ type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }>
	| WithSubtaskId<{
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolDisplayResult;
			isError: boolean;
	  }>
	| WithSubtaskId<{ type: "turn_end"; assistantMessage: AssistantMessage; toolResults: ToolResultMessage[] }>
	| WithSubtaskId<{ type: "message_usage"; usage: { inputTokens: number; outputTokens: number }; cumulative: { inputTokens: number; outputTokens: number } }>
	| WithSubtaskId<{ type: "context_compressed"; summary: string }>
	| WithSubtaskId<{ type: "agent_end"; messages: Message[]; stopReason: "end" | "max_turns" | "error" | "aborted"; errorMessage?: string }>;

export type AgentEventSink = (event: AgentEvent) => void;

export function toolToLlmSpec(tool: AgentTool): Tool {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
