(sandbox) => ({
	description:
		"Search the web using Bing and return the extracted result text. Opens the results page, reads the result list (the #b_results items), and returns the readable content so the agent can follow up with read_dom or click. Use this for quick web searches instead of navigating to a search engine manually.",
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
		// The sandbox has no DOM, so let the tool do the extraction: fetchUrl
		// returns the extracted text as a string.
		const text = await sandbox.fetchUrl({ url, mode: "markdown", maxChars: limit, selector: "#b_results" });
		return `search: ${query}\nengine: bing\n\n${text}`;
	},
})
