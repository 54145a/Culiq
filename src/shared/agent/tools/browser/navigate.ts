import { getActiveTab } from "@shared/transport/tab-rpc";
import type { AgentTool } from "../../types";

const LOAD_TIMEOUT_MS = 30_000;

export const navigateTool: AgentTool = {
	name: "navigate",
	description:
		"Open a URL in the active tab (default) or in a new tab. Waits until the page finishes loading by default. Use this when you need to take the user to a different page before reading/clicking/typing on it.",
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

function waitForTabComplete(tabId: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			chrome.tabs.onUpdated.removeListener(onUpdated);
			chrome.tabs.onRemoved.removeListener(onRemoved);
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (err) reject(err);
			else resolve();
		};

		const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
			if (id === tabId && info.status === "complete") finish();
		};
		const onRemoved = (id: number) => {
			if (id === tabId) finish(new Error("Tab was closed while waiting for load."));
		};
		const onAbort = () => finish(new Error("aborted"));

		chrome.tabs.onUpdated.addListener(onUpdated);
		chrome.tabs.onRemoved.addListener(onRemoved);
		signal?.addEventListener("abort", onAbort);

		const timer = setTimeout(
			() => finish(new Error(`waitForLoad timed out after ${LOAD_TIMEOUT_MS / 1000}s`)),
			LOAD_TIMEOUT_MS,
		);

		chrome.tabs.get(tabId).then((tab) => {
			if (tab.status === "complete") finish();
		});
	});
}
