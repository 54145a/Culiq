import type { AgentEvent, AgentTool } from "../../types";
import { CAPABILITY_INFO, type Capability } from "@shared/config";
import { BRIDGE_SPEC, isPathEnabled } from "./api";

const TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 8_000;
const BRIDGE_HINT_MAX_CHARS = 2_000;

export type SandboxOutcome = { ok: true; value: string } | { ok: false; error: string };

interface PendingCall {
	resolve: (outcome: SandboxOutcome) => void;
	timer: number;
}

/** Per-turn context for the sandbox, set by the service worker when a turn starts. */
interface SandboxContext {
	enabled: Set<Capability>;
	subagent?: (task: string) => Promise<string>;
	eventSink?: (event: AgentEvent) => void;
}

interface SandboxSession {
	transport: SandboxTransport;
	nextId: number;
	pending: Map<number, PendingCall>;
	signal: AbortSignal;
	enabled: Set<Capability>;
	subagent?: (task: string) => Promise<string>;
	eventSink?: (event: AgentEvent) => void;
}

/**
 * Per-turn sandbox context (enabled capabilities, sub-agent runner, event sink),
 * keyed by the turn's AbortSignal. Set by the service worker before a turn runs.
 */
const pendingContext = new Map<AbortSignal, SandboxContext>();

export function setSandboxContext(signal: AbortSignal, ctx: SandboxContext): void {
	pendingContext.set(signal, ctx);
}

/** Message pipe between the SW and the sandbox worker (init/eval/bridge/eval-result). */
interface SandboxTransport {
	postMessage(data: unknown): void;
	onMessage(cb: (data: unknown) => void): void;
	close(): void;
}

const SANDBOX_MSG = { send: "sandbox_send", msg: "sandbox_msg", close: "sandbox_close" } as const;

/**
 * The sandbox worker runs in a hidden iframe inside the active side panel /
 * pop-up window (a window context — `new Worker` exists in both browsers).
 * Messages relay through chrome.runtime. Broadcast is safe because the
 * single-panel guard ensures only one iframe is ever listening.
 */
class IframeTransport implements SandboxTransport {
	private handler: ((data: unknown) => void) | null = null;
	private readonly listener: (msg: { type?: string; sessionId?: string; data?: unknown }) => void;

	constructor(private readonly sessionId: string) {
		this.listener = (msg) => {
			if (msg?.type === SANDBOX_MSG.msg && msg.sessionId === this.sessionId) this.handler?.(msg.data);
		};
		chrome.runtime.onMessage.addListener(this.listener);
	}

	postMessage(data: unknown): void {
		void chrome.runtime.sendMessage({ type: SANDBOX_MSG.send, sessionId: this.sessionId, data });
	}

	onMessage(cb: (data: unknown) => void): void {
		this.handler = cb;
	}

	close(): void {
		chrome.runtime.onMessage.removeListener(this.listener);
		void chrome.runtime.sendMessage({ type: SANDBOX_MSG.close, sessionId: this.sessionId });
	}
}

function createSandboxTransport(enabled: Set<Capability>): SandboxTransport {
	const transport = new IframeTransport(crypto.randomUUID());
	const paths = Object.keys(BRIDGE_SPEC).filter((p) => isPathEnabled(p, enabled));
	transport.postMessage({ kind: "init", paths });
	return transport;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const sessions = new WeakMap<AbortSignal, SandboxSession>();

/** Close the sandbox for a turn (idempotent). */
export function closeSandbox(signal: AbortSignal): void {
	const session = sessions.get(signal);
	if (!session) return;
	sessions.delete(signal);
	pendingContext.delete(signal);
	session.transport.close();
}

function getSession(signal: AbortSignal): SandboxSession {
	let session = sessions.get(signal);
	if (!session) {
		const ctx = pendingContext.get(signal);
		const enabled = ctx?.enabled ?? new Set<Capability>();
		const created: SandboxSession = {
			transport: createSandboxTransport(enabled),
			nextId: 1,
			pending: new Map(),
			signal,
			enabled,
			subagent: ctx?.subagent,
			eventSink: ctx?.eventSink,
		};
		sessions.set(signal, created);
		signal.addEventListener("abort", () => closeSandbox(signal), { once: true });
		created.transport.onMessage((data) => onWorkerMessage(created, data));
		session = created;
	}
	return session;
}

function onWorkerMessage(session: SandboxSession, data: unknown): void {
	const msg = data as
		| { kind: "eval-result"; id: number; ok: boolean; value?: string; error?: string }
		| { kind: "bridge"; id: number; path: string; args?: unknown[] }
		| undefined;

	if (!msg) return;

	if (msg.kind === "eval-result") {
		const pending = session.pending.get(msg.id);
		if (!pending) return;
		session.pending.delete(msg.id);
		clearTimeout(pending.timer);
		pending.resolve(msg.ok ? { ok: true, value: msg.value ?? "" } : { ok: false, error: msg.error ?? "unknown sandbox error" });
		return;
	}

	if (msg.kind === "bridge") {
		void handleBridge(session, msg.id, msg.path, msg.args ?? []);
	}
}

async function handleBridge(session: SandboxSession, id: number, path: string, args: unknown[]): Promise<void> {
	const toolCallId = `sb-${id}`;
	const toolName = `sandbox.${path}`;
	const sink = session.eventSink;
	const ctx = { subagent: session.subagent };
	if (sink) sink({ type: "tool_execution_start", toolCallId, toolName, args: args as unknown as Record<string, unknown> });
	try {
		if (!isPathEnabled(path, session.enabled)) {
			throw new Error(`capability for ${path} is disabled`);
		}
		const entry = BRIDGE_SPEC[path];
		if (!entry) throw new Error(`sandbox bridge: unknown API ${path}`);
		const value = await entry.invoke(args, ctx);
		const serialized = serializeBridgeValue(value);
		if (sink) {
			const raw = typeof value === "string" ? value : serialized;
			const preview = typeof raw === "string" ? raw : JSON.stringify(raw);
			sink({
				type: "tool_execution_end",
				toolCallId,
				toolName,
				result: { content: [{ type: "text", text: preview.slice(0, BRIDGE_HINT_MAX_CHARS) }] },
				isError: false,
			});
		}
		session.transport.postMessage({ kind: "bridge-result", id, ok: true, value: serialized });
	} catch (err) {
		const errorText = err instanceof Error ? (err.stack ?? err.message) : String(err);
		if (sink) {
			sink({
				type: "tool_execution_end",
				toolCallId,
				toolName,
				result: { content: [{ type: "text", text: errorText.slice(0, BRIDGE_HINT_MAX_CHARS) }] },
				isError: true,
			});
		}
		session.transport.postMessage({ kind: "bridge-result", id, ok: false, error: errorText });
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

export function evaluate(signal: AbortSignal, code: string): Promise<SandboxOutcome> {
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

		session.transport.postMessage({ kind: "eval", id, code });
	});
}

export const sandboxExecTool: AgentTool = {
	name: "sandbox_exec",
	description: CAPABILITY_INFO.sandbox_exec.description,
	parameters: {
		type: "object",
		properties: {
			code: {
				type: "string",
				description:
					"JavaScript body run in the sandbox. Use `return X` to send back a value. Example: `return await sandbox.dir('skills').children()`.",
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
