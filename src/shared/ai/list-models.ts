export interface ModelsProvider {
	type: "openai" | "anthropic";
	apiKey: string;
	baseUrl: string;
}

/** Fields parsed out of a `GET /models` entry that the settings UI can use. */
export interface RemoteModelInfo {
	/** API model name (`data[].id`). */
	id: string;
	/** Advertised context window in tokens, when the endpoint reports it
	 *  (`context_length` on OpenRouter, `context_window` on Groq, ...). */
	contextLength?: number;
}

interface RawModelEntry {
	id?: unknown;
	context_length?: unknown;
	context_window?: unknown;
}

function optionalContextLength(...values: Array<unknown>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return undefined;
}

export async function listModels(provider: ModelsProvider): Promise<RemoteModelInfo[]> {
	const fallback = provider.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
	const base = (provider.baseUrl || fallback).replace(/\/+$/, "");
	const url = provider.type === "anthropic" ? `${base}/v1/models` : `${base}/models`;
	const headers: Record<string, string> = provider.type === "anthropic"
		? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
		: { Authorization: `Bearer ${provider.apiKey}` };
	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as { data?: RawModelEntry[] };
	return (body.data ?? [])
		.map((entry): RemoteModelInfo | null => {
			const id = entry.id;
			if (typeof id !== "string" || id.length === 0) return null;
			const contextLength = optionalContextLength(entry.context_length, entry.context_window);
			return contextLength ? { id, contextLength } : { id };
		})
		.filter((m): m is RemoteModelInfo => m !== null);
}
