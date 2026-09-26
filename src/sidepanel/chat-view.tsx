import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import type { JSX } from "preact";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { deriveTitle, getCurrentId, getSession, newSession, type Session, setCurrent, upsertSession } from "@shared/sessions";
import { sessionExportFilename, sessionExportJson } from "@shared/session-export";
import { type ChatContextMode } from "@shared/transport/protocol";
import { renderMarkdown } from "./markdown";
import { ExtensionChatTransport } from "./extension-chat-transport";
import { getPanelWindowId } from "./window";
import type { BgToPanel, PanelToBg } from "@shared/transport/protocol";
import type { ImageContent } from "@shared/ai/types";
import { listUserCustomTools } from "@shared/custom-tools/storage";
import type { CustomToolMeta } from "@shared/custom-tools/types";

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
	const resultText = new Map<string, { text: string; images: Array<{ mediaType: string; data: string }> }>();
	for (const m of session.messages) {
		if (m.role === "toolResult") {
			const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
			const images = m.content
				.filter((c): c is ImageContent => c.type === "image")
				.map((c) => ({ mediaType: c.mediaType, data: c.data }));
			resultText.set(m.toolCallId, { text, images });
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
			let usageRestored = 0;
			for (const block of blocks) {
				const b = block as unknown as { type: string; [key: string]: unknown };
				if (b.type === "text" && b.text) {
					parts.push({ type: "text" as const, text: b.text as string });
				} else if (b.type === "thinking" && b.thinking) {
					const signature = b.signature as string | undefined;
					parts.push({
						type: "reasoning" as const,
						id: `reasoning-${parts.length}`,
						text: b.thinking as string,
						state: "done" as const,
						...(signature ? { providerMetadata: { anthropic: { signature } } } : {}),
					} as never);
				} else if (b.type === "toolCall") {
				const output = resultText.get(b.id as string);
				const toolName = b.name as string;
				if (output) {
					parts.push({
						type: `tool-${toolName}` as const,
						toolCallId: b.id as string,
						input: b.arguments,
						state: "output-available" as const,
						output,
					} as never);
				} else {
					parts.push({
						type: `tool-${toolName}` as const,
						toolCallId: b.id as string,
						input: b.arguments,
						state: "output-error" as const,
						errorText: "Tool call was interrupted before a result was received.",
					} as never);
				}
				} else if (b.type === "context" && b.text) {
					parts.push({ type: "data-context" as const, id: "context", data: b.text as string } as never);
				} else if (b.type === "compress" && b.summary) {
					parts.push({ type: "data-compress" as const, id: "compress", data: b.summary as string } as never);
				} else if (b.type === "subtask" && b.messages) {
					parts.push({ type: "data-subtask" as const, id: `subtask-${b.id as string}`, data: b.messages } as never);
				} else if (b.type === "usage") {
					const u = b as { input?: number; output?: number; totalIn?: number; totalOut?: number };
					parts.push({
						type: "data-usage" as const,
						id: `usage-r${usageRestored++}`,
						data: {
							input: u.input ?? 0,
							output: u.output ?? 0,
							...(u.totalIn !== undefined ? { totalIn: u.totalIn } : {}),
							...(u.totalOut !== undefined ? { totalOut: u.totalOut } : {}),
						},
					} as never);
				}
			}
			const usage = (m as { usage?: { inputTokens: number; outputTokens: number } }).usage;
			if (usage && usageRestored === 0) {
				parts.push({ type: "data-usage" as const, id: "usage-r0", data: { input: usage.inputTokens, output: usage.outputTokens } } as never);
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
		| { type: "thinking"; thinking: string; signature?: string }
		| { type: "compress"; summary: string }
		| { type: "subtask"; id: string; messages: unknown }
		| { type: "usage"; input: number; output: number; totalIn?: number; totalOut?: number }
	> = [];
	const out: Session["messages"] = [];
	let usage: { inputTokens: number; outputTokens: number } | undefined;
	for (const part of m.parts) {
		const pt = part as { type: string; [key: string]: unknown };
		if (pt.type === "text" && pt.text) {
			blocks.push({ type: "text", text: pt.text as string });
		} else if (pt.type === "reasoning") {
			const text = pt.text as string | undefined;
			if (text) {
				const signature = (pt.providerMetadata as { anthropic?: { signature?: string } } | undefined)?.anthropic?.signature;
				blocks.push({ type: "thinking", thinking: text, ...(signature ? { signature } : {}) });
			}
		} else if (pt.type === "tool-invocation") {
			// Live-streamed tool calls use the AI SDK's native part type.
			const tp = pt as unknown as { toolCallId: string; toolName: string; input?: unknown; output?: unknown; errorText?: string };
			blocks.push({ type: "toolCall", id: tp.toolCallId, name: tp.toolName, arguments: (tp.input ?? {}) as Record<string, unknown> });
			if (tp.output != null) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output) }],
				});
			} else if (tp.errorText) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: tp.errorText }],
				});
			}
		} else if (pt.type.startsWith("tool-")) {
			const tp = pt as unknown as { toolCallId: string; input: unknown; output?: unknown; errorText?: string };
			const name = pt.type.slice(5);
			blocks.push({ type: "toolCall", id: tp.toolCallId, name, arguments: (tp.input ?? {}) as Record<string, unknown> });
			if (tp.output != null) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: typeof tp.output === "string" ? tp.output : JSON.stringify(tp.output) }],
				});
			} else if (tp.errorText) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: tp.errorText }],
				});
			}
		} else if (pt.type === "data-context") {
			const data = (part as { data: unknown }).data;
			if (typeof data === "string" && data) blocks.push({ type: "context", text: data });
		} else if (pt.type === "data-compress") {
			const data = (part as { data: unknown }).data;
			if (typeof data === "string" && data) blocks.push({ type: "compress", summary: data } as never);
		} else if (pt.type === "data-subtask") {
			const data = (part as { data: unknown }).data;
			const id = (part as { id?: string }).id ?? "subtask";
			if (data) blocks.push({ type: "subtask", id, messages: data } as never);
		} else if (pt.type === "data-usage") {
			const data = (part as { data: unknown }).data as
				| { input?: number; output?: number; totalIn?: number; totalOut?: number }
				| undefined;
			if (data && typeof data === "object") {
				blocks.push({
					type: "usage",
					input: data.input ?? 0,
					output: data.output ?? 0,
					...(data.totalIn !== undefined ? { totalIn: data.totalIn } : {}),
					...(data.totalOut !== undefined ? { totalOut: data.totalOut } : {}),
				});
				usage = { inputTokens: data.input ?? 0, outputTokens: data.output ?? 0 };
			}
		}
	}
	const assistantMsg: Session["messages"][number] = { role: "assistant", content: blocks as never, stopReason: "end" };
	if (usage) assistantMsg.usage = usage;
	out.unshift(assistantMsg);
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

function ContextCard({ text, label = "sent" }: { text: string; label?: string }) {
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
				<span className="tool-status">{label}</span>
			</div>
			<pre className="tool-body">{text}</pre>
		</li>
	);
}

function ToolCardView({ toolName, part }: { toolName: string; part: { toolCallId: string; input: unknown; state: string; output?: unknown; errorText?: string } }) {
	const [expanded, setExpanded] = useState(false);
	const status = part.state.includes("error") ? "error" : part.state.includes("available") && part.output !== undefined ? "ok" : "running";
	const result = part.errorText ?? (typeof part.output === "string" ? part.output : part.output ? JSON.stringify(part.output) : "");
	// Check if output contains image data
	const images = typeof part.output === "object" && part.output !== null && "images" in part.output
		? (part.output as { images: Array<{ mediaType: string; data: string }> }).images
		: [];
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
			<div className="tool-body">
				{images.length > 0 && images.map((img, i) => (
					<img key={i} src={`data:${img.mediaType};base64,${img.data}`} className="tool-screenshot" alt={`Screenshot ${i + 1}`} />
				))}
				{result && <span>{result}</span>}
			</div>
		</li>
	);
}

function UsageBadge({ data }: { data: { input: number; output: number; totalIn?: number; totalOut?: number } }) {
	const parts = [`${formatTokens(data.input)} in`, `${formatTokens(data.output)} out`];
	if (data.totalIn !== undefined && data.totalOut !== undefined) {
		parts.push(`cumulative: ${formatTokens(data.totalIn)} in · ${formatTokens(data.totalOut)} out`);
	}
	return <span className="usage-badge">{parts.join(" · ")}</span>;
}

interface SubtaskMessage {
	role: "assistant" | "toolResult";
	content: string;
	toolName?: string;
	usage?: { inputTokens: number; outputTokens: number };
	cumulative?: { inputTokens: number; outputTokens: number };
}

function SubtaskCard({ messages }: { messages: SubtaskMessage[] }) {
	const [expanded, setExpanded] = useState(true);
	return (
		<li className="tool-card subtask-card" data-status="ok" data-expanded={String(expanded)}>
			<div
				className="tool-head"
				role="button"
				tabIndex={0}
				aria-expanded={expanded}
				title="Click to expand"
				onClick={() => setExpanded((v) => !v)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setExpanded((v) => !v);
					}
				}}
			>
				<span className="tool-chevron" aria-hidden="true">▸</span>
				<code>subtask</code>
				<span className="tool-status">{messages.length} messages</span>
			</div>
			{expanded && (
				<div className="subtask-body">
					{messages.map((msg, i) => {
						if (msg.role === "assistant") {
							return (
								<div key={i} className="subtask-msg">
									<div className="text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
									{msg.usage && <UsageBadge data={{ input: msg.usage.inputTokens, output: msg.usage.outputTokens, totalIn: msg.cumulative?.inputTokens, totalOut: msg.cumulative?.outputTokens }} />}
								</div>
							);
						}
						return (
							<div key={i} className="subtask-tool">
								<code>{msg.toolName ?? "tool"}</code>
								<span className="subtask-tool-content">{msg.content}</span>
							</div>
						);
					})}
				</div>
			)}
		</li>
	);
}

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

export function ChatView({ transport, chatTransport }: { transport: ChatTransport; chatTransport: ExtensionChatTransport }) {
	const [notices, setNotices] = useState<Notice[]>([]);
	const [contextMode, setContextMode] = useState<ChatContextMode | "none">("none");
	const [customTools, setCustomTools] = useState<CustomToolMeta[]>([]);
	const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
	const [reasoning, setReasoning] = useState<string>("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const logRef = useRef<HTMLUListElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	const addNotice = useCallback((className: string, text: string) => {
		setNotices((prev) => [...prev, { id: noticeId++, className, text }]);
	}, []);

	const { messages, status, sendMessage, stop, setMessages } = useChat({
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
	}, [transport, chatTransport, addNotice]);

	useEffect(() => {
		void hydrateFromStorage();
	}, []);

	useEffect(() => {
		void listUserCustomTools().then((tools) => {
			setCustomTools(tools);
			setEnabledTools(new Set(tools.map((t) => t.toolName)));
		});
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
		const allToolNames = customTools.map((t) => t.toolName);
		const isAllEnabled = enabledTools.size === allToolNames.length;
		chatTransport.setCustomTools(isAllEnabled ? undefined : [...enabledTools]);
		chatTransport.setReasoning(reasoning || undefined);
		if (editingId) {
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === editingId);
				return idx >= 0 ? prev.slice(0, idx) : prev;
			});
			setEditingId(null);
		}
		void sendMessage({ text });
		setContextMode("none");
	}, [sendMessage, contextMode, chatTransport, customTools, enabledTools, reasoning, editingId, setMessages]);

	const handleStop = useCallback(() => { void stop(); }, [stop]);

	const exportSession = useCallback(() => {
		const session: Session = { ...currentSession, messages: messages.flatMap(uiMessageToSessionMessage) };
		try {
			const url = URL.createObjectURL(new Blob([sessionExportJson(session)], { type: "application/json" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = sessionExportFilename(session);
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (err) {
			addNotice("msg err", `export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, [messages, addNotice]);

	const startEdit = useCallback((id: string) => {
		const msg = messages.find((m) => m.id === id);
		if (!msg) return;
		const text = msg.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
		setEditingId(id);
		if (inputRef.current) {
			inputRef.current.value = text;
			inputRef.current.focus();
		}
	}, [messages]);

	const cancelEdit = useCallback(() => {
		setEditingId(null);
		if (inputRef.current) {
			inputRef.current.value = "";
		}
	}, []);

	const title = useMemo(() => `${messages.length} message${messages.length === 1 ? "" : "s"}`, [messages]);

	return (
		<>
			<div className="chat-actions">
				<span id="chat-title">{title}</span>
				<button
					id="export-session"
					type="button"
					title="Export this conversation as raw JSON (includes tool results / page content)"
					disabled={messages.length === 0}
					onClick={exportSession}
				>
					Export
				</button>
				<button id="new-session" type="button" title="Start a fresh conversation" disabled={busy} onClick={() => void startFreshSession()}>
					+ New
				</button>
			</div>
			<ul id="log" ref={logRef} aria-live="polite">
				{messages.map((msg, i) => (
					<MessageView
						key={msg.id ?? i}
						msg={msg}
						isEditing={msg.id === editingId}
						onEdit={startEdit}
						onCancelEdit={cancelEdit}
					/>
				))}
				{notices.map((n) => (
					<li className={n.className} key={n.id}>{n.text}</li>
				))}
			</ul>
			<div className="context-row">
				<label className="context-field">
					<span>Context</span>
					<select
						value={contextMode}
						onChange={(e) => setContextMode((e.target as HTMLSelectElement).value as ChatContextMode | "none")}
					>
						<option value="none">None</option>
						<option value="tabs">All tabs</option>
						<option value="current">Current tab</option>
					</select>
				</label>
				{customTools.length > 0 && (
					<label className="context-field context-field-multi">
						<span>Tools</span>
						<select
							multiple
							size={Math.min(customTools.length, 3)}
							onChange={(e) => {
								const selected = new Set<string>(
									Array.from((e.target as HTMLSelectElement).selectedOptions, (o) => o.value)
								);
								setEnabledTools(selected);
							}}
						>
							{customTools.map((t) => (
								<option key={t.toolName} value={t.toolName} selected={enabledTools.has(t.toolName)}>{t.toolName}</option>
							))}
						</select>
					</label>
				)}
				<label className="context-field">
					<span>Thinking</span>
					<select
						value={reasoning}
						onChange={(e) => setReasoning((e.target as HTMLSelectElement).value)}
					>
						<option value="">Default</option>
						<option value="none">Off</option>
						<option value="minimal">Minimal</option>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
						<option value="xhigh">Maximum</option>
					</select>
				</label>
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
						if (e.key === "Escape" && editingId) {
							e.preventDefault();
							cancelEdit();
							return;
						}
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

function ThinkingBlock({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="thinking-block">
			<button type="button" className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
				{open ? "hide thinking" : "show thinking"}
			</button>
			{open && <pre className="thinking-content">{text}</pre>}
		</div>
	);
}

function MessageView({ msg, isEditing, onEdit, onCancelEdit }: {
	msg: UIMessage;
	isEditing?: boolean;
	onEdit?: (id: string) => void;
	onCancelEdit?: () => void;
}) {
	if (msg.role === "user") {
		const textParts = msg.parts.filter((p): p is { type: "text"; text: string } => p.type === "text");
		const text = textParts.map((p) => p.text).join("");
		return (
			<li className={`msg user ${isEditing ? "editing" : ""}`}>
				<span className="msg-text">{text}</span>
				{isEditing ? (
					<span className="msg-editing">
						<span className="msg-editing-label">editing</span>
						<button type="button" className="msg-cancel" onClick={() => onCancelEdit?.()}>cancel</button>
					</span>
				) : (
					<button type="button" className="msg-edit" title="Edit message" onClick={() => onEdit?.(msg.id)}>edit</button>
				)}
			</li>
		);
	}

	if (msg.role === "assistant") {
		const elements: JSX.Element[] = [];
		let textContent = "";
		for (let i = 0; i < msg.parts.length; i++) {
			const part = msg.parts[i] as { type: string; [key: string]: unknown };
			if (part.type === "text") {
				textContent += part.text as string;
			} else if (part.type === "reasoning") {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				if (part.text) {
					elements.push(<ThinkingBlock key={`th-${i}`} text={part.text as string} />);
				}
			} else if (part.type === "data-context" && typeof part.data === "string") {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				elements.push(<ContextCard key={`ctx-${i}`} text={part.data as string} />);
			} else if (part.type === "data-compress" && typeof part.data === "string") {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				elements.push(<ContextCard key={`cmp-${i}`} text={part.data} label="compressed" />);
			} else if (part.type === "data-usage" && typeof part.data === "object") {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				elements.push(<UsageBadge key={`ub-${i}`} data={part.data as { input: number; output: number; totalIn?: number; totalOut?: number }} />);
			} else if (part.type === "data-subtask" && Array.isArray(part.data)) {
				if (textContent) {
					elements.push(<div className="text md" key={`t-${i}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }} />);
					textContent = "";
				}
				elements.push(<SubtaskCard key={`st-${i}`} messages={part.data as SubtaskMessage[]} />);
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
		const isCard = (el: JSX.Element) =>
			el.type === ToolCardView || el.type === ContextCard || el.type === UsageBadge || el.type === SubtaskCard;
		if (elements.every((el) => !isCard(el))) {
			return <li className="msg assistant">{elements}</li>;
		}
		// Consecutive in-flow elements share one bubble — thinking sits directly
		// above its answer instead of occupying a mostly-empty bubble of its own,
		// which read as a blank gap between the two. Cards and badges stand alone.
		const groups: JSX.Element[][] = [];
		for (const el of elements) {
			const last = groups[groups.length - 1];
			if (isCard(el) || !last || isCard(last[0])) groups.push([el]);
			else last.push(el);
		}
		return (
			<>
				{groups.map((group, i) =>
					isCard(group[0]) ? group[0] : <li className="msg assistant" key={`a-${i}`}>{group}</li>,
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
