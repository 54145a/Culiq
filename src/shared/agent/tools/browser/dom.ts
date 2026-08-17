import type { ElementSummary } from "@shared/transport/content-rpc";
import { callContent } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "../../types";

function describe(el: ElementSummary): string {
	const id = el.id ? `#${el.id}` : "";
	const cls = el.classes.length > 0 ? `.${el.classes.slice(0, 3).join(".")}` : "";
	const role = el.role ? ` role=${el.role}` : "";
	const flags = [el.visible ? "visible" : "hidden", el.disabled ? "disabled" : null].filter(Boolean).join(" ");
	const text = el.text ? ` — ${el.text}` : "";
	return `<${el.tagName}${id}${cls}${role}> [${flags}]${text}`;
}

export const queryTool: AgentTool = {
	name: "query",
	description: CAPABILITY_INFO.query.description,
	parameters: {
		type: "object",
		properties: {
			selector: { type: "string", description: "CSS selector, e.g. 'button.primary' or 'input[name=email]'." },
			all: {
				type: "boolean",
				description: "If false, return only the first match. Default true (return up to `limit`).",
			},
			limit: { type: "number", description: "Max matches to return when all=true. Default 10." },
		},
		required: ["selector"],
		additionalProperties: false,
	},
	async execute(args) {
		const selector = String(args.selector);
		const result = await callContent({
			method: "query",
			selector,
			...(args.all !== undefined ? { all: Boolean(args.all) } : {}),
			...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
		});

		const header = `selector: ${selector}\ntotal matches: ${result.totalMatches} (returned ${result.returnedMatches})`;
		if (result.matches.length === 0) {
			return { content: [{ type: "text", text: `${header}\n(no matches)` }] };
		}
		const lines = result.matches.map((m, i) => `[${i}] ${describe(m)}`);
		return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }] };
	},
};

export const clickTool: AgentTool = {
	name: "click",
	description: CAPABILITY_INFO.click.description,
	parameters: {
		type: "object",
		properties: {
			selector: { type: "string", description: "CSS selector targeting the element to click." },
			index: { type: "number", description: "Index when multiple match (default 0)." },
		},
		required: ["selector"],
		additionalProperties: false,
	},
	async execute(args) {
		const selector = String(args.selector);
		const result = await callContent({
			method: "click",
			selector,
			...(args.index !== undefined ? { index: Number(args.index) } : {}),
		});
		return {
			content: [{ type: "text", text: `clicked: ${describe(result.target)}` }],
		};
	},
};

export const typeTool: AgentTool = {
	name: "type",
	description: CAPABILITY_INFO.type.description,
	parameters: {
		type: "object",
		properties: {
			selector: { type: "string", description: "CSS selector for the input element." },
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
		return {
			content: [
				{
					type: "text",
					text: `typed into ${describe(result.target)}\nvalue: ${JSON.stringify(result.finalValue)}\n${submittedStr}`,
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
			mode: { type: "string", enum: ["text", "html", "outline"], description: "Output mode. Default 'text'." },
			selector: { type: "string", description: "Optional CSS selector to limit scope." },
			maxChars: { type: "number", description: "Truncate output to this many chars. Default 8000." },
		},
		additionalProperties: false,
	},
	async execute(args) {
		const result = await callContent({
			method: "read_dom",
			...(args.mode !== undefined ? { mode: args.mode as "text" | "html" | "outline" } : {}),
			...(args.selector !== undefined ? { selector: String(args.selector) } : {}),
			...(args.maxChars !== undefined ? { maxChars: Number(args.maxChars) } : {}),
		});
		const header = `url: ${result.url}\ntitle: ${result.title}\nmode: ${result.mode} · scope: ${result.scope} · chars: ${result.chars}${result.truncated ? " (truncated)" : ""}`;
		return {
			content: [{ type: "text", text: `${header}\n\n${result.content}` }],
		};
	},
};

export const domTools: AgentTool[] = [queryTool, clickTool, typeTool, readDomTool];
