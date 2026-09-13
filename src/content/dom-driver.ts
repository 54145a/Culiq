import type {
	ClickResult,
	ContentRequest,
	ContentResultMap,
	ElementSummary,
	ReadDomResult,
	TypeResult,
} from "@shared/transport/content-rpc";
import Defuddle from "defuddle";
import { createMarkdownContent } from "defuddle/full";

const HTML_SNIPPET_LIMIT = 240;
const TEXT_SNIPPET_LIMIT = 200;
const DEFAULT_READ_MAX = 8_000;

export async function dispatch(request: ContentRequest): Promise<ContentResultMap[ContentRequest["method"]]> {
	switch (request.method) {
		case "click":
			return click(request);
		case "type":
			return type(request);
		case "read_dom":
			return readDom(request);
	}
}

function click(req: Extract<ContentRequest, { method: "click" }>): ClickResult {
	const nodes = safeQueryAll(req.selector);
	if (nodes.length === 0) throw new Error(`No element matches selector: ${req.selector}`);
	if (nodes.length > 1) {
		const allMatches = nodes.slice(0, 10).map(summarize);
		const lines = allMatches.map(
			(m, i) => `[${i}] <${m.tagName}${m.id ? `#${CSS.escape(m.id)}` : ""}${m.classes.length ? `.${m.classes.map(CSS.escape).join(".")}` : ""}>${m.text ? ` — ${m.text}` : ""}`,
		);
		throw new Error(`Selector "${req.selector}" matched ${nodes.length} elements. Use a more specific selector:\n${lines.join("\n")}`);
	}
	const el = nodes[0];
	scrollIntoCenter(el);
	const target = el as HTMLElement;
	if (typeof target.click !== "function") {
		throw new Error(`Element is not clickable: <${el.tagName.toLowerCase()}>`);
	}
	target.click();
	return { selector: req.selector, target: summarize(el) };
}

function type(req: Extract<ContentRequest, { method: "type" }>): TypeResult {
	const nodes = safeQueryAll(req.selector);
	if (nodes.length === 0) throw new Error(`No element matches selector: ${req.selector}`);
	if (nodes.length > 1) {
		const lines = nodes.slice(0, 10).map((n, i) => {
			const s = summarize(n);
			return `[${i}] <${s.tagName}${s.id ? `#${CSS.escape(s.id)}` : ""}${s.classes.length ? `.${s.classes.map(CSS.escape).join(".")}` : ""}>${s.text ? ` — ${s.text}` : ""}`;
		});
		throw new Error(`Selector "${req.selector}" matched ${nodes.length} elements. Use a more specific selector:\n${lines.join("\n")}`);
	}
	const el = nodes[0];
	scrollIntoCenter(el);

	let finalValue = "";
	let submitted = false;

	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
		el.focus();
		if (req.clear !== false) el.value = "";
		insertValue(el, req.text);
		finalValue = el.value;
		if (req.submit) submitted = submitForm(el);
	} else if (el instanceof HTMLElement && el.isContentEditable) {
		el.focus();
		if (req.clear !== false) el.textContent = "";
		const range = document.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		document.execCommand("insertText", false, req.text);
		finalValue = el.textContent ?? "";
	} else {
		throw new Error(`Element is not typeable: <${el.tagName.toLowerCase()}>`);
	}

	return {
		selector: req.selector,
		target: summarize(el),
		submitted,
		finalValue,
	};
}

function readDom(req: Extract<ContentRequest, { method: "read_dom" }>): ReadDomResult {
	const mode = req.mode ?? "markdown";
	const maxChars = req.maxChars ?? DEFAULT_READ_MAX;
	const root = req.selector ? safeQueryAll(req.selector)[0] : document.body;
	if (!root) {
		throw new Error(req.selector ? `No element matches selector: ${req.selector}` : "document.body unavailable");
	}

	let content: string;
	if (mode === "markdown") {
		const defuddle = new Defuddle(document, { contentSelector: req.selector });
		const result = defuddle.parse();
		content = result.contentMarkdown ?? createMarkdownContent(result.content, location.href);
	} else if (mode === "html") {
		content = (root as Element).outerHTML;
	} else if (mode === "readable_html") {
		const defuddle = new Defuddle(document, { contentSelector: req.selector });
		const result = defuddle.parse();
		content = result.content;
	} else {
		content = outline(root as Element, 0);
	}

	const truncated = content.length > maxChars;
	if (truncated) content = `${content.slice(0, maxChars)}\n…[truncated ${content.length - maxChars} more chars]`;

	return {
		url: location.href,
		title: document.title,
		mode,
		scope: req.selector ? "selector" : "document",
		content,
		chars: content.length,
		truncated,
	};
}

function safeQueryAll(selector: string): Element[] {
	try {
		return Array.from(document.querySelectorAll(selector));
	} catch (err) {
		throw new Error(`Invalid selector "${selector}": ${err instanceof Error ? err.message : String(err)}`);
	}
}

function summarize(el: Element): ElementSummary {
	const rect = el.getBoundingClientRect();
	const visible = isVisible(el, rect);
	const tag = el.tagName.toLowerCase();
	const attrs: Record<string, string> = {};
	for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
	const text = trim(el.textContent ?? "", TEXT_SNIPPET_LIMIT);
	const outerHtml = trim((el as Element).outerHTML, HTML_SNIPPET_LIMIT);
	const disabled =
		(el as HTMLButtonElement | HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true";

	return {
		tagName: tag,
		id: el.id || null,
		classes: Array.from(el.classList),
		role: el.getAttribute("role"),
		text,
		attrs,
		rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		visible,
		disabled,
		outerHtmlSnippet: outerHtml,
	};
}

function isVisible(el: Element, rect: DOMRect): boolean {
	if (rect.width === 0 && rect.height === 0) return false;
	const style = window.getComputedStyle(el as Element);
	if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
	return true;
}

function trim(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	if (t.length <= n) return t;
	return `${t.slice(0, n)}…`;
}

function scrollIntoCenter(el: Element): void {
	try {
		el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center", inline: "center" });
	} catch {
		el.scrollIntoView();
	}
}

function insertValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
	const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
	// oxlint-disable-next-line typescript/unbound-method -- .call() explicitly binds `this`
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (setter) setter.call(el, (el.value ?? "") + text);
	else el.value = (el.value ?? "") + text;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitForm(el: HTMLInputElement | HTMLTextAreaElement): boolean {
	const form = el.form;
	if (form) {
		if (form.requestSubmit) form.requestSubmit(); else form.submit();
		return true;
	}
	const enter = (type: "keydown" | "keyup") =>
		new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
	el.dispatchEvent(enter("keydown"));
	el.dispatchEvent(enter("keyup"));
	return false;
}

function cssSelector(el: Element): string {
	const tag = el.tagName.toLowerCase();
	if (el.id) return `${tag}#${CSS.escape(el.id)}`;
	if (el.classList.length > 0) return `${tag}.${Array.from(el.classList).map(CSS.escape).join(".")}`;
	const parent = el.parentElement;
	if (!parent) return tag;
	const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
	const idx = siblings.indexOf(el);
	if (siblings.length === 1) return `${cssSelector(parent)} > ${tag}`;
	return `${cssSelector(parent)} > ${tag}:nth-of-type(${idx + 1})`;
}

function outline(root: Element, depth: number): string {
	const lines: string[] = [];
	const INTERESTING = new Set([
		"H1",
		"H2",
		"H3",
		"H4",
		"H5",
		"H6",
		"A",
		"BUTTON",
		"INPUT",
		"TEXTAREA",
		"SELECT",
		"LABEL",
		"FORM",
		"NAV",
		"MAIN",
		"SECTION",
		"ARTICLE",
		"ASIDE",
		"HEADER",
		"FOOTER",
	]);
	const walk = (el: Element, d: number) => {
		const tag = el.tagName;
		if (INTERESTING.has(tag)) {
			const id = el.id ? `#${el.id}` : "";
			const cls = el.classList.length > 0 ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : "";
			const txt = trim(el.textContent ?? "", 80);
			const sel = cssSelector(el);
			lines.push(`${"  ".repeat(d)}${tag.toLowerCase()}${id}${cls}${txt ? ` — ${txt}` : ""}  [${sel}]`);
		}
		for (const child of Array.from(el.children)) walk(child, INTERESTING.has(tag) ? d + 1 : d);
	};
	walk(root, depth);
	return lines.join("\n");
}
