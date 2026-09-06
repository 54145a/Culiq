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
 *       const result = await sandbox.fetchUrl({ url: "https://example.com?q=" + q });
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

// ── Shared enums ────────────────────────────────────────────────────────────

/** Output mode for readDom / fetchUrl. */
export type ReadDomMode = "markdown" | "html" | "readable_html" | "outline";

/** Whether to close or keep open the tab after fetchUrl. */
export type AfterLoad = "close" | "open";

/** JS world for evalInTab / evalInAllFrames. */
export type EvalWorld = "isolated" | "main";

/** Execution mode for custom tools. */
export type ExecutionMode = "parallel" | "sequential";

// ── Response types ──────────────────────────────────────────────────────────

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

// ── Sandbox interface ───────────────────────────────────────────────────────

export interface CuliqSandbox {
	// ── Filesystem (opfs-tools style) ─────────────────────────────────────────

	/** Access a file. Returns { text(), remove() }. */
	file(path: string): {
		text(): Promise<string>;
		remove(): Promise<void>;
	};

	/** Access a directory. Returns { children(), remove(), create() }. */
	dir(path: string): {
		children(): Promise<Array<{ name: string; kind: string }>>;
		remove(): Promise<void>;
		create(): Promise<void>;
	};

	/** Write a string to a file. */
	write(path: string, content: string): Promise<void>;

	/** Recursively list all files and directories under a path. */
	tree(path?: string): Promise<string>;

	// ── Fetch (CORS-free via extension context) ─────────────────────────────

	/** Fetch a URL with CORS-free access. Returns { status, ok, headers, text(), json() }. */
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

	/**
	 * Evaluate JS in a tab. Returns the eval result as a string.
	 * @param options.tabId - Tab to evaluate in.
	 * @param options.world - "isolated" (default) or "main".
	 * @param options.code - JS code to evaluate.
	 */
	evalInTab(options: { tabId: number; world?: EvalWorld; code: string }): Promise<string>;

	/** Evaluate JS in every frame of a tab. Returns one entry per frame. */
	evalInAllFrames(options: { tabId: number; world?: EvalWorld; code: string }): Promise<string>;

	/**
	 * Read DOM content from the active tab.
	 * @param options.mode - Output mode: "markdown" (default), "html", "readable_html", or "outline".
	 * @param options.selector - CSS selector to limit scope.
	 * @param options.maxChars - Truncate output.
	 */
	readDom(options?: { mode?: ReadDomMode; selector?: string; maxChars?: number }): Promise<string>;

	/** Click an element on the active page. */
	click(options: { selector: string; index?: number }): Promise<string>;

	/** Type text into an input on the active page. */
	type(options: { selector: string; text: string; submit?: boolean; clear?: boolean }): Promise<string>;

	/** Navigate to a URL. */
	navigate(options: { url: string; newTab?: boolean; waitForLoad?: boolean }): Promise<string>;

	/** Query elements by CSS selector. */
	query(options: { selector: string; all?: boolean; limit?: number }): Promise<string>;

	/** Use a skill. */
	useSkill(options: { name: string; file?: string; maxChars?: number }): Promise<string>;

	/**
	 * Fetch a URL, load in a tab, and extract content.
	 * @param options.url - The URL to fetch.
	 * @param options.mode - Output mode: "markdown" (default), "html", "readable_html", or "outline".
	 * @param options.maxChars - Truncate output.
	 * @param options.selector - CSS selector to limit content scope.
	 */
	fetchUrl(options: { url: string; mode?: ReadDomMode; maxChars?: number; selector?: string }): Promise<string>;

	/** List open tabs. */
	listTabs(options?: { max?: number }): Promise<string>;

	/** Switch to a tab. */
	switchTab(options: { tabId: number }): Promise<string>;

	/** Reload a tab. */
	reloadTab(options: { tabId: number; bypassCache?: boolean }): Promise<string>;

	/** Run a subtask. */
	subtask(options: { task: string }): Promise<string>;

	/** Get sandbox API docs. */
	docs(options?: { name?: string }): Promise<string>;
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
	executionMode?: ExecutionMode;
	execute(sandbox: CuliqSandbox, input: Record<string, unknown>): string | Promise<string>;
}
