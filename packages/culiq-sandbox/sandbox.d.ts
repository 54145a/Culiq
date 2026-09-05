/**
 * Authoring types for Culiq custom tools.
 *
 * A custom tool is a default-exported plain object with `name`, `description`,
 * `parameters`, and `execute`. Reference this module from your tool's JS with
 * `// @ts-check` + JSDoc:
 *
 *   // @ts-check
 *   /** @type {import("@culiq/sandbox").ToolDefinition} *\/
 *   export default {
 *     name: "my_tool",
 *     description: "...",
 *     parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
 *     execute: async (sandbox, { q }) => {
 *       const result = await sandbox.fetchUrl("https://example.com?q=" + q, "text");
 *       return result;  // sandbox methods return strings
 *     },
 *   };
 *
 * The sandbox is NOT available at module evaluation time - only inside `execute`.
 * Do not call sandbox methods in the top-level object literal.
 *
 * Sandbox bridge methods return strings (via toolText), not ToolResult objects.
 * Only `sandbox.fetch` returns a SandboxResponse.
 */

/** Minimal Response type (avoids requiring DOM lib). */
export interface SandboxResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	readonly headers: Headers;
	text(): Promise<string>;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal Headers type. */
export interface Headers {
	get(name: string): string | null;
}

/** Minimal Request type. */
export interface SandboxRequest {
	readonly url: string;
	readonly method: string;
}

/** One piece of a tool result. */
export interface ToolResultContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/**
 * The structured result returned by some sandbox bridge calls.
 * Note: most bridge methods return strings, not ToolResult.
 */
export interface ToolResult {
	content: ToolResultContent[];
	isError?: boolean;
}

export interface CuliqSandbox {
	/** Filesystem over OPFS, relative paths only. */
	fs: {
		read(path: string): Promise<string>;
		write(path: string, content: string): Promise<void>;
		list(path: string): Promise<string[]>;
		delete(path: string): Promise<void>;
		mkdir(path: string): Promise<void>;
	};
	/** Standard fetch; resolves to a SandboxResponse. */
	fetch(input: string | SandboxRequest, init?: unknown): Promise<SandboxResponse>;
	/** Bridge to chrome.tabs.* — returns raw chrome API results. */
	chrome: {
		tabs: {
			query(args: unknown[]): Promise<unknown[]>;
			get(args: unknown[]): Promise<unknown>;
			update(args: unknown[]): Promise<unknown>;
			create(args: unknown[]): Promise<unknown>;
			duplicate(args: unknown[]): Promise<unknown>;
			reload(args: unknown[]): Promise<unknown>;
			waitForLoad(args: unknown[]): Promise<string>;
		};
		windows: {
			get(args: unknown[]): Promise<unknown>;
			update(args: unknown[]): Promise<unknown>;
		};
	};
	/** Evaluate JS in a tab. Returns the eval result as a string. */
	evalInTab(args: unknown[]): Promise<string>;
	evalInAllFrames(args: unknown[]): Promise<string>;
	/** Read DOM content. Returns extracted text/html/outline as a string. */
	readDom(args: unknown[]): Promise<string>;
	/** Click an element. Returns status as a string. */
	click(args: unknown[]): Promise<string>;
	/** Type text into an element. Returns status as a string. */
	type(args: unknown[]): Promise<string>;
	/** Navigate to a URL. Returns navigation status as a string. */
	navigate(args: unknown[]): Promise<string>;
	/** Query elements. Returns matching elements as a string. */
	query(args: unknown[]): Promise<string>;
	/** Use a skill. Returns skill output as a string. */
	useSkill(args: unknown[]): Promise<string>;
	/** Fetch a URL and extract content. Returns extracted text as a string. */
	fetchUrl(args: unknown[]): Promise<string>;
	/** List open tabs. Returns tab list as a string. */
	listTabs(args: unknown[]): Promise<string>;
	/** Switch to a tab. Returns status as a string. */
	switchTab(args: unknown[]): Promise<string>;
	/** Reload a tab. Returns status as a string. */
	reloadTab(args: unknown[]): Promise<string>;
	/** Run a subtask. Returns result as a string. */
	subtask(args: unknown[]): Promise<string>;
	/** Get sandbox API docs. Returns docs as a string. */
	docs(args: unknown[]): Promise<string>;
}

/**
 * The definition a custom tool exports. `execute` receives the sandbox as its
 * first argument and the agent-supplied input as its second. It must return a
 * string.
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	executionMode?: "parallel" | "sequential";
	execute(sandbox: CuliqSandbox, input: Record<string, unknown>): string | Promise<string>;
}
