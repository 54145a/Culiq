/**
 * Smoke test: validates the exact MCP integration path Curio relies on —
 * `@ai-sdk/mcp` createMCPClient over Streamable HTTP (initialize, tools/list,
 * tools/call, close) against a minimal in-process MCP server.
 *
 * Run: node scripts/mcp-smoke.mjs
 */
import { createMCPClient } from "@ai-sdk/mcp";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

let nextId = 1;
const sessionId = randomUUID();
const tools = [
	{
		name: "echo",
		description: "Echo the input back.",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
];

const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		const body = raw ? JSON.parse(raw) : {};
		const withSession = (status, payload) => {
			res.writeHead(status, {
				"content-type": "application/json",
				...(req.headers["mcp-session-id"] === undefined ? { "mcp-session-id": sessionId } : {}),
			});
			res.end(JSON.stringify(payload));
		};
		if (!raw) {
			withSession(202, {});
			return;
		}
		if (body.id === undefined) {
			// notification (initialized) -> 202 Accepted
			withSession(202, {});
			return;
		}
		switch (body.method) {
			case "initialize":
				withSession(200, {
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "smoke-server", version: "1.0.0" },
					},
				});
				break;
			case "tools/list":
				withSession(200, { jsonrpc: "2.0", id: body.id, result: { tools } });
				break;
			case "tools/call":
				withSession(200, {
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: `echo: ${body.params?.arguments?.text}` }], isError: false },
				});
				break;
			case "ping":
				withSession(200, { jsonrpc: "2.0", id: body.id, result: {} });
				break;
			default:
				withSession(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `no method ${body.method}` } });
		}
	});
});

await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/mcp`;

const client = await createMCPClient({ transport: { type: "http", url }, clientName: "curio" });
try {
	if (client.serverInfo.name !== "smoke-server") throw new Error(`bad serverInfo: ${client.serverInfo.name}`);
	const listed = await client.listTools();
	const names = listed.tools.map((t) => t.name);
	if (names.join(",") !== "echo") throw new Error(`bad tools: ${names}`);
	const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
	const text = result?.content?.[0]?.text;
	if (text !== "echo: hi") throw new Error(`bad call result: ${text}`);
	console.log("mcp smoke OK:", url, "->", client.serverInfo.name, names.join(","), "=>", text);
} finally {
	await client.close();
	server.close();
}
