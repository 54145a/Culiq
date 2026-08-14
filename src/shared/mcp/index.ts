import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { AgentTool, AgentToolResult } from "../agent/types";
import { loadMcpServers, type McpServerConfig, type McpTransport } from "./storage";

export { loadMcpServers, saveMcpServers, type McpServerConfig, type McpTransport } from "./storage";

const CONNECTION_TIMEOUT_MS = 10_000;

// The MCP client calls its stored fetch with an arbitrary `this`, which throws
// "Failed to execute 'fetch' on 'Window': Illegal invocation" in Chrome. Bind it
// to the real global so the receiver is always correct (panel and SW alike).
const fetchFn = globalThis.fetch.bind(globalThis);

interface McpSession {
	clients: MCPClient[];
}

/**
 * MCP clients are opened per agent turn (keyed by the turn's AbortSignal) and
 * closed by `closeMcp` in the turn's `finally` block — mirroring the sandbox
 * worker lifecycle. Remote Streamable HTTP only; `<all_urls>` host permission
 * makes CORS a non-issue.
 */
const sessions = new WeakMap<AbortSignal, McpSession>();

function getSession(signal: AbortSignal): McpSession {
	let session = sessions.get(signal);
	if (!session) {
		session = { clients: [] };
		sessions.set(signal, session);
		signal.addEventListener("abort", () => void closeMcp(signal), { once: true });
	}
	return session;
}

/** Close all MCP clients for a turn (idempotent). */
export async function closeMcp(signal: AbortSignal): Promise<void> {
	const session = sessions.get(signal);
	if (!session) return;
	sessions.delete(signal);
	await Promise.allSettled(session.clients.map((client) => client.close()));
}

/** Connect to a server and report how many tools it exposes. For the settings UI. */
export async function testMcpConnection(
	url: string,
	transport: McpTransport = "http",
): Promise<{ ok: true; serverName: string; toolCount: number } | { ok: false; error: string }> {
	try {
		const client = await createMCPClient({
			transport: { type: transport, url, fetch: fetchFn },
			initializationOptions: { timeout: CONNECTION_TIMEOUT_MS },
		});
		try {
			const { tools } = await client.listTools();
			return { ok: true, serverName: client.serverInfo.name, toolCount: tools.length };
		} finally {
			await client.close();
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Fetch tools from all enabled MCP servers for the current turn. */
export async function createMcpTools(signal: AbortSignal): Promise<AgentTool[]> {
	const servers = (await loadMcpServers()).filter((s) => s.enabled && s.url.trim() !== "");
	if (servers.length === 0) return [];

	const session = getSession(signal);
	const results = await Promise.all(servers.map((server) => connectServer(session, server)));
	return results.flat();
}

async function connectServer(session: McpSession, server: McpServerConfig): Promise<AgentTool[]> {
	try {
		const client = await createMCPClient({
			transport: { type: server.transport, url: server.url.trim(), fetch: fetchFn },
			initializationOptions: { timeout: CONNECTION_TIMEOUT_MS },
			clientName: "curio",
		});
		session.clients.push(client);
		const { tools: definitions } = await client.listTools();
		const prefix = sanitizeName(server.name);
		return definitions.map((def) => mcpTool(prefix, def.name, def.description, def.inputSchema, client));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [connectionErrorTool(server, message)];
	}
}

function mcpTool(
	serverName: string,
	toolName: string,
	description: string | undefined,
	inputSchema: Record<string, unknown>,
	client: MCPClient,
): AgentTool {
	return {
		name: mcpToolName(serverName, toolName),
		description: `[MCP server: ${serverName}] ${description ?? "No description provided."}`,
		parameters: inputSchema,
		async execute(args, signal) {
			const result = (await client.callTool({
				name: toolName,
				arguments: args,
				options: signal ? { signal } : undefined,
			})) as unknown as McpCallResult;
			return { content: callToolContent(result), isError: result.isError };
		},
	};
}

/** Minimal structural view of a callTool result (the SDK type is too loose to use directly). */
interface McpCallResult {
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
	isError?: boolean;
}

function callToolContent(result: McpCallResult): AgentToolResult["content"] {
	const blocks: AgentToolResult["content"] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text ?? "" });
		} else {
			blocks.push({ type: "text", text: JSON.stringify(block) });
		}
	}
	return blocks.length > 0 ? blocks : [{ type: "text", text: "(empty result)" }];
}

/** A diagnostic tool so a broken server surfaces to the LLM instead of failing silently. */
function connectionErrorTool(server: McpServerConfig, message: string): AgentTool {
	return {
		name: mcpToolName(sanitizeName(server.name), "__connection_error"),
		description: `The MCP server "${server.name}" (${server.url}) failed to connect when this session started. Call this tool to retrieve the exact error and report it to the user.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			return {
				content: [{ type: "text", text: `MCP server "${server.name}" connection error:\n${message}` }],
				isError: true,
			};
		},
	};
}

/** Normalize a user-provided server name into a safe tool-name prefix. */
function sanitizeName(name: string): string {
	const cleaned = name
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "mcp";
}

/**
 * OpenAI/Anthropic tool names must match `^[a-zA-Z0-9_-]+$`, so the colon
 * prefix scheme is out. Join server + tool with '-' and strip anything else
 * (MCP tool names may contain colons/dots for nesting).
 */
function mcpToolName(serverName: string, toolName: string): string {
	const server = sanitizeName(serverName);
	const tool = toolName.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return tool ? `${server}-${tool}` : server;
}
