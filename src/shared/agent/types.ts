import type { AssistantMessage, Message, TextContent, Tool, ToolResultContent, ToolResultMessage } from "../ai/types";
import type { ContextManagementConfig } from "../config";

export type ProviderId = string;
export interface AgentToolResult {
	content: ToolResultContent[];
	isError?: boolean;
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
	execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult>;
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
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start"; turnIndex: number }
	| { type: "context_sent"; text: string }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; message: AssistantMessage; delta: { kind: "text"; contentIndex: number; text: string } }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolDisplayResult;
			isError: boolean;
	  }
	| { type: "turn_end"; assistantMessage: AssistantMessage; toolResults: ToolResultMessage[] }
	| {
			type: "context_compressed";
			beforeTokens: number;
			afterTokens: number;
			keptTurns: number;
			summary: string;
	  }
	| { type: "agent_end"; messages: Message[]; stopReason: "end" | "max_turns" | "error" | "aborted"; errorMessage?: string };

export function toolToLlmSpec(tool: AgentTool): Tool {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
