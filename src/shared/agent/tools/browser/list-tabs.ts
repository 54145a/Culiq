import type { AgentTool } from "../../types";

export const listTabsTool: AgentTool = {
	name: "list_tabs",
	description:
		"List all open browser tabs with their id, url, title, window id, and active state. Use this to orient yourself when the task spans multiple tabs, then switch with switch_tab.",
	parameters: {
		type: "object",
		properties: {
			max: { type: "number", description: "Max tabs to return. Default 20." },
		},
		additionalProperties: false,
	},
	async execute(args) {
		const max = typeof args.max === "number" ? Math.max(1, Math.floor(args.max)) : 20;
		const tabs = await chrome.tabs.query({});
		const rows = tabs
			.filter((t) => t.url && !/^chrome(?:-extension)?:\/\//.test(t.url))
			.slice(0, max)
			.map(
				(t) =>
					`[${t.id}] ${t.active ? "ACTIVE " : ""}window=${t.windowId} — ${t.title ?? "(no title)"}\n    ${t.url}`,
			);
		const total = tabs.length;
		return {
			content: [{ type: "text", text: `open tabs: ${total} (showing ${rows.length})\n\n${rows.join("\n")}` }],
		};
	},
};
