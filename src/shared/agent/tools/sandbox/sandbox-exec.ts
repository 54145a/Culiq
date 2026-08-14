import type { AgentTool } from "../../types";
import { BRIDGE_SPEC } from "./api";
import { createSandboxWorker } from "./worker";

const TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 8_000;

type SandboxOutcome = { ok: true; value: string } | { ok: false; error: string };

interface PendingCall {
	resolve: (outcome: SandboxOutcome) => void;
	timer: number;
}

interface SandboxSession {
	worker: Worker;
	nextId: number;
	pending: Map<number, PendingCall>;
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
		const created: SandboxSession = { worker: createSandboxWorker(), nextId: 1, pending: new Map() };
		sessions.set(signal, created);
		signal.addEventListener("abort", () => closeSandbox(signal), { once: true });
		created.worker.addEventListener("message", (event) => onWorkerMessage(created, event));
		session = created;
	}
	return session;
}

function onWorkerMessage(session: SandboxSession, event: MessageEvent): void {
	const data = event.data as
		| { kind: "eval-result"; id: number; ok: boolean; value?: string; error?: string }
		| { kind: "bridge"; id: number; path: string; args?: unknown[] }
		| undefined;

	if (!data) return;

	if (data.kind === "eval-result") {
		const pending = session.pending.get(data.id);
		if (!pending) return;
		session.pending.delete(data.id);
		clearTimeout(pending.timer);
		pending.resolve(data.ok ? { ok: true, value: data.value ?? "" } : { ok: false, error: data.error ?? "unknown sandbox error" });
		return;
	}

	if (data.kind === "bridge") {
		void handleBridge(session, data.id, data.path, data.args ?? []);
	}
}

async function handleBridge(session: SandboxSession, id: number, path: string, args: unknown[]): Promise<void> {
	try {
		const entry = BRIDGE_SPEC[path];
		if (!entry) throw new Error(`sandbox bridge: unknown API ${path}`);
		const value = await entry.invoke(args);
		session.worker.postMessage({ kind: "bridge-result", id, ok: true, value: serializeBridgeValue(value) });
	} catch (err) {
		session.worker.postMessage({
			kind: "bridge-result",
			id,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Strip non-serializable values so the result survives postMessage. */
function serializeBridgeValue(value: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return String(value);
	}
}

function evaluate(signal: AbortSignal, code: string): Promise<SandboxOutcome> {
	const session = getSession(signal);
	const id = session.nextId++;

	return new Promise<SandboxOutcome>((resolve) => {
		const timer = setTimeout(() => {
			session.pending.delete(id);
			closeSandbox(signal);
			resolve({ ok: false, error: `sandbox_exec timed out after ${TIMEOUT_MS / 1000}s` });
		}, TIMEOUT_MS);

		session.pending.set(id, {
			resolve: (outcome) => {
				clearTimeout(timer);
				resolve(outcome);
			},
			timer,
		});

		session.worker.postMessage({ kind: "eval", id, code });
	});
}

export const sandboxExecTool: AgentTool = {
	name: "sandbox_exec",
	description:
		"Run JavaScript in a restricted sandbox worker in the extension's background context. Exposed APIs (see the `sandbox` type declarations in the system prompt; `sandbox.docs(name)` returns details): `sandbox.fs.{read,write,list,delete,mkdir}` over OPFS (relative paths, no '..'), `sandbox.fetch(url, init)` (extension-origin, CORS-free), a chrome bridge `sandbox.chrome.tabs.{query,get,update,reload}` and `sandbox.chrome.windows.{get,update}` (whitelisted, non-destructive), and `sandbox.evalInTab(tabId, world, code)` to run JS in a page. No DOM and no direct chrome.* inside the worker; bridge calls are proxied through the background and validated. State persists within the turn. Top-level await supported; `return X` to send a value back.",
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
