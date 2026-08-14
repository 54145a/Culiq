import type { AgentTool } from "../../types";

export const switchTabTool: AgentTool = {
	name: "switch_tab",
	description:
		"Activate a browser tab by id (from list_tabs) and focus its window. The following tools then operate on that tab as the active tab.",
	parameters: {
		type: "object",
		properties: {
			tabId: { type: "number", description: "Tab id to activate." },
		},
		required: ["tabId"],
		additionalProperties: false,
	},
	async execute(args) {
		const tabId = Number(args.tabId);
		if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer.");

		const tab = await chrome.tabs.get(tabId);
		await chrome.tabs.update(tabId, { active: true });
		if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
		return {
			content: [
				{
					type: "text",
					text: `switched to tab [${tabId}]: ${tab.title ?? "(no title)"}\n${tab.url ?? "(no url)"}`,
				},
			],
		};
	},
};
