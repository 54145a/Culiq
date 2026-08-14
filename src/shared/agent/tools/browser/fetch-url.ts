import type { AgentTool } from "../../types";
import { waitForTabComplete } from "./wait";

type ExtractOutcome = { ok: boolean; title: string; url: string; content: string; error?: string };

export const fetchUrlTool: AgentTool = {
	name: "fetch_url",
	description:
		"Fetch a URL for a one-shot read: opens it in a new foreground tab, waits for it to load, reads the rendered page content (text or HTML), then closes the tab. Suitable for API endpoints or static pages you only need to view once. NOT for interactive browsing — if you need to click, type, or navigate onward, use `navigate` plus the DOM tools instead. Note: if the URL responds with a file download (Content-Disposition: attachment), the browser downloads the file instead of rendering it, so nothing is returned.",
	parameters: {
		type: "object",
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to fetch." },
			mode: { type: "string", enum: ["text", "html"], description: "Read as page text (default) or raw HTML." },
			maxChars: { type: "number", description: "Truncate the result to this many chars. Default 200000." },
		},
		required: ["url"],
		additionalProperties: false,
	},
	executionMode: "sequential",
	async execute(args, signal) {
		const url = String(args.url);
		const mode = args.mode === "html" ? "html" : "text";
		const maxChars = typeof args.maxChars === "number" ? Math.max(100, Math.floor(args.maxChars)) : 200_000;

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`Invalid URL: ${url}`);
		}
		if (!/^https?:$/i.test(parsed.protocol)) {
			throw new Error(`Unsupported URL scheme: ${parsed.protocol} (only http and https are allowed)`);
		}

		const tab = await chrome.tabs.create({ url, active: true });
		if (tab.id === undefined) throw new Error("Failed to create tab.");
		const tabId = tab.id;

		try {
			await waitForTabComplete(tabId, signal);
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");

			const results = await chrome.scripting.executeScript({
				target: { tabId },
				world: "ISOLATED",
				func: extractPage,
				args: [mode],
			});
			const outcome = (results[0]?.result as ExtractOutcome | undefined) ?? { ok: false, title: "", url, content: "" };

			let text = outcome.ok ? outcome.content : `extraction failed: ${outcome.error ?? "unknown"}`;
			const truncated = text.length > maxChars;
			if (truncated) text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} more chars]`;

			return {
				content: [
					{
						type: "text",
						text:
							`fetched: ${outcome.url || url}\ntitle: ${outcome.title || "(no title)"}` +
							`\nmode: ${mode} · chars: ${text.length}${truncated ? " (truncated)" : ""}\n\n${text}`,
					},
				],
			};
		} finally {
			chrome.tabs.remove(tabId).catch(() => {});
		}
	},
};

function extractPage(mode: string): ExtractOutcome {
	try {
		const doc = document;
		const title = doc.title ?? "";
		const url = location.href;
		let content: string;
		if (mode === "html") {
			content = doc.documentElement?.outerHTML ?? "";
		} else {
			content =
				doc.body?.innerText ??
				doc.documentElement?.innerText ??
				(doc.body ? "" : "no document body (PDF viewer or error page?)");
		}
		return { ok: true, title, url, content };
	} catch (err) {
		return { ok: false, title: "", url: location?.href ?? "", content: "", error: err instanceof Error ? err.message : String(err) };
	}
}
