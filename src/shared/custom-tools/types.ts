import type { AgentTool } from "../agent/types";

export type CustomToolSource = "builtin" | "user";

/** Metadata for a custom tool (no executable code). Cached in culiq-tool.meta.json. */
export interface CustomToolMeta {
	/** Package name (also the OPFS directory name). */
	name: string;
	/** Individual tool name within the package. For single-tool packages, equals `name`. */
	toolName: string;
	description: string;
	parameters: Record<string, unknown>;
	source: CustomToolSource;
	executionMode?: "parallel" | "sequential";
	/** Index within the package's `tools` array. -1 for single-tool packages. */
	toolIndex: number;
}

/** A custom tool together with its executable artifact (a JS function-expression source string). */
export interface SavedCustomTool extends CustomToolMeta {
	artifact: string;
}

export type { AgentTool };
