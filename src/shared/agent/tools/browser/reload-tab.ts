import { getActiveTab } from "@shared/transport/tab-rpc";
import type { AgentTool } from "../../types";
import { waitForTabComplete } from "./wait";

export const reloadTabTool: AgentTool = {
	name: "reload_tab",
	description:
		"Reload a tab (default: the active tab). Use `bypassCache: true` to force a hard reload. Optionally wait for the page to finish loading before returning.",
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
