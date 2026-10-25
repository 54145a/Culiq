// Post-build guard: every semantic Tailwind utility that Streamdown's compiled
// components reference must exist in the generated CSS. Without this check a
// streamdown upgrade that introduces a new semantic token (e.g. bg-accent)
// would silently produce no rule — styled nowhere, failing only visually, as
// happened with the transparent table-modal backdrop. Fail the build instead.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = "node_modules/streamdown/dist";
const outDirs = ["dist-chrome", "dist-firefox"];

// Semantic color tokens we bridge in tailwind.css via @theme inline.
const TOKENS = [
	"background",
	"foreground",
	"muted",
	"muted-foreground",
	"border",
	"sidebar",
	"primary",
	"primary-foreground",
];
const tokenAlt = TOKENS.join("|");
const utilityRe = new RegExp(
	`(?:bg|text|border|ring|divide|from|to|via|fill|stroke|shadow|outline|decoration|accent|caret)-(${tokenAlt})(?:\\\\/|[/.][0-9]+)?[a-z0-9/.-]*`,
	"g",
);

const js = readdirSync(dist)
	.filter((f) => f.endsWith(".js"))
	.map((f) => readFileSync(join(dist, f), "utf8"))
	.join("\n");
const used = new Set(js.match(utilityRe) ?? []);

// Returns an array of CSS file contents — NOT a joined string: spreading a
// joined string at the recursive call site would split it into characters.
function collectCss(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) out.push(...collectCss(join(dir, entry.name)));
		else if (entry.name.endsWith(".css")) out.push(readFileSync(join(dir, entry.name), "utf8"));
	}
	return out;
}

let failed = false;
for (const dir of outDirs) {
	const css = collectCss(dir).join("\n");
	for (const cls of used) {
		// CSS escapes the "/" of an opacity modifier as "\/".
		const selector = cls.replace("/", "\\/");
		if (!css.includes(selector)) {
			console.error(`[streamdown-classes] ${dir}: utility ".${cls}" used by streamdown is missing from generated CSS`);
			failed = true;
		}
	}
}
if (failed) {
	console.error("[streamdown-classes] a semantic token is not bridged in tailwind.css, or the utility did not compile");
	process.exit(1);
}
console.log(`[streamdown-classes] OK — ${used.size} semantic utilities present in ${outDirs.join(" and ")}`);
