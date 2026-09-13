import { callContent } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "../../types";

export const clickTool: AgentTool = {
	name: "click",
	description: CAPABILITY_INFO.click.description,
	parameters: {
		type: "object",
		properties: {
			selector: { type: "string", description: "CSS selector. Obtain from `read_dom` outline mode — do not guess." },
		},
		required: ["selector"],
		additionalProperties: false,
	},
	async execute(args) {
		const selector = String(args.selector);
		const result = await callContent({ method: "click", selector });
		const el = result.target;
		const desc = `<${el.tagName}${el.id ? `#${el.id}` : ""}${el.classes.length ? `.${el.classes.slice(0, 3).join(".")}` : ""}>${el.text ? ` — ${el.text}` : ""}`;
		return { content: [{ type: "text", text: `clicked: ${desc}` }] };
	},
};

export const typeTool: AgentTool = {
	name: "type",
	description: CAPABILITY_INFO.type.description,
	parameters: {
		type: "object",
		properties: {
			selector: { type: "string", description: "CSS selector. Obtain from `read_dom` outline mode — do not guess." },
			text: { type: "string", description: "Text to type." },
			submit: { type: "boolean", description: "Submit the form (or press Enter) after typing. Default false." },
			clear: { type: "boolean", description: "Clear existing value first. Default true." },
		},
		required: ["selector", "text"],
		additionalProperties: false,
	},
	async execute(args) {
		const selector = String(args.selector);
		const text = String(args.text);
		const result = await callContent({
			method: "type",
			selector,
			text,
			...(args.submit !== undefined ? { submit: Boolean(args.submit) } : {}),
			...(args.clear !== undefined ? { clear: Boolean(args.clear) } : {}),
		});
		const submittedStr = result.submitted ? "submitted form" : "no submit";
		const el = result.target;
		const desc = `<${el.tagName}${el.id ? `#${el.id}` : ""}${el.classes.length ? `.${el.classes.slice(0, 3).join(".")}` : ""}>${el.text ? ` — ${el.text}` : ""}`;
		return {
			content: [
				{
					type: "text",
					text: `typed into ${desc}\nvalue: ${JSON.stringify(result.finalValue)}\n${submittedStr}`,
				},
			],
		};
	},
};

export const readDomTool: AgentTool = {
	name: "read_dom",
	description: CAPABILITY_INFO.read_dom.description,
	parameters: {
		type: "object",
		properties: {
			mode: { type: "string", enum: ["markdown", "html", "readable_html", "outline"], description: "Output mode: 'markdown' (clean Markdown via Defuddle, default), 'html' (raw markup), 'readable_html' (clean HTML via Defuddle), or 'outline' (headings, links, forms with CSS selectors)." },
			selector: { type: "string", description: "Optional CSS selector to limit scope." },
			maxChars: { type: "number", description: "Truncate output to this many chars. Default 8000." },
			tabId: { type: "number", description: "Read from a specific tab instead of the active tab. Used internally; not exposed to agents." },
		},
		additionalProperties: false,
	},
	async execute(args) {
		const targetTabId = args.tabId as number | undefined;
		let originalTabId: number | undefined;
		if (targetTabId !== undefined) {
			const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			originalTabId = tabs[0]?.id;
			await chrome.tabs.update(targetTabId, { active: true });
		}
		try {
			const result = await callContent({
				method: "read_dom",
				...(args.mode !== undefined ? { mode: args.mode as "markdown" | "html" | "readable_html" | "outline" } : {}),
				...(args.selector !== undefined ? { selector: String(args.selector) } : {}),
				...(args.maxChars !== undefined ? { maxChars: Number(args.maxChars) } : {}),
			});
			const header = `url: ${result.url}\ntitle: ${result.title}\nmode: ${result.mode} · scope: ${result.scope} · chars: ${result.chars}${result.truncated ? " (truncated)" : ""}`;
			return {
				content: [{ type: "text", text: `${header}\n\n${result.content}` }],
			};
		} finally {
			if (targetTabId !== undefined && originalTabId !== undefined) {
				await chrome.tabs.update(originalTabId, { active: true }).catch(() => {});
			}
		}
	},
};

export const domTools: AgentTool[] = [clickTool, typeTool, readDomTool];
