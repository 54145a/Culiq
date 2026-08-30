/**
 * Authoring types for Culiq custom tools.
 *
 * A custom tool is a single default-exported function `(sandbox) => ToolDefinition`.
 * Reference this module from your tool's JS with `// @ts-check` + JSDoc:
 *
 *   // @ts-check
 *   // @type {import("@culiq/sandbox").CuliqToolFactory}
 *   export default (sandbox) => ({
 *     description: "...",
 *     parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
 *     execute: async ({ q }) => {
 *       const res = await sandbox.fetchUrl("https://example.com?q=" + q, "text");
 *       // res is a ToolResult - extract the text explicitly.
 *       return res.content[0].text;
 *     },
 *   });
 *
 * Every `sandbox.*` bridge method returns a `ToolResult` (never a bare string),
 * so returning one directly is a type error - extract `res.content[0].text`.
 */

/** One piece of a tool result. */
export interface ToolResultContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

/**
 * The structured result returned by every `sandbox.*` bridge call. Carries
 * meta-information (error flag, multiple content parts, content types) so tools
 * can inspect it rather than receiving a flattened string.
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
	/** Standard fetch; resolves to a Response. */
	fetch(input: string | URL | Request, init?: unknown): Promise<Response>;
	/** Bridge to chrome.tabs.* — every method returns a ToolResult. */
	chrome: {
		tabs: {
			query(args: unknown[]): Promise<ToolResult>;
			get(args: unknown[]): Promise<ToolResult>;
			update(args: unknown[]): Promise<ToolResult>;
			create(args: unknown[]): Promise<ToolResult>;
			duplicate(args: unknown[]): Promise<ToolResult>;
			reload(args: unknown[]): Promise<ToolResult>;
			waitForLoad(args: unknown[]): Promise<ToolResult>;
		};
		windows: {
			get(args: unknown[]): Promise<ToolResult>;
			update(args: unknown[]): Promise<ToolResult>;
		};
	};
	/** Evaluate JS in a tab. Returns a ToolResult. */
	evalInTab(args: unknown[]): Promise<ToolResult>;
	evalInAllFrames(args: unknown[]): Promise<ToolResult>;
	readDom(args: unknown[]): Promise<ToolResult>;
	click(args: unknown[]): Promise<ToolResult>;
	type(args: unknown[]): Promise<ToolResult>;
	navigate(args: unknown[]): Promise<ToolResult>;
	query(args: unknown[]): Promise<ToolResult>;
	useSkill(args: unknown[]): Promise<ToolResult>;
	fetchUrl(args: unknown[]): Promise<ToolResult>;
	listTabs(args: unknown[]): Promise<ToolResult>;
	switchTab(args: unknown[]): Promise<ToolResult>;
	reloadTab(args: unknown[]): Promise<ToolResult>;
	subtask(args: unknown[]): Promise<ToolResult>;
	docs(args: unknown[]): Promise<ToolResult>;
}

/** The definition a custom-tool factory returns. `execute` must return a string. */
export interface ToolDefinition {
	description: string;
	parameters: Record<string, unknown>;
	executionMode?: "parallel" | "sequential";
	execute(input: Record<string, unknown>): string | Promise<string>;
}

/** A custom tool: a single function that receives the sandbox and returns its definition. */
export type CuliqToolFactory = (sandbox: CuliqSandbox) => ToolDefinition;
