
export type ProviderId = "anthropic" | "openai";
export type ThemePreference = "system" | "light" | "dark";
export type SearchEngineId = "bing";

/** Every tool the agent can toggle. The description here is the canonical copy. */
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
	| "search"
	| "noop";

/**
 * Single source of truth for tool descriptions. The system-prompt capabilities
 * block and every tool definition import from here — no separate copies.
 */
export const CAPABILITY_INFO: Record<Capability, { description: string }> = {
	navigate: {
		description:
			"Open a URL in the active tab (or a new tab) and wait for it to finish loading. Use this when the user asks to 'go to' or 'open' a site.",
	},
	read_dom: {
		description:
			"Read page content. Modes: `text` (innerText, default; best for content), `html` (raw markup; only when attributes matter), `outline` (structural overview of headings/links/forms/landmarks; best when orienting yourself on a new page). Optionally narrow with a CSS selector.",
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
			"Run JavaScript in a restricted sandbox worker hosted in the panel's hidden iframe. Exposed APIs (see the `sandbox` type declarations in the system prompt; `sandbox.docs(name)` returns details): `sandbox.fs.{read,write,list,delete,mkdir}` over OPFS (relative paths, no '..'), `sandbox.fetch(url, init)` (extension-origin, CORS-free), a chrome bridge `sandbox.chrome.tabs.{query,get,update,reload,waitForLoad}` and `sandbox.chrome.windows.{get,update}` (whitelisted, non-destructive), and `sandbox.evalInTab(tabId, world, code)` to run JS in a page. No DOM and no direct chrome.* inside the worker; bridge calls are proxied through the background and validated. State persists within the turn. Top-level await supported; `return X` to send a value back.",
	},
	search: {
		description:
			"Search the web using the configured search engine (Settings → Search engine, default Bing). Always opens the results in a new tab — never operates on the current page. Extracts the organic result list and closes the tab. Use this for quick web searches instead of navigating to a search engine manually.",
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

export interface ProviderConfig {
	id: ProviderId;
	apiKey: string;
	baseUrl: string;
	model: string;
}

const CURIO_SETTINGS_VERSION = 4;

export interface CurioSettings {
	version: typeof CURIO_SETTINGS_VERSION;
	theme: ThemePreference;
	activeProvider: ProviderId;
	providers: Record<ProviderId, ProviderConfig>;
	capabilities: Capability[];
	contextManagement: ContextManagementConfig;
	/** Search engine used by the `search` tool. */
	searchEngine: SearchEngineId;
}

export const CONTEXT_MANAGEMENT_DEFAULTS: ContextManagementConfig = {
	enabled: true,
	thresholdRatio: 0.7,
	keepTurns: 4,
	windowOverride: undefined,
};

export const PROVIDER_DEFAULTS: Record<ProviderId, { label: string; baseUrl: string; model: string }> = {
	anthropic: {
		label: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		model: "claude-sonnet-4-5-20250929",
	},
	openai: {
		label: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
	},
};

const STORAGE_KEY = `curio.settings.v${CURIO_SETTINGS_VERSION}`;

export function defaultSettings(): CurioSettings {
	return {
		version: CURIO_SETTINGS_VERSION,
		theme: "system",
		activeProvider: "openai",
		providers: {
			anthropic: { id: "anthropic", apiKey: "", ...mapDefault("anthropic") },
			openai: { id: "openai", apiKey: "", ...mapDefault("openai") },
		},
		capabilities: Object.keys(CAPABILITY_INFO) as Capability[],
		contextManagement: { ...CONTEXT_MANAGEMENT_DEFAULTS },
		searchEngine: "bing",
	};
}

function mapDefault(id: ProviderId) {
	const d = PROVIDER_DEFAULTS[id];
	return { baseUrl: d.baseUrl, model: d.model };
}

interface StoredSettings {
	version?: number;
	theme?: unknown;
	activeProvider?: ProviderId;
	providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>;
	capabilities?: Capability[];
	contextManagement?: Partial<ContextManagementConfig>;
	searchEngine?: unknown;
}

export async function loadSettings(): Promise<CurioSettings> {
	const raw = await chrome.storage.local.get(STORAGE_KEY);
	const stored = raw[STORAGE_KEY] as StoredSettings | undefined;
	if (!stored || (stored.version !== 2 && stored.version !== 3 && stored.version !== 4)) return defaultSettings();
	const base = defaultSettings();
	return {
		version: CURIO_SETTINGS_VERSION,
		theme: isThemePreference(stored.theme) ? stored.theme : base.theme,
		activeProvider: stored.activeProvider ?? base.activeProvider,
		providers: {
			anthropic: { ...base.providers.anthropic, ...stored.providers?.anthropic },
			openai: { ...base.providers.openai, ...stored.providers?.openai },
		},
		capabilities: stored.capabilities ?? base.capabilities,
		contextManagement: { ...base.contextManagement, ...stored.contextManagement },
		searchEngine: stored.searchEngine === "bing" ? "bing" : base.searchEngine,
	};
}

export async function saveSettings(settings: CurioSettings): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

export async function saveTheme(theme: Exclude<ThemePreference, "system">): Promise<void> {
	const settings = await loadSettings();
	await saveSettings({ ...settings, theme });
}

function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

export function getActiveProvider(settings: CurioSettings): ProviderConfig {
	return settings.providers[settings.activeProvider];
}
