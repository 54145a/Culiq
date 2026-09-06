export type ThemePreference = "system" | "light" | "dark";

/** Every tool the agent can toggle. */
export type Capability =
	| "navigate"
	| "read_dom"
	| "screenshot"
	| "query"
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
			"Open a URL in the active tab (or a new tab) and wait for it to finish loading. Use this when the user asks to 'go to' or 'open' a site.",
	},
	read_dom: {
		description:
			"Read page content. Modes: `text` (innerText, default; best for content), `html` (raw markup; only when attributes matter), `outline` (structural overview of headings/links/forms/landmarks; best when orienting yourself on a new page). Optionally narrow with a CSS selector. Never invent or guess a CSS selector — only pass a selector you have actually observed (e.g. from a prior `query` tool result); a made-up selector will silently match nothing.",
	},
	screenshot: {
		description:
			"Capture the active tab's currently visible viewport for visual analysis. Use it for images, canvas, charts, layout, colors, or visual state; prefer `read_dom` or `query` for text and structure. Scroll and capture again to inspect another area.",
	},
	query: {
		description:
			"Locate elements by CSS selector. Returns tag, id, classes, text, attributes, rect, visibility, and disabled state for up to 10 matches. Use this before click/type to confirm the target exists.",
	},
	click: {
		description: "Click the first element matching a CSS selector. Scrolls into view first.",
	},
	type: {
		description:
			"Type text into an <input>, <textarea>, or contenteditable element. Set `submit: true` to submit the form (or send Enter) after typing.",
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
			"Read the content of a URL. By default (`afterLoad:\"close\"`), opens the page in a new tab, extracts the rendered content, and closes it — a one-shot read best suited for simple text, API responses, or static pages you only need to view once. Set `afterLoad:\"open\"` to keep the tab open after reading, so you can follow up with `read_dom`, `query`, or `click` on the same page; in this mode `mode` supports `\"text\"`, `\"html\"`, and `\"outline\"`. A HEAD request first checks the content type; binary files are refused by default (`probeMime:true`).",
	},
	use_skill: {
		description:
			"Access a skill's files (see <available_skills>): omit `file` for the skill index (truncated instructions + file listing), or pass `file` to read a specific file. Skills encode reusable workflows — browse and read files as needed.",
	},
	sandbox_exec: {
		description:
			"Run JavaScript in a restricted sandbox worker hosted in the panel's hidden iframe. Exposes `sandbox.file(path).text()/.remove()`, `sandbox.dir(path).children()/.remove()/.create()`, `sandbox.write(path, content)`, `sandbox.tree(path)`, and `sandbox.fetch(url)` (CORS-free). Also includes a chrome bridge: `sandbox.chrome.tabs.*`, `sandbox.chrome.windows.*`, `sandbox.readDom`, `sandbox.click`, `sandbox.type`, `sandbox.navigate`, `sandbox.evalInTab`, and more. No DOM and no direct chrome.* inside the worker; all calls are proxied through the background. State persists within the turn. Top-level await supported; `return X` to send a value back.",
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

export interface ProviderConfig {
	id: string;
	name: string;
	type: ProviderType;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	models: string[];
}

const CULIQ_SETTINGS_VERSION = 5;

/** Per-model capability overrides. Keyed by `${providerId}:${modelId}`. */
export interface ModelCapabilityConfig {
	/** Capabilities explicitly turned OFF for this model (e.g. `["screenshot"]`). */
	disabledCapabilities: Capability[];
}

export interface CuliqSettings {
	version: typeof CULIQ_SETTINGS_VERSION;
	theme: ThemePreference;
	providers: ProviderConfig[];
	defaultProviderId: string;
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
	defaultModel: string;
	models: string[];
}> = [
	{
		id: "anthropic",
		name: "Anthropic",
		type: "anthropic",
		baseUrl: "https://api.anthropic.com",
		defaultModel: "claude-sonnet-4-5-20250929",
		models: ["claude-sonnet-4-5-20250929", "claude-haiku-3-5", "claude-3-5-sonnet"],
	},
	{
		id: "openai",
		name: "OpenAI",
		type: "openai",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-4o-mini",
		models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
	},
];

const STORAGE_KEY = `culiq.settings.v${CULIQ_SETTINGS_VERSION}`;

export function defaultSettings(): CuliqSettings {
	return {
		version: CULIQ_SETTINGS_VERSION,
		theme: "system",
		providers: PROVIDER_DEFAULTS.map((d) => ({
			id: d.id,
			name: d.name,
			type: d.type,
			apiKey: "",
			baseUrl: d.baseUrl,
			defaultModel: d.defaultModel,
			models: d.models,
		})),
		defaultProviderId: "openai",
		modelCapabilities: {},
		contextManagement: { ...CONTEXT_MANAGEMENT_DEFAULTS },
		subAgentModel: "",
		disabledTools: [],
	};
}

interface StoredSettings {
	version?: number;
	theme?: unknown;
	activeProvider?: string;
	providers?: Record<string, Partial<ProviderConfig>> | ProviderConfig[];
	defaultProviderId?: string;
	modelCapabilities?: Record<string, ModelCapabilityConfig>;
	contextManagement?: Partial<ContextManagementConfig>;
	subAgentModel?: unknown;
	disabledTools?: unknown;
}

/** Migrate old v2-v4 settings (Record<ProviderId, ProviderConfig>) to v5 (ProviderConfig[]). */
function migrateProviders(stored: StoredSettings, base: CuliqSettings): { providers: ProviderConfig[]; defaultProviderId: string } {
	// New format: array + defaultProviderId — fill in defaults for missing fields
	if (Array.isArray(stored.providers) && typeof stored.defaultProviderId === "string") {
		const merged = stored.providers.map((p) => {
			const def = PROVIDER_DEFAULTS.find((d) => d.id === p.id);
			return {
				id: p.id,
				name: p.name ?? def?.name ?? p.id,
				type: p.type ?? def?.type ?? "openai",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? def?.baseUrl ?? "",
				defaultModel: p.defaultModel ?? def?.defaultModel ?? "",
				models: p.models ?? def?.models ?? [],
			};
		});
		return { providers: merged, defaultProviderId: stored.defaultProviderId };
	}
	// Old format: Record<string, ProviderConfig> + activeProvider
	const oldProviders = stored.providers;
	if (oldProviders && typeof oldProviders === "object" && !Array.isArray(oldProviders)) {
		const providers = Object.entries(oldProviders)
			.filter(([, v]) => v && typeof v === "object")
			.map(([id, v]) => ({
				id,
				name: PROVIDER_DEFAULTS.find((d) => d.id === id)?.name ?? id,
				type: PROVIDER_DEFAULTS.find((d) => d.id === id)?.type ?? "openai",
				apiKey: (v as Partial<ProviderConfig>).apiKey ?? "",
				baseUrl: (v as Partial<ProviderConfig>).baseUrl ?? PROVIDER_DEFAULTS.find((d) => d.id === id)?.baseUrl ?? "",
				defaultModel: PROVIDER_DEFAULTS.find((d) => d.id === id)?.defaultModel ?? "",
				models: PROVIDER_DEFAULTS.find((d) => d.id === id)?.models ?? [],
			}));
		const defaultId = typeof stored.activeProvider === "string" ? stored.activeProvider : "openai";
		return { providers, defaultProviderId: defaultId };
	}
	return { providers: base.providers, defaultProviderId: base.defaultProviderId };
}

export async function loadSettings(): Promise<CuliqSettings> {
	const raw = await chrome.storage.local.get(STORAGE_KEY);
	const stored = raw[STORAGE_KEY] as StoredSettings | undefined;
	if (!stored || stored.version === undefined) return defaultSettings();
	const base = defaultSettings();
	const { providers, defaultProviderId } = migrateProviders(stored, base);
	return {
		version: CULIQ_SETTINGS_VERSION,
		theme: isThemePreference(stored.theme) ? stored.theme : base.theme,
		providers,
		defaultProviderId,
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

export function getDefaultProvider(settings: CuliqSettings): ProviderConfig {
	const def = settings.providers.find((p) => p.id === settings.defaultProviderId);
	if (!def) throw new Error(`Default provider "${settings.defaultProviderId}" not found.`);
	return def;
}
