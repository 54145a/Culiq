import { marked } from "marked";

marked.setOptions({
	breaks: true,
	gfm: true,
});

const SAFE_URL = /^(https?:|mailto:|tel:|#)/i;

export function renderMarkdown(source: string): string {
	const html = marked.parse(source, { async: false }) as string;
	return sanitize(html);
}

function sanitize(html: string): string {
	const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
	const root = doc.body.firstElementChild;
	if (!root) return "";
	stripUnsafe(root);
	return root.innerHTML;
}

const ALLOWED_TAGS = new Set([
	"p",
	"br",
	"strong",
	"em",
	"b",
	"i",
	"u",
	"s",
	"del",
	"code",
	"pre",
	"blockquote",
	"hr",
	"a",
	"ul",
	"ol",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"span",
	"div",
]);

function stripUnsafe(root: Element): void {
	const walker = (el: Element) => {
		for (const child of Array.from(el.children)) walker(child);

		const tag = el.tagName.toLowerCase();
		if (!ALLOWED_TAGS.has(tag)) {
			el.replaceWith(...Array.from(el.childNodes));
			return;
		}

		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on")) {
				el.removeAttribute(attr.name);
				continue;
			}
			if (name === "href" || name === "src") {
				if (!SAFE_URL.test(attr.value)) el.removeAttribute(attr.name);
			} else if (name === "class" || name === "id" || name === "title" || name === "align") {
				// allowed pass-through
			} else if (name === "target" || name === "rel") {
				// allowed
			} else {
				el.removeAttribute(attr.name);
			}
		}

		if (tag === "a") {
			el.setAttribute("target", "_blank");
			el.setAttribute("rel", "noopener noreferrer");
		}
	};
	walker(root);
}
