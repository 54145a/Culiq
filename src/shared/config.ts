import { CAPABILITY_INFO, type Capability } from "./agent/system-prompt";

export type ProviderId = "anthropic" | "openai";
export type ThemePreference = "system" | "light" | "dark";
export type SearchEngineId = "bing";
export type { Capability };

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

const CULIQ_SETTINGS_VERSION = 4;

export interface CuliqSettings {
	version: typeof CULIQ_SETTINGS_VERSION;
	theme: ThemePreference;
	activeProvider: ProviderId;
	providers: Record<ProviderId, ProviderConfig>;
	capabilities: Capability[];
	contextManagement: ContextManagementConfig;
	/** Search engine used by the `search` tool. */
	searchEngine: SearchEngineId;
	/** Model name for the subtask tool's sub-agent. Empty = use the main model. */
	subAgentModel: string;
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

const STORAGE_KEY = `culiq.settings.v${CULIQ_SETTINGS_VERSION}`;

export function defaultSettings(): CuliqSettings {
	return {
		version: CULIQ_SETTINGS_VERSION,
		theme: "system",
		activeProvider: "openai",
		providers: {
			anthropic: { id: "anthropic", apiKey: "", ...mapDefault("anthropic") },
			openai: { id: "openai", apiKey: "", ...mapDefault("openai") },
		},
		capabilities: Object.keys(CAPABILITY_INFO) as Capability[],
		contextManagement: { ...CONTEXT_MANAGEMENT_DEFAULTS },
		searchEngine: "bing",
		subAgentModel: "",
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
	subAgentModel?: unknown;
}

export async function loadSettings(): Promise<CuliqSettings> {
	const raw = await chrome.storage.local.get(STORAGE_KEY);
	const stored = raw[STORAGE_KEY] as StoredSettings | undefined;
	if (!stored || (stored.version !== 2 && stored.version !== 3 && stored.version !== 4)) return defaultSettings();
	const base = defaultSettings();
	return {
		version: CULIQ_SETTINGS_VERSION,
		theme: isThemePreference(stored.theme) ? stored.theme : base.theme,
		activeProvider: stored.activeProvider ?? base.activeProvider,
		providers: {
			anthropic: { ...base.providers.anthropic, ...stored.providers?.anthropic },
			openai: { ...base.providers.openai, ...stored.providers?.openai },
		},
		capabilities: stored.capabilities ?? base.capabilities,
		contextManagement: { ...base.contextManagement, ...stored.contextManagement },
		searchEngine: stored.searchEngine === "bing" ? "bing" : base.searchEngine,
		subAgentModel: typeof stored.subAgentModel === "string" ? stored.subAgentModel : base.subAgentModel,
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

export function getActiveProvider(settings: CuliqSettings): ProviderConfig {
	return settings.providers[settings.activeProvider];
}
