import type { AgentTool } from "../../types";
import { createSandboxWorker } from "./worker";

const TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 8_000;

type SandboxOutcome = { ok: true; value: string } | { ok: false; error: string };

interface SandboxSession {
	worker: Worker;
	nextId: number;
}

const sessions = new WeakMap<AbortSignal, SandboxSession>();

/** Terminate the sandbox worker for a turn (idempotent). */
export function closeSandbox(signal: AbortSignal): void {
	const session = sessions.get(signal);
	if (!session) return;
	sessions.delete(signal);
	session.worker.terminate();
}

function getSession(signal: AbortSignal): SandboxSession {
	let session = sessions.get(signal);
	if (!session) {
		session = { worker: createSandboxWorker(), nextId: 1 };
		sessions.set(signal, session);
		signal.addEventListener("abort", () => closeSandbox(signal), { once: true });
	}
	return session;
}

function evaluate(signal: AbortSignal, code: string): Promise<SandboxOutcome> {
	const session = getSession(signal);
	const id = session.nextId++;

	return new Promise<SandboxOutcome>((resolve) => {
		const timer = setTimeout(() => {
			session.worker.removeEventListener("message", onMessage);
			closeSandbox(signal);
			resolve({ ok: false, error: `sandbox_exec timed out after ${TIMEOUT_MS / 1000}s` });
		}, TIMEOUT_MS);

		const onMessage = (event: MessageEvent) => {
			const data = event.data as { id?: number; ok?: boolean; value?: string; error?: string };
			if (data.id !== id) return;
			session.worker.removeEventListener("message", onMessage);
			clearTimeout(timer);
			resolve(data.ok ? { ok: true, value: data.value ?? "" } : { ok: false, error: data.error ?? "unknown sandbox error" });
		};

		session.worker.addEventListener("message", onMessage);
		session.worker.postMessage({ id, code });
	});
}

export const sandboxExecTool: AgentTool = {
	name: "sandbox_exec",
	description:
		"Run JavaScript in a restricted sandbox worker in the extension's background context. Exposed APIs: `sandbox.fs.read(path)`, `sandbox.fs.write(path, content)`, `sandbox.fs.list(path)`, `sandbox.fs.delete(path)`, `sandbox.fs.mkdir(path)` over the Origin Private File System (OPFS — the extension's private, origin-scoped storage; paths relative, no '..'); and `sandbox.fetch(url, init)` (extension-origin, CORS-free to permitted hosts). Standard worker globals (crypto, URL, TextEncoder, etc.) are available. No DOM and no chrome.* APIs. State (variables, OPFS handles) persists across sandbox_exec calls within the same turn. Top-level await supported; `return X` to send a value back. Use it for file work, patching skill files, network requests, and computation — instead of adding more dedicated tools.",
	parameters: {
		type: "object",
		properties: {
			code: {
				type: "string",
				description:
					"JavaScript body run in the sandbox. Use `return X` to send back a value. Example: `return await sandbox.fs.list('skills')`.",
			},
			maxChars: { type: "number", description: "Truncate the serialized result to this many chars. Default 8000." },
		},
		required: ["code"],
		additionalProperties: false,
	},
	async execute(args, signal) {
		const code = String(args.code);
		const maxChars = typeof args.maxChars === "number" ? Math.max(100, args.maxChars) : DEFAULT_MAX_CHARS;

		if (!signal) return { content: [{ type: "text", text: "sandbox_exec requires an AbortSignal." }], isError: true };

		const outcome = await evaluate(signal, code);
		if (!outcome.ok) {
			return { content: [{ type: "text", text: `error:\n${outcome.error}` }], isError: true };
		}

		let value = outcome.value;
		const truncated = value.length > maxChars;
		if (truncated) value = `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} more chars]`;

		return {
			content: [{ type: "text", text: `sandbox${truncated ? " · truncated" : ""}\n${value}` }],
		};
	},
};
