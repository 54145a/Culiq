import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import type { JSX } from "preact";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { deriveTitle, getCurrentId, getSession, newSession, type Session, setCurrent, upsertSession } from "@shared/sessions";
import { type ChatContextMode } from "@shared/transport/protocol";
import { renderMarkdown } from "./markdown";
import { ExtensionChatTransport } from "./extension-chat-transport";
import { getPanelWindowId } from "./window";
import type { BgToPanel, PanelToBg } from "@shared/transport/protocol";

export interface ChatTransport {
	send(msg: PanelToBg): void;
	onMessage(handler: (msg: BgToPanel) => void): () => void;
}

interface Notice {
	id: number;
	className: string;
	text: string;
}

// ---------------------------------------------------------------------------
// Session persistence (outside React)
// ---------------------------------------------------------------------------

let currentSession: Session = newSession();
let persisted = false;

const sessionChangeListeners = new Set<() => void>();
export function onSessionChange(cb: () => void): () => void {
	sessionChangeListeners.add(cb);
	return () => sessionChangeListeners.delete(cb);
}
function notifySessionChange(): void {
	for (const cb of sessionChangeListeners) cb();
}

export function isBusy(): boolean {
	return false;
}

export function currentSessionId(): string {
	return currentSession.id;
}

async function persistCurrent(): Promise<void> {
	await upsertSession(currentSession);
	if (!persisted) {
		persisted = true;
		await setCurrent(currentSession.id);
	}
	notifySessionChange();
}

async function hydrateFromStorage(): Promise<void> {
	const id = await getCurrentId();
	if (!id) return;
	const session = await getSession(id);
	if (!session) return;
	currentSession = session;
	persisted = true;
	notifyActiveId?.(session.id);
	notifySessionChange();
}

export async function loadSessionIntoChat(id: string): Promise<void> {
	const session = await getSession(id);
	if (!session) return;
	currentSession = session;
	persisted = true;
	notifyActiveId?.(session.id);
	await setCurrent(session.id);
	notifySessionChange();
}

export async function startFreshSession(): Promise<void> {
	currentSession = newSession();
	persisted = false;
	notifyActiveId?.(currentSession.id);
	await setCurrent(null);
	notifySessionChange();
}

// ---------------------------------------------------------------------------
// Format conversion
// ---------------------------------------------------------------------------

function convertSessionToUI(session: Session): UIMessage[] {
	// Collect tool results keyed by toolCallId so they can be merged into the
	// matching tool-call part (the stored format keeps them as separate messages).
	const resultText = new Map<string, string>();
	for (const m of session.messages) {
		if (m.role === "toolResult") {
			resultText.set(m.toolCallId, m.content.filter((c) => c.type === "text").map((c) => c.text).join(""));
		}
	}
	return session.messages
		.filter((m) => m.role !== "toolResult")
		.map((m) => {
			if (m.role === "user") {
				const text = typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("");
				return { id: crypto.randomUUID(), role: "user" as const, parts: [{ type: "text" as const, text }] };
			}
			// assistant
			const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			const parts: UIMessage["parts"] = [];
			for (const block of blocks) {
				if (block.type === "text" && block.text) {
					parts.push({ type: "text" as const, text: block.text });
				} else if (block.type === "toolCall") {
					const output = resultText.get(block.id);
					parts.push({
						type: `tool-${block.name}` as const,
						toolCallId: block.id,
						input: block.arguments,
						state: output ? ("output-available" as const) : ("input-available" as const),
						...(output ? { output } : {}),
					} as never);
				} else if (block.type === "context" && block.text) {
					parts.push({ type: "data-context" as const, id: "context", data: block.text } as never);
				}
			}
			return { id: (m as { id?: string }).id ?? crypto.randomUUID(), role: "assistant" as const, parts };
		});
}

function uiMessageToSessionMessage(m: UIMessage): Session["messages"] {
	if (m.role === "user") {
		const text = m.parts
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("");
		return [{ role: "user", content: text }];
	}
	const blocks: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
		| { type: "context"; text: string }
	> = [];
	const out: Session["messages"] = [];
	for (const part of m.parts) {
		if (part.type === "text" && part.text) {
			blocks.push({ type: "text", text: part.text });
		} else if (part.type === "tool-invocation") {
			// Live-streamed tool calls use the AI SDK's native part type.
			const tp = part as unknown as { toolCallId: string; toolName: string; input?: unknown; output?: unknown; errorText?: string };
			blocks.push({ type: "toolCall", id: tp.toolCallId, name: tp.toolName, arguments: (tp.input ?? {}) as Record<string, unknown> });
			if (tp.output != null) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output) }],
				});
			}
		} else if (part.type.startsWith("tool-")) {
			const tp = part as { toolCallId: string; input: unknown; output?: unknown };
			const name = part.type.slice(5);
			blocks.push({ type: "toolCall", id: tp.toolCallId, name, arguments: (tp.input ?? {}) as Record<string, unknown> });
			if (tp.output != null) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output) }],
				});
			}
		} else if (part.type === "data-context") {
			const data = (part as { data: unknown }).data;
			if (typeof data === "string" && data) blocks.push({ type: "context", text: data });
		}
	}
	out.unshift({ role: "assistant", content: blocks as never, stopReason: "end" });
	return out;
}

// ---------------------------------------------------------------------------
// Global setMessages ref for session management functions
// ---------------------------------------------------------------------------

// Notifies the panel (main.tsx) of the active session id so it can remount
// ChatView via a `key`, which (re)creates the useChat instance with the loaded
// history as its initial `messages`. This is the only reliable way to load
// history: useChat's setMessages does not notify its snapshot store.
let notifyActiveId: ((id: string) => void) | null = null;
export function setActiveIdNotifier(cb: (id: string) => void): void {
	notifyActiveId = cb;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

let noticeId = 0;

function ContextCard({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false);
		return (
		<li className="tool-card" data-status="ok" data-expanded={String(expanded)}>
			<div
				className="tool-head"
				role="button"
				tabIndex={0}
				aria-expanded={expanded}
				title="Click to expand"
				onClick={() => setExpanded(!expanded)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setExpanded(!expanded);
					}
				}}
			>
				<span className="tool-chevron" aria-hidden="true">▸</span>
				<code>context</code>
				<span className="tool-status">sent</span>
			</div>
			<pre className="tool-body">{text}</pre>
		</li>
	);
}

function ToolCardView({ toolName, part }: { toolName: string; part: { toolCallId: string; input: unknown; state: string; output?: unknown; errorText?: string } }) {
	const [expanded, setExpanded] = useState(false);
	const status = part.state.includes("error") ? "error" : part.state.includes("available") && part.output !== undefined ? "ok" : "running";
	const result = part.errorText ?? (typeof part.output === "string" ? part.output : part.output ? JSON.stringify(part.output) : "");
	return (
		<li className="tool-card" data-status={status} data-expanded={String(expanded)}>
			<div
				className="tool-head"
				role="button"
				tabIndex={0}
				aria-expanded={expanded}
				title="Click to expand"
				onClick={() => setExpanded(!expanded)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setExpanded(!expanded);
					}
				}}
			>
				<span className="tool-chevron" aria-hidden="true">▸</span>
				<code>{toolName}</code>
				<span className="tool-status">{status === "running" ? "running…" : status}</span>
			</div>
			<pre className="tool-args">{formatJSON(part.input)}</pre>
			<div className="tool-body">{result}</div>
		</li>
	);
}

function CompressNotice({ data }: { data: { beforeTokens: number; afterTokens: number; keptTurns: number; summary: string } }) {
	return (
		<li className="msg notice">
			{`Context compressed: ${formatTokens(data.beforeTokens)} → ${formatTokens(data.afterTokens)} tokens · kept ${data.keptTurns} recent turn${data.keptTurns === 1 ? "" : "s"} verbatim`}
		</li>
	);
}

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

export function ChatView({ transport, chatTransport }: { transport: ChatTransport; chatTransport: ExtensionChatTransport }) {
	const [notices, setNotices] = useState<Notice[]>([]);
	const [contextMode, setContextMode] = useState<ChatContextMode | "none">("none");
	const logRef = useRef<HTMLUListElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	const addNotice = useCallback((className: string, text: string) => {
		setNotices((prev) => [...prev, { id: noticeId++, className, text }]);
	}, []);

	const { messages, status, sendMessage, stop } = useChat({
		id: currentSession.id,
		// Initial messages for THIS chat id. Because ChatView is remounted per
		// session (via `key` in main.tsx), useChat re-initializes with the loaded
		// history here — the only reliable way to populate old messages.
		messages: convertSessionToUI(currentSession),
		transport: chatTransport,
		onError: (error) => {
			addNotice("msg err", error.message);
		},
	});

	useEffect(() => {
		return transport.onMessage((msg) => {
			if (msg.type === "log" && msg.level === "error") {
				addNotice("msg err", `[bg] ${msg.text}`);
			}
		});
	}, [chatTransport, addNotice]);

	useEffect(() => {
		void hydrateFromStorage();
	}, []);

	useEffect(() => {
		if (status !== "ready" || messages.length === 0) return;
		const last = messages[messages.length - 1];
		if (last?.role !== "assistant") return;
		currentSession.messages = messages.flatMap(uiMessageToSessionMessage);
		currentSession.updatedAt = Date.now();
		currentSession.title = deriveTitle(currentSession.messages);
		void persistCurrent();
	}, [status, messages]);

	useEffect(() => {
		const el = logRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, notices]);

	useEffect(() => {
		if (status !== "streaming" && status !== "submitted") inputRef.current?.focus();
	}, [status]);

	const busy = status === "streaming" || status === "submitted";

	const handleSubmit = useCallback((text: string) => {
		const mode = contextMode === "none" ? undefined : contextMode;
		chatTransport.setContextMode(mode);
		chatTransport.setWindowId(getPanelWindowId());
		sendMessage({ text });
		setContextMode("none");
	}, [sendMessage, contextMode, chatTransport]);

	const handleStop = useCallback(() => { stop(); }, [stop]);

	const title = useMemo(() => `${messages.length} message${messages.length === 1 ? "" : "s"}`, [messages]);

	return (
		<>
			<div className="chat-actions">
				<span id="chat-title">{title}</span>
				<button id="new-session" type="button" title="Start a fresh conversation" disabled={busy} onClick={() => void startFreshSession()}>
					+ New
				</button>
			</div>
			<ul id="log" ref={logRef} aria-live="polite">
				{messages.map((msg, i) => (
					<MessageView key={msg.id ?? i} msg={msg} />
				))}
				{notices.map((n) => (
					<li className={n.className} key={n.id}>{n.text}</li>
				))}
			</ul>
			<div className="context-row">
				<label className="context-label" htmlFor="context-mode">Context</label>
				<select
					id="context-mode"
					value={contextMode}
					onChange={(e) => setContextMode((e.target as HTMLSelectElement).value as ChatContextMode | "none")}
					onClick={(e) => e.stopPropagation()}
				>
					<option value="none">None</option>
					<option value="tabs">All tabs</option>
					<option value="current">Current tab</option>
				</select>
			</div>
			<form id="form" onSubmit={(e) => {
				e.preventDefault();
				if (busy) { handleStop(); return; }
				const input = inputRef.current;
				if (!input) return;
				const text = input.value.trim();
				if (!text) return;
				handleSubmit(text);
				input.value = "";
			}}>
				<textarea
					id="input"
					ref={inputRef}
					rows={1}
					disabled={busy}
					placeholder="ask the agent…  (Shift+Enter for newline)"
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
							e.preventDefault();
							(e.target as HTMLTextAreaElement).closest("form")?.requestSubmit();
						}
					}}
				/>
				<button type="submit" className={busy ? "danger" : undefined}>
					{busy ? "stop" : "send"}
				</button>
			</form>
		</>
	);
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function MessageView({ msg }: { msg: UIMessage }) {
	if (msg.role === "user") {
		const textParts = msg.parts.filter((p): p is { type: "text"; text: string } => p.type === "text");
		return (
			<li className="msg user">
				{textParts.map((p) => p.text).join("")}
			</li>
		);
	}

	if (msg.role === "assistant") {
		const elements: JSX.Element[] = [];
		let textContent = "";
		for (let i = 0; i < msg.parts.length; i++) {
			const part = msg.parts[i];
			if (part.type === "text") {
				textContent += part.text;
			} else if (part.type === "data-context" && typeof (part as { data: unknown }).data === "string") {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				elements.push(<ContextCard key={`ctx-${i}`} text={(part as { data: string }).data} />);
			} else if (part.type === "data-compress" && typeof (part as { data: unknown }).data === "object") {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				elements.push(<CompressNotice key={`cmp-${i}`} data={(part as { data: { beforeTokens: number; afterTokens: number; keptTurns: number; summary: string } }).data} />);
			} else if (part.type === "tool-invocation") {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				const tp = part as unknown as { toolCallId: string; toolName: string; input: unknown; state: string; output?: unknown; errorText?: string };
				elements.push(<ToolCardView key={tp.toolCallId ?? i} toolName={tp.toolName} part={tp} />);
			} else if (part.type.startsWith("tool-")) {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				const toolName = part.type.slice(5);
				const toolPart = part as { type: string; toolCallId: string; input: unknown; state: string; output?: unknown; errorText?: string };
				elements.push(<ToolCardView key={toolPart.toolCallId ?? i} toolName={toolName} part={toolPart} />);
			}
		}
		if (textContent) {
			elements.push(<div className="text md" key="t-end" dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
		}
		if (elements.length === 0) return null;
		const hasNonText = elements.some((e) => e.type === ToolCardView || e.type === ContextCard || e.type === CompressNotice);
		if (!hasNonText) {
			return <li className="msg assistant">{elements}</li>;
		}
		return (
			<>
				{elements.map((el, i) =>
					(el.type === ToolCardView || el.type === ContextCard || el.type === CompressNotice)
						? el
						: <li className="msg assistant" key={`a-${i}`}>{el}</li>,
				)}
			</>
		);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatJSON(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
