import type { ProviderId } from "../config";

export type StopReason = "end" | "toolUse" | "length" | "error" | "aborted";

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	mediaType: "image/png";
	encoding: "base64";
	data: string;
}

export type ToolResultContent = TextContent | ImageContent;

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	signature?: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
	role: "user";
	content: string | TextContent[];
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	stopReason: StopReason;
	errorMessage?: string;
	usage?: { inputTokens: number; outputTokens: number };
	reasoningContent?: string;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	content: ToolResultContent[];
	isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Model {
	id: string;
	provider: ProviderId;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export interface StreamOptions {
	apiKey: string;
	baseUrl?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
}

export type StreamEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; argsDelta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; partial: AssistantMessage }
	| { type: "usage"; usage: { inputTokens: number; outputTokens: number }; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; error: string; message: AssistantMessage };
