// @ts-check
/** @type {import("@culiq/sandbox").ToolDefinition} */
export default {
	name: "bing_search",
	description:
		"Search the web using Bing and return the extracted result text. Opens the results page, reads the result list (the #b_results items), and returns the readable content so the agent can follow up with read_dom, query, or click. Use this for quick web searches instead of navigating to a search engine manually.",
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
	execute: async (sandbox, input) => {
		const query = String(input.query ?? "");
		const maxChars = typeof input.maxChars === "number" ? input.maxChars : undefined;
		const url = "https://www.bing.com/search?q=" + encodeURIComponent(query);
		const limit = maxChars && maxChars > 0 ? maxChars : 200000;
		const raw = await sandbox.fetchUrl(url, "readable_html", limit);
		console.log("[bing_search] raw length:", raw?.length);
		console.log("[bing_search] raw first 200:", raw?.slice(0, 200));
		// Strip metadata header (url/title/mode lines + blank line) before the HTML content.
		const headerEnd = raw.indexOf("\n\n");
		const html = headerEnd >= 0 ? raw.slice(headerEnd + 2) : raw;
		console.log("[bing_search] html length:", html.length);
		console.log("[bing_search] html first 200:", html.slice(0, 200));
		const doc = new DOMParser().parseFromString(html, "text/html");
		const container = doc.querySelector("#b_results");
		const lines = [];
		if (container) {
			for (const li of Array.from(container.children)) {
				if (li.nodeType !== 1) continue;
				if (li.classList && li.classList.contains("b_pag")) continue;
				const text = (li.textContent || "").replace(/\s+/g, " ").trim();
				if (text) lines.push(text);
			}
		}
		let text = lines.join("\n\n") || "(no results extracted)";
		const truncated = text.length > limit;
		if (truncated) text = text.slice(0, limit) + `\n…[truncated ${text.length - limit} more chars]`;
		return `search: ${query}\nengine: bing\nchars: ${text.length}${truncated ? " (truncated)" : ""}\n\n${text}`;
	},
};
