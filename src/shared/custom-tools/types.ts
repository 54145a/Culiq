import type { AgentTool } from "../agent/types";

export type CustomToolSource = "builtin" | "user";

/** Metadata for a custom tool (no executable code). Mirrors `culiq-tool.json`. */
export interface CustomToolMeta {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	source: CustomToolSource;
	executionMode?: "parallel" | "sequential";
}

/** A custom tool together with its executable artifact (a JS function-expression source string). */
export interface SavedCustomTool extends CustomToolMeta {
	artifact: string;
}

export type { AgentTool };
