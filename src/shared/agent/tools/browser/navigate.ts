import { getActiveTab } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "../../types";
import { waitForTabComplete } from "./wait";

/** Internal args — `active` is injected by the system, not exposed in JSON Schema. */
interface NavigateArgs {
	url: string;
	newTab?: boolean;
	waitForLoad?: boolean;
	active?: boolean;
}

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
	async execute(rawArgs, signal) {
		const args = rawArgs as unknown as NavigateArgs;
		const url = String(args.url);
		const newTab = Boolean(args.newTab);
		const waitForLoad = args.waitForLoad !== false;
		const shouldFocus = args.active !== false;

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
			const created = await chrome.tabs.create({ url, active: shouldFocus });
			if (created.id === undefined) throw new Error("Failed to create tab.");
			tabId = created.id;
		} else {
			const current = await getActiveTab();
			const updated = await chrome.tabs.update(current.id as number, { url });
			if (!updated || updated.id === undefined) throw new Error("Failed to update tab.");
			tabId = updated.id;
		}

		if (waitForLoad) {
			try {
				await waitForTabComplete(tabId, signal);
			} catch {
				// Timed out or aborted — page may still be usable.
			}
		}

		const final = await chrome.tabs.get(tabId);
		const incomplete = final.status !== "complete" ? "\n⚠️ Page did not fully load (e.g. blocked resources)." : "";
		return {
			content: [
				{
					type: "text",
					text:
						`navigated to: ${final.url ?? "(unknown)"}\n` +
						`title: ${final.title ?? "(no title)"}\n` +
						`status: ${final.status ?? "?"}` +
						(newTab ? "\nopened in a new tab" : "") +
						incomplete,
				},
			],
		};
	},
};
