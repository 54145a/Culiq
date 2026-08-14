import { SYSTEM_PROMPT_PARTS } from "./agent/system-prompt";

export type ProviderId = "anthropic" | "openai";
export type ThemePreference = "system" | "light" | "dark";
export type Capability = keyof typeof SYSTEM_PROMPT_PARTS.capabilities;

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

const CURIO_SETTINGS_VERSION = 3;

export interface CurioSettings {
	version: typeof CURIO_SETTINGS_VERSION;
	theme: ThemePreference;
	activeProvider: ProviderId;
	providers: Record<ProviderId, ProviderConfig>;
	capabilities: Capability[];
	contextManagement: ContextManagementConfig;
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
		capabilities: Object.keys(SYSTEM_PROMPT_PARTS.capabilities) as Capability[],
		contextManagement: { ...CONTEXT_MANAGEMENT_DEFAULTS },
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
}

export async function loadSettings(): Promise<CurioSettings> {
	const raw = await chrome.storage.local.get(STORAGE_KEY);
	const stored = raw[STORAGE_KEY] as StoredSettings | undefined;
	if (!stored || (stored.version !== 2 && stored.version !== 3)) return defaultSettings();
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
