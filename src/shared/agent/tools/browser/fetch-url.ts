import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool, AgentToolResult } from "../../types";
import { navigateTool } from "./navigate";
import { readDomTool } from "./dom";

/** Content types that count as textual (readable) for fetch_url. */
const TEXTUAL_CONTENT_TYPES = [
	"text/",
	"application/json",
	"application/xml",
	"application/xhtml+xml",
	"application/javascript",
	"application/x-javascript",
	"application/x-www-form-urlencoded",
	"image/svg+xml",
];

function isTextualContentType(contentType: string): boolean {
	const ct = contentType.split(";")[0].trim().toLowerCase();
	return TEXTUAL_CONTENT_TYPES.some((t) => (t.endsWith("/") ? ct.startsWith(t) : ct === t));
}

/** HEAD-probe a URL for its content type; returns undefined if the probe fails (proceed anyway). */
async function probeContentType(url: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const res = await fetch(url, { method: "HEAD", redirect: "follow", signal });
		return res.headers.get("content-type") ?? undefined;
	} catch (err) {
		if (signal?.aborted) throw err;
		return undefined;
	}
}

/** Get the active tab's ID, or undefined. */
async function getActiveTabId(): Promise<number | undefined> {
	const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	return tab?.id;
}

export const fetchUrlTool: AgentTool = {
	name: "fetch_url",
	description: CAPABILITY_INFO.fetch_url.description,
	parameters: {
		type: "object",
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to fetch." },
			mode: { type: "string", enum: ["markdown", "html", "readable_html", "outline"], description: "Output mode: `markdown` (clean Markdown via Defuddle, default), `html` (raw markup), `readable_html` (clean HTML via Defuddle), or `outline` (headings, links, forms)." },
			afterLoad: { type: "string", enum: ["close", "open"], description: "Close the tab after reading ('close', one-shot) or leave it open ('open') so follow-up tools can use it." },
			maxChars: { type: "number", description: "Truncate the result to this many chars. Default 200000." },
			probeMime: { type: "boolean", description: "HEAD-probe the URL first and refuse non-textual content types. Default true; set false to fetch anyway." },
		},
		required: ["url"],
		additionalProperties: false,
	},
	executionMode: "sequential",
	async execute(args, signal): Promise<AgentToolResult> {
		const url = String(args.url);
		const afterLoad = args.afterLoad === "open" ? "open" : "close";
		const mode = (args.mode as "markdown" | "html" | "readable_html" | "outline") ?? "markdown";
		const maxChars = typeof args.maxChars === "number" ? Math.max(100, Math.floor(args.maxChars)) : 200_000;
		const probeMime = args.probeMime !== false;

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return { content: [{ type: "text", text: `Invalid URL: ${url}` }], isError: true };
		}
		if (!/^https?:$/i.test(parsed.protocol)) {
			return { content: [{ type: "text", text: `Unsupported URL scheme: ${parsed.protocol} (only http and https are allowed)` }], isError: true };
		}

		if (probeMime) {
			const contentType = await probeContentType(parsed.href, signal);
			if (contentType && !isTextualContentType(contentType)) {
				return {
					content: [{ type: "text", text: `fetch_url: unsupported content type. HEAD reports "${contentType}" — this is a binary file, not a page. Set probeMime: false to load it anyway (it likely won't render as text).` }],
					isError: true,
				};
			}
		}

		// Delegate navigation to navigate tool (handles chrome.tabs + timeout).
		try {
			await navigateTool.execute({ url, newTab: true, waitForLoad: true }, signal);
		} catch (err) {
			return { content: [{ type: "text", text: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
		}
		if (signal?.aborted) throw new DOMException("aborted", "AbortError");

		// Delegate content extraction to read_dom tool.
		const contentResult = await readDomTool.execute({ mode, maxChars }, signal);

		// Close tab if needed.
		if (afterLoad === "close") {
			const tabId = await getActiveTabId();
			if (tabId) chrome.tabs.remove(tabId).catch(() => {});
		}

		// Return the content, stripping the readDomTool metadata header.
		const textBlock = contentResult.content[0];
		const raw = textBlock && "text" in textBlock ? textBlock.text : "";
		const headerEnd = raw.indexOf("\n\n");
		const text = headerEnd >= 0 ? raw.slice(headerEnd + 2) : raw;
		if (afterLoad === "open") {
			const tabId = await getActiveTabId();
			return { content: [{ type: "text", text: `fetched: ${url}\n${text}${tabId ? `\ntabId: ${tabId}` : ""}` }] };
		}
		return { content: [{ type: "text", text: `fetched: ${url}\n${text}` }] };
	},
};
