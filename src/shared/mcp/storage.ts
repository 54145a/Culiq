/** Persistence for MCP server configs in chrome.storage.local. */

export interface McpServerConfig {
	/** Unique server id; used as the tool-name prefix. */
	name: string;
	url: string;
	enabled: boolean;
}

const STORAGE_KEY = "curio.mcp.servers";

export async function loadMcpServers(): Promise<McpServerConfig[]> {
	const raw = await chrome.storage.local.get(STORAGE_KEY);
	const list = raw[STORAGE_KEY];
	if (!Array.isArray(list)) return [];
	return list.filter(isMcpServerConfig);
}

export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: servers });
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as McpServerConfig).name === "string" &&
		typeof (value as McpServerConfig).url === "string" &&
		typeof (value as McpServerConfig).enabled === "boolean"
	);
}
