// @ts-nocheck
/**
 * Smoke test for the raw session export (src/shared/session-export.ts).
 * Run: node scripts/session-export-smoke.mjs
 */
import {
	buildSessionExport,
	sessionExportFilename,
	sessionExportJson,
} from "../src/shared/session-export.ts";

let pass = 0;
let fail = 0;
const expect = (label, actual, want) => {
	const ok = JSON.stringify(actual) === JSON.stringify(want);
	if (ok) pass++;
	else {
		fail++;
		console.log(`FAIL ${label}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(want)}`);
	}
};

// A session covering every block kind the panel writes into Session.messages.
const fixture = {
	id: "9f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8",
	title: "Hi / 你好 🚀 " + "x".repeat(80),
	createdAt: 1758550000000,
	updatedAt: 1758550100000,
	messages: [
		{ role: "user", content: "Hi" },
		{
			role: "assistant",
			stopReason: "end",
			usage: { inputTokens: 6300, outputTokens: 30 },
			content: [
				{ type: "context", text: "The current page is chrome://newtab/." },
				{ type: "thinking", thinking: "Line one.\n\n\n\nLine two.", signature: "sig-abc" },
				{ type: "text", text: "Hi! What can I help you with?" },
				{ type: "toolCall", id: "call_1", name: "read_dom", arguments: { mode: "outline" } },
				{ type: "usage", input: 6300, output: 30, totalIn: 6300, totalOut: 30 },
				{ type: "compress", summary: "earlier turns summarised" },
				{ type: "subtask", id: "subtask-1", messages: [{ role: "assistant", content: "sub answer", usage: { inputTokens: 10, outputTokens: 2 } }] },
			],
		},
		{ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "outline with ``` fence" }] },
	],
};

const now = new Date(2026, 8, 22, 12, 31, 12);

// 1. envelope + byte-faithful session
const env = buildSessionExport(fixture, now);
expect("envelope format", env.format, "culiq.session");
expect("envelope version", env.version, 1);
expect("envelope exportedAt", env.exportedAt, now.toISOString());
expect("session is verbatim", env.session, fixture);

// 2. JSON text round-trips to the same session
const parsed = JSON.parse(sessionExportJson(fixture, now));
expect("json.session deep-equals fixture", parsed.session, JSON.parse(JSON.stringify(fixture)));
expect("json ends with a single newline", sessionExportJson(fixture, now).endsWith("}\n"), true);

// 3. filename sanitising
const name = sessionExportFilename(fixture, now);
expect("filename pattern", /^culiq-[\p{L}\p{N}-]+-\d{8}-\d{6}\.json$/u.test(name), true);
expect("filename max length", name.length <= 80, true);
expect("filename has no illegal chars", /[/\\:*?"<>|]/.test(name), false);
expect("filename keeps unicode title", name.startsWith("culiq-hi-你好-"), true);
expect("filename stamp", name.endsWith("-20260922-123112.json"), true);

// fallback when the title has nothing usable
const untitled = sessionExportFilename({ ...fixture, title: "   " }, now);
expect("titleless fallback uses session id", untitled, "culiq-session-9f1c2b3a-20260922-123112.json");

// 4. empty session still exports
const empty = { id: "e1", title: "New session", createdAt: 1, updatedAt: 1, messages: [] };
expect("empty session messages", JSON.parse(sessionExportJson(empty, now)).session.messages, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
