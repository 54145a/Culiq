export type ThemePreference = "system" | "light" | "dark";

/** Every tool the agent can toggle. */
export type Capability =
	| "navigate"
	| "read_dom"
	| "screenshot"
	| "click"
	| "type"
	| "eval_js"
	| "list_tabs"
	| "switch_tab"
	| "reload_tab"
	| "fetch_url"
	| "use_skill"
	| "sandbox_exec"
	| "subtask"
	| "noop";

/** Single source of truth for tool descriptions. */
export const CAPABILITY_INFO: Record<Capability, { description: string }> = {
	navigate: {
		description:
			"Navigate to a URL. Available via the sandbox bridge. **Requires a `url` parameter**. When the current page is a browser-internal page (chrome://, chrome-extension://), always use `newTab: true`. Waits for the page to load by default (`waitForLoad: true`).",
	},
	read_dom: {
		description:
			"Read page content. Modes: `markdown` (clean Markdown via Defuddle, default), `readable_html` (cleaned HTML via Defuddle), `html` (raw markup; only when attributes matter), `outline` (structural overview with CSS selectors for each element; best when orienting yourself on a new page; may be empty on bare pages with no headings/links/controls — use `markdown` for actual content). Optionally narrow with a CSS selector.",
	},
	screenshot: {
		description:
			"Capture the active tab's currently visible viewport for visual analysis. Use it for images, canvas, charts, layout, colors, or visual state; prefer `read_dom` for text and structure. Scroll and capture again to inspect another area.",
	},
	click: {
		description: "Click the first element matching a CSS selector. Scrolls into view first. If multiple elements match, an error lists all matches so you can use a more specific selector. Obtain selectors from `read_dom` outline mode.",
	},
	type: {
		description:
			"Type text into an <input>, <textarea>, or contenteditable element. Set `submit: true` to submit the form (or send Enter) after typing. Obtain selectors from `read_dom` outline mode.",
	},
	eval_js: {
		description:
			"Execute JavaScript in the active tab. Always set `world` explicitly: use `world: 'main'` for reverse engineering, page globals, framework internals, or fetch/XHR hooks; use `world: 'isolated'` only for DOM-only operations that do not need page JavaScript state. Use `return X` to send a value back. Top-level await is supported.",
	},
	list_tabs: {
		description: "List open browser tabs (id, url, title, active state). Use when the task spans multiple tabs.",
	},
	switch_tab: {
		description:
			"Activate a tab by id from `list_tabs` and focus its window; subsequent tools operate on that tab.",
	},
	reload_tab: {
		description:
			"Reload a tab (default the active tab); `bypassCache: true` forces a hard reload.",
	},
	fetch_url: {
		description:
			"Read the content of a URL. By default, opens the page in a new tab, extracts the rendered content, and keeps the tab open for follow-up tools (`read_dom`, `click`). Set `afterLoad:\"close\"` for one-shot reads that close the tab after extraction. Set `newTab: false` to navigate the current tab instead of opening a new one. Prefer this over `navigate` + `read_dom` when you need to read page content — it combines navigation and content extraction in one step. `mode` supports `\"markdown\"` (default), `\"html\"`, `\"readable_html\"`, and `\"outline\"` (`outline` may be empty on bare pages with no headings/links/controls — use `markdown` for actual content). A HEAD request first checks the content type; binary files are refused by default (`probeMime:true`).",
	},
	use_skill: {
		description:
			"Access a skill's files (see <available_skills>): omit `file` for the skill index (truncated instructions + file listing), or pass `file` to read a specific file. Skills encode reusable workflows — browse and read files as needed.",
	},
	sandbox_exec: {
		description:
			"Run JavaScript in a restricted sandbox worker hosted in the panel's hidden iframe. Exposes `sandbox.file(path).text()/.remove()`, `sandbox.dir(path).children()/.remove()/.create()`, `sandbox.write(path, content)`, `sandbox.tree(path)`, and `sandbox.fetch(url)` (CORS-free). Also includes a chrome bridge: `sandbox.chrome.tabs.*`, `sandbox.chrome.windows.*`, `sandbox.readDom`, `sandbox.click`, `sandbox.type`, `sandbox.navigate`, `sandbox.evalInTab`, and more. No DOM and no direct chrome.* inside the worker; all calls are proxied through the background. Do NOT call multiple sandbox tools concurrently (e.g. via Promise.all) — sandbox tools operate on the same tab and must be called sequentially. For batch operations, write the parallel logic inside the sandbox_exec code itself. State persists within the turn. Top-level await supported; `return X` to send a value back.",
	},
	subtask: {
		description:
			"Delegate a simple, well-defined task (e.g. 'find the submit button', 'summarize the page') to a small sub-agent that runs autonomously using the same browser tools. Use for single-purpose tasks where multi-step tool usage is needed but one model roundtrip would suffice.",
	},
	noop: {
		description: "Echoes input. For testing only.",
	},
};

export interface ContextManagementConfig {
	enabled: boolean;
	/** Fraction of the context window that triggers compression (0-1). */
	thresholdRatio: number;
	/** Recent complete turns kept verbatim when compressing. */
	keepTurns: number;
	/** Optional manual context window size in tokens, overrides auto-detection. */
	windowOverride?: number;
}

export type ProviderType = "openai" | "anthropic";

export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const REASONING_LEVELS: Array<{ value: ReasoningLevel | ""; label: string }> = [
	{ value: "", label: "Default" },
	{ value: "none", label: "Off" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Maximum" },
];

/** Provider = API credentials group. Models are separate. */
export interface ProviderConfig {
	id: string;
	name: string;
	type: ProviderType;
	apiKey: string;
	baseUrl: string;
}

/** A model entry, linked to a provider. */
export interface ModelConfig {
	id: string;
	providerId: string;
	name: string;
	/** Per-model context window override in tokens. If undefined, uses DEFAULT_CONTEXT_WINDOW. */
	contextWindow?: number;
	/** Per-model default reasoning level. If undefined, uses provider default. */
	reasoning?: ReasoningLevel;
}

const CULIQ_SETTINGS_VERSION = 6;

/** Per-model capability overrides. Keyed by model id (e.g. `"openai:gpt-4o"`). */
export interface ModelCapabilityConfig {
	/** Capabilities explicitly turned OFF for this model (e.g. `["screenshot"]`). */
	disabledCapabilities: Capability[];
}

export interface CuliqSettings {
	version: typeof CULIQ_SETTINGS_VERSION;
	theme: ThemePreference;
	providers: ProviderConfig[];
	models: ModelConfig[];
	/** Format: `${providerId}:${modelName}` */
	defaultModelId: string;
	/** Capability overrides per model. The only user-toggleable capability is `screenshot`;
	 * everything else (including sandbox-exposed tools) is always enabled. */
	modelCapabilities: Record<string, ModelCapabilityConfig>;
	contextManagement: ContextManagementConfig;
	subAgentModel: string;
	/** Names of disabled custom tools (e.g. ["bing_search"]). */
	disabledTools: string[];
}

export const CONTEXT_MANAGEMENT_DEFAULTS: ContextManagementConfig = {
	enabled: true,
	thresholdRatio: 0.7,
	keepTurns: 4,
	windowOverride: undefined,
};

export const PROVIDER_DEFAULTS: Array<{
	id: string;
	name: string;
	type: ProviderType;
	baseUrl: string;
}> = [
	{
		id: "anthropic",
		name: "Anthropic",
		type: "anthropic",
		baseUrl: "https://api.anthropic.com",
	},
	{
		id: "openai",
		name: "OpenAI",
		type: "openai",
		baseUrl: "https://api.openai.com/v1",
	},
];

/** Default models shipped with the extension. */
const DEFAULT_MODELS: Array<{ providerId: string; name: string; contextWindow?: number }> = [
	{ providerId: "anthropic", name: "claude-sonnet-4-5-20250929" },
	{ providerId: "anthropic", name: "claude-haiku-3-5" },
	{ providerId: "anthropic", name: "claude-3-5-sonnet" },
	{ providerId: "openai", name: "gpt-4o" },
	{ providerId: "openai", name: "gpt-4o-mini" },
	{ providerId: "openai", name: "gpt-4-turbo" },
];

const STORAGE_KEY = `culiq.settings.v${CULIQ_SETTINGS_VERSION}`;

export function defaultSettings(): CuliqSettings {
	const providers = PROVIDER_DEFAULTS.map((d) => ({
		id: d.id,
		name: d.name,
		type: d.type,
		apiKey: "",
		baseUrl: d.baseUrl,
	}));
	const models = DEFAULT_MODELS.map((m) => ({
		id: `${m.providerId}:${m.name}`,
		providerId: m.providerId,
		name: m.name,
		...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
	}));
	return {
		version: CULIQ_SETTINGS_VERSION,
		theme: "system",
		providers,
		models,
		defaultModelId: "openai:gpt-4o-mini",
		modelCapabilities: {},
		contextManagement: { ...CONTEXT_MANAGEMENT_DEFAULTS },
		subAgentModel: "",
		disabledTools: [],
	};
}

interface StoredSettings {
	version?: number;
	theme?: unknown;
	providers?: ProviderConfig[];
	models?: ModelConfig[];
	defaultModelId?: string;
	modelCapabilities?: Record<string, ModelCapabilityConfig>;
	contextManagement?: Partial<ContextManagementConfig>;
	subAgentModel?: unknown;
	disabledTools?: unknown;
}

export async function loadSettings(): Promise<CuliqSettings> {
	const raw = await chrome.storage.local.get(STORAGE_KEY);
	const stored = raw[STORAGE_KEY] as StoredSettings | undefined;
	if (!stored || stored.version !== CULIQ_SETTINGS_VERSION) return defaultSettings();
	const base = defaultSettings();
	return {
		version: CULIQ_SETTINGS_VERSION,
		theme: isThemePreference(stored.theme) ? stored.theme : base.theme,
		providers: Array.isArray(stored.providers) ? stored.providers : base.providers,
		models: Array.isArray(stored.models) ? stored.models : base.models,
		defaultModelId: typeof stored.defaultModelId === "string" ? stored.defaultModelId : base.defaultModelId,
		modelCapabilities: stored.modelCapabilities ?? {},
		contextManagement: { ...base.contextManagement, ...stored.contextManagement },
		subAgentModel: typeof stored.subAgentModel === "string" ? stored.subAgentModel : base.subAgentModel,
		disabledTools: Array.isArray(stored.disabledTools) ? stored.disabledTools : [],
	};
}

export async function saveSettings(settings: CuliqSettings): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

export async function saveTheme(theme: Exclude<ThemePreference, "system">): Promise<void> {
	const settings = await loadSettings();
	await saveSettings({ ...settings, theme });
}

function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

/** Resolve a defaultModelId string into its provider and model configs. */
export function resolveDefaultModel(settings: CuliqSettings): { provider: ProviderConfig; model: ModelConfig } | null {
	const model = settings.models.find((m) => m.id === settings.defaultModelId);
	if (!model) return null;
	const provider = settings.providers.find((p) => p.id === model.providerId);
	if (!provider) return null;
	return { provider, model };
}

/** Resolve a model id (bare name or `provider:model`) to its ModelConfig. */
export function resolveModelId(modelId: string, settings: CuliqSettings): { provider: ProviderConfig; model: ModelConfig } | null {
	if (modelId.includes(":")) {
		const model = settings.models.find((m) => m.id === modelId);
		if (!model) return null;
		const provider = settings.providers.find((p) => p.id === model.providerId);
		return provider ? { provider, model } : null;
	}
	// Bare model name — returns first match across all providers
	const model = settings.models.find((m) => m.name === modelId);
	if (!model) return null;
	const provider = settings.providers.find((p) => p.id === model.providerId);
	return provider ? { provider, model } : null;
}
