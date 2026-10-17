import { findTargetTab } from "@shared/transport/tab-rpc";
import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "@shared/agent/types";
import { clearConsoleBuffer, readConsoleBuffer } from "./console-buffer";
import { ensureConsoleShim } from "./console-inject";

const LEVEL_ORDER = { debug: 0, log: 1, info: 2, warn: 3, error: 4, trace: 5 } as const;

function formatEntry(entry: { t: number; level: string; text: string; source?: string }): string {
	const time = new Date(entry.t).toLocaleTimeString("en-GB", { hour12: false });
	const source = entry.source ? ` (${entry.source})` : "";
	return `${time} [${entry.level}]${source} ${entry.text}`;
}

export const readConsoleTool: AgentTool = {
	name: "read_console",
	description: CAPABILITY_INFO.read_console.description,
	parameters: {
		type: "object",
		properties: {
			level: {
				type: "string",
				enum: ["debug", "log", "info", "warn", "error", "trace"],
				description: "Minimum severity to return. Default: return everything.",
			},
			clear: { type: "boolean", description: "Empty the buffer after reading. Default false." },
			maxChars: { type: "number", description: "Truncate the result to this many chars. Default 12000." },
		},
		additionalProperties: false,
	},
	executionMode: "sequential",
	async execute(args) {
		const level = typeof args.level === "string" ? (args.level as keyof typeof LEVEL_ORDER) : undefined;
		const clear = args.clear === true;
		const maxChars = typeof args.maxChars === "number" ? Math.max(200, Math.floor(args.maxChars)) : 12_000;

		const tab = await findTargetTab();
		if (!tab || tab.id === undefined) {
			return { content: [{ type: "text", text: "No active tab found." }], isError: true };
		}

		// Re-arm the hook on tabs that predate the extension (registration only
		// covers future navigations) — a no-op when the shim is already there.
		await ensureConsoleShim(tab.id);

		const { entries, shimSeen } = await readConsoleBuffer(tab.id);
		const filtered = level ? entries.filter((e) => LEVEL_ORDER[e.level] >= LEVEL_ORDER[level]) : entries;

		if (clear) clearConsoleBuffer(tab.id);

		const lines: string[] = [];
		let total = 0;
		// Walk from the end so a tight budget keeps the most recent entries.
		for (let i = filtered.length - 1; i >= 0; i--) {
			const line = formatEntry(filtered[i]);
			if (total + line.length + 1 > maxChars) break;
			lines.unshift(line);
			total += line.length + 1;
		}

		const head = `console output (tab ${tab.id}) — ${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}${filtered.length > lines.length ? `, showing most recent ${lines.length}` : ""}`;
		const notes: string[] = [];
		if (!shimSeen) {
			notes.push("no console hook has reported on this tab — entries only accumulate from the moment the hook installs (e.g. after navigate, or on a page opened after the extension loaded)");
		} else if (filtered.length === 0) {
			notes.push("nothing captured at this level");
		}
		if (clear) notes.push("buffer cleared");

		const body = [head, ...notes.map((n) => `⚠️ ${n}`), "", ...lines].join("\n");
		return { content: [{ type: "text", text: body }] };
	},
};
