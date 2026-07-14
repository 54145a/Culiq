export type ProviderId = "anthropic" | "openai";
export type ThemePreference = "system" | "light" | "dark";

export interface ProviderConfig {
	id: ProviderId;
	apiKey: string;
	baseUrl: string;
	model: string;
}

export interface CurioSettings {
	version: 1;
	theme: ThemePreference;
	activeProvider: ProviderId;
	providers: Record<ProviderId, ProviderConfig>;
}

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

const STORAGE_KEY = "curio.settings.v1";

export function defaultSettings(): CurioSettings {
	return {
		version: 1,
		theme: "system",
		activeProvider: "openai",
		providers: {
			anthropic: { id: "anthropic", apiKey: "", ...mapDefault("anthropic") },
			openai: { id: "openai", apiKey: "", ...mapDefault("openai") },
		},
	};
}

function mapDefault(id: ProviderId) {
	const d = PROVIDER_DEFAULTS[id];
	return { baseUrl: d.baseUrl, model: d.model };
}

export async function loadSettings(): Promise<CurioSettings> {
	const raw = await chrome.storage.local.get(STORAGE_KEY);
	const stored = raw[STORAGE_KEY] as CurioSettings | undefined;
	if (!stored || stored.version !== 1) return defaultSettings();
	const base = defaultSettings();
	return {
		version: 1,
		theme: isThemePreference(stored.theme) ? stored.theme : base.theme,
		activeProvider: stored.activeProvider ?? base.activeProvider,
		providers: {
			anthropic: { ...base.providers.anthropic, ...stored.providers?.anthropic },
			openai: { ...base.providers.openai, ...stored.providers?.openai },
		},
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
