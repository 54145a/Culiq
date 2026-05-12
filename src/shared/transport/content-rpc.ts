export type ContentRequest =
	| { method: "query"; selector: string; all?: boolean; limit?: number }
	| { method: "click"; selector: string; index?: number }
	| { method: "type"; selector: string; text: string; submit?: boolean; clear?: boolean }
	| { method: "read_dom"; mode?: "text" | "html" | "outline"; selector?: string; maxChars?: number };

export type ContentMethod = ContentRequest["method"];

export interface ElementSummary {
	tagName: string;
	id: string | null;
	classes: string[];
	role: string | null;
	text: string;
	attrs: Record<string, string>;
	rect: { x: number; y: number; width: number; height: number };
	visible: boolean;
	disabled: boolean;
	outerHtmlSnippet: string;
}

export interface QueryResult {
	selector: string;
	totalMatches: number;
	returnedMatches: number;
	matches: ElementSummary[];
}

export interface ClickResult {
	selector: string;
	target: ElementSummary;
}

export interface TypeResult {
	selector: string;
	target: ElementSummary;
	submitted: boolean;
	finalValue: string;
}

export interface ReadDomResult {
	url: string;
	title: string;
	mode: "text" | "html" | "outline";
	scope: "document" | "selector";
	content: string;
	chars: number;
	truncated: boolean;
}

export type ContentResultMap = {
	query: QueryResult;
	click: ClickResult;
	type: TypeResult;
	read_dom: ReadDomResult;
};

export type ContentResponse =
	| { ok: true; method: ContentMethod; result: ContentResultMap[ContentMethod] }
	| { ok: false; method: ContentMethod | "unknown"; error: string };

export const CONTENT_ENVELOPE_MAGIC = "curio.content.rpc";

export interface ContentEnvelope {
	magic: typeof CONTENT_ENVELOPE_MAGIC;
	request: ContentRequest;
}

export function isContentEnvelope(value: unknown): value is ContentEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { magic?: unknown }).magic === CONTENT_ENVELOPE_MAGIC
	);
}
