import { getActiveTab } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/agent/system-prompt";
import type { AgentTool } from "../../types";
import { waitForTabComplete } from "./wait";

export const navigateTool: AgentTool = {
	name: "navigate",
	description: CAPABILITY_INFO.navigate.description,
	parameters: {
		type: "object",
		properties: {
			url: {
				type: "string",
				description: "Absolute URL with scheme, e.g. 'https://example.com/path'. http(s) only.",
			},
			newTab: {
				type: "boolean",
				description: "Open in a new tab instead of replacing the current one. Default false.",
			},
			waitForLoad: {
				type: "boolean",
				description: "Wait until the page finishes loading before returning. Default true.",
			},
		},
		required: ["url"],
		additionalProperties: false,
	},
	executionMode: "sequential",
	async execute(args, signal) {
		const url = String(args.url);
		const newTab = Boolean(args.newTab);
		const waitForLoad = args.waitForLoad !== false;

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`Invalid URL: ${url}`);
		}
		if (!/^https?:$/i.test(parsed.protocol)) {
			throw new Error(`Unsupported URL scheme: ${parsed.protocol} (only http and https are allowed)`);
		}

		let tabId: number;
		if (newTab) {
			const created = await chrome.tabs.create({ url, active: true });
			if (created.id === undefined) throw new Error("Failed to create tab.");
			tabId = created.id;
		} else {
			const active = await getActiveTab();
			const updated = await chrome.tabs.update(active.id as number, { url });
			if (!updated || updated.id === undefined) throw new Error("Failed to update tab.");
			tabId = updated.id;
		}

		if (waitForLoad) await waitForTabComplete(tabId, signal);

		const final = await chrome.tabs.get(tabId);
		return {
			content: [
				{
					type: "text",
					text:
						`navigated to: ${final.url ?? "(unknown)"}\n` +
						`title: ${final.title ?? "(no title)"}\n` +
						`status: ${final.status ?? "?"}` +
						(newTab ? "\nopened in a new tab" : ""),
				},
			],
		};
	},
};
