// @ts-check
/** @type {import("@culiq/sandbox").ToolDefinition} */
export default {
	name: "bing_search",
	description:
		"Search the web using Bing and return the extracted result text. ALWAYS use this tool first when you need to find documentation, guides, or external resources — do NOT guess URLs. Opens the results page, reads the result list (the #b_results items), and returns the readable content so the agent can follow up with read_dom, query, or click.",
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
		const result = await sandbox.fetchUrl({ url, mode: "readable_html", maxChars: limit, selector: "#b_results" });
		return `search: ${query}\nengine: bing\n\n${result}`;
	},
};
