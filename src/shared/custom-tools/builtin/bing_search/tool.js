(sandbox) => ({
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
	execute: async ({ query, maxChars }) => {
		const url = "https://www.bing.com/search?q=" + encodeURIComponent(query);
		const limit = maxChars && maxChars > 0 ? maxChars : 200000;
		// fetchUrl returns an AgentToolResult; pull the html out of it.
		const result = await sandbox.fetchUrl(url, "html", limit);
		const html = result && result.content && result.content[0] ? result.content[0].text : "";
		const doc = new DOMParser().parseFromString(html || "", "text/html");
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
})
