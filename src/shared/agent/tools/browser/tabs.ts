import { getActiveTab } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "../../types";
import { waitForTabComplete } from "./wait";

export const listTabsTool: AgentTool = {
	name: "list_tabs",
	description: CAPABILITY_INFO.list_tabs.description,
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

export const switchTabTool: AgentTool = {
	name: "switch_tab",
	description: CAPABILITY_INFO.switch_tab.description,
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

export const reloadTabTool: AgentTool = {
	name: "reload_tab",
	description: CAPABILITY_INFO.reload_tab.description,
	parameters: {
		type: "object",
		properties: {
			tabId: { type: "number", description: "Tab id to reload. Defaults to the active tab." },
			bypassCache: { type: "boolean", description: "Bypass the cache (hard reload). Default false." },
			waitForLoad: { type: "boolean", description: "Wait for the page to finish loading. Default true." },
		},
		additionalProperties: false,
	},
	async execute(args, signal) {
		let tabId: number | undefined;
		if (args.tabId !== undefined) {
			tabId = Number(args.tabId);
		} else {
			tabId = (await getActiveTab()).id;
		}
		if (tabId === undefined || !Number.isInteger(tabId)) throw new Error("Invalid tabId.");

		await chrome.tabs.reload(tabId, { bypassCache: Boolean(args.bypassCache) });
		if (args.waitForLoad !== false) await waitForTabComplete(tabId, signal);

		const tab = await chrome.tabs.get(tabId);
		return {
			content: [
				{
					type: "text",
					text:
						`reloaded tab [${tabId}]${args.bypassCache ? " (bypass cache)" : ""}\n` +
						`url: ${tab.url ?? "(unknown)"}\nstatus: ${tab.status ?? "?"}`,
				},
			],
		};
	},
};

export const tabsTools: AgentTool[] = [listTabsTool, switchTabTool, reloadTabTool];
