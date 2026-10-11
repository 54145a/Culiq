export interface ModelsProvider {
	type: "openai" | "anthropic";
	apiKey: string;
	baseUrl: string;
}

export async function listModels(provider: ModelsProvider): Promise<string[]> {
	const fallback = provider.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
	const base = (provider.baseUrl || fallback).replace(/\/+$/, "");
	const url = provider.type === "anthropic" ? `${base}/v1/models` : `${base}/models`;
	const headers: Record<string, string> = provider.type === "anthropic"
		? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
		: { Authorization: `Bearer ${provider.apiKey}` };
	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
	return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}
