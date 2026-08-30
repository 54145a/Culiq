import { loadSettings, type SearchEngineId } from "@shared/config";
import type { AgentTool } from "../../types";
import { waitForTabComplete } from "./wait";

/** Search-engine query builders. Add new engines here; surface the id in Settings. */
const SEARCH_ENGINES: Record<SearchEngineId, (query: string) => string> = {
	bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

type ExtractOutcome = { ok: boolean; text: string; error?: string };

/** Extract Bing results: every `#b_results > li` except the `b_pag` pagination row. */
function extractSearchResults(): ExtractOutcome {
	try {
		const container = document.querySelector("#b_results");
		if (!container) return { ok: false, text: "", error: "no #b_results element (not a results page?)" };
		const lines: string[] = [];
		for (const li of Array.from(container.children)) {
			if (li.nodeType !== 1 || (li as HTMLElement).classList.contains("b_pag")) continue;
			const text = ((li as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
			if (text) lines.push(text);
		}
		return { ok: true, text: lines.join("\n\n") || "(no results extracted)" };
	} catch (err) {
		return { ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
	}
}

/** Run a web search and return the extracted result text. Shared by the `search` tool and the sandbox bridge. */
export async function runSearch(query: string, maxChars = 200_000, signal?: AbortSignal): Promise<string> {
	const engine = (await loadSettings()).searchEngine;
	const build = SEARCH_ENGINES[engine];
	if (!build) throw new Error(`Unsupported search engine: ${engine}`);
	const url = build(query);

	const tab = await chrome.tabs.create({ url, active: true });
	if (tab.id === undefined) throw new Error("Failed to create tab.");
	const tabId = tab.id;

	try {
		await waitForTabComplete(tabId, signal);
		if (signal?.aborted) throw new DOMException("aborted", "AbortError");

		const results = await chrome.scripting.executeScript({
			target: { tabId },
			world: "ISOLATED",
			func: extractSearchResults,
		});
		const outcome = (results[0]?.result as ExtractOutcome | undefined) ?? { ok: false, text: "", error: "no result" };

		let text = outcome.ok ? outcome.text : `extraction failed: ${outcome.error ?? "unknown"}`;
		const truncated = text.length > maxChars;
		if (truncated) text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} more chars]`;

		return `search: ${query}\nengine: ${engine}\ntabId: ${tabId}\nchars: ${text.length}${truncated ? " (truncated)" : ""}\n\n${text}`;
	} finally {
		chrome.tabs.update(tabId, { active: false }).catch(() => {});
	}
}

export const searchTool: AgentTool = {
	name: "search",
	description:
		"Search the web using the configured search engine (Settings → Search engine, default Bing). Opens the results in a new tab (the tab stays open for follow-up tools like `read_dom`, `query`, or `click`). Equivalent to navigating to the search results page and reading it with a preset result selector — but in a single tool call. Use this for quick web searches instead of navigating to a search engine manually.",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "The search query." },
			maxChars: { type: "number", description: "Truncate the extracted results to this many chars. Default 200000." },
		},
		required: ["query"],
		additionalProperties: false,
	},
	executionMode: "sequential",
	async execute(args, signal) {
		const query = String(args.query);
		const maxChars = typeof args.maxChars === "number" ? Math.max(100, Math.floor(args.maxChars)) : 200_000;
		const text = await runSearch(query, maxChars, signal);
		return { content: [{ type: "text", text }] };
	},
};
