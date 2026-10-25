import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import type { JSX } from "preact";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { deriveTitle, getCurrentId, getSession, newSession, type Session, setCurrent, upsertSession } from "@shared/sessions";
import { listEnabledSkills, type Skill } from "@shared/skills";
import { sessionExportFilename, sessionExportJson } from "@shared/session-export";
import { type ChatContextMode } from "@shared/transport/protocol";
import { Markdown } from "./markdown";
import { ExtensionChatTransport } from "./extension-chat-transport";
import { getPanelWindowId } from "./window";
import type { BgToPanel, PanelToBg } from "@shared/transport/protocol";
import type { ImageContent, ModelUsage } from "@shared/ai/types";
import { toolOutputText, toolOutputToContent } from "@shared/ai/tool-output";
import { listUserCustomTools } from "@shared/custom-tools/storage";
import type { CustomToolMeta } from "@shared/custom-tools/types";
import { SETTINGS_STORAGE_KEY, loadSettings, type CuliqSettings, type ModelConfig } from "@shared/config";

export interface ChatTransport {
	send(msg: PanelToBg): void;
	onMessage(handler: (msg: BgToPanel) => void): () => void;
}

// Shared bubble utilities — px arbitrary values everywhere: the panel root is
// 15px, so rem-based utilities would shift metrics off the old pixel values.
const MSG_BASE = "max-w-full rounded-[8px] px-[14px] py-[10px] whitespace-pre-wrap break-words";
const USER_MSG = `${MSG_BASE} group relative self-end border`;
const ASSISTANT_MSG = `${MSG_BASE} self-start border border-current/[12%] bg-current/[6%]`;

// Tool call cards — border and status color follow the run state.
const TOOL_CARD = "self-stretch rounded-[8px] border bg-current/[3%] px-[10px] py-[8px] font-mono text-[0.82rem]";
const TOOL_BORDER = {
	running: "border-running/50",
	ok: "border-success/50",
	error: "border-danger/50",
} as const;
const TOOL_STATUS_COLOR = {
	running: "text-running",
	ok: "text-success",
	error: "text-danger",
} as const;
const TOOL_HEAD =
	"flex cursor-pointer items-center gap-[8px] select-none focus-visible:rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const TOOL_CHEVRON =
	"inline-block w-[10px] text-[0.78rem] leading-none text-current/50 transition-transform duration-150";
const TOOL_BODY =
	"mt-[6px] max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-[4px] bg-current/[5%] px-[8px] py-[6px] text-current/85";

/** Grow the composer textarea to fit its content, up to the CSS max-height. */
function autosizeInput(el: HTMLTextAreaElement): void {
	el.style.height = "auto";
	el.style.height = `${el.scrollHeight}px`;
}

interface Notice {
	id: number;
	variant: "err" | "notice";
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
	const resultText = new Map<string, { text: string; images: Array<{ mediaType: string; data: string }>; isError: boolean }>();
	for (const m of session.messages) {
		if (m.role === "toolResult") {
			const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
			const images = m.content
				.filter((c): c is ImageContent => c.type === "image")
				.map((c) => ({ mediaType: c.mediaType, data: c.data }));
			resultText.set(m.toolCallId, { text, images, isError: m.isError === true });
		}
	}
	return session.messages
		.filter((m) => m.role !== "toolResult")
		.map((m) => {
			if (m.role === "user") {
				const text = typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
				return { id: crypto.randomUUID(), role: "user" as const, parts: text ? [{ type: "text" as const, text }] : [] };
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
				} else if (b.type === "toolCall" && (b.name as string).startsWith("sandbox.")) {
				// Legacy sessions persisted bridge calls as toolCall
				// blocks. Restore them as display-only data-bridge
				// parts so they never re-enter the provider history.
				const output = resultText.get(b.id as string);
				parts.push({
					type: "data-bridge" as const,
					id: b.id as string,
					data: {
						name: b.name as string,
						arguments: b.arguments,
						...(output ? { result: output.text, isError: output.isError } : {}),
					},
				} as never);
			} else if (b.type === "toolCall") {
				const output = resultText.get(b.id as string);
				const toolName = b.name as string;
				if (output) {
					parts.push(
						(output.isError
							? {
									type: `tool-${toolName}` as const,
									toolCallId: b.id as string,
									input: b.arguments,
									state: "output-error" as const,
									errorText: output.text,
								}
							: {
									type: `tool-${toolName}` as const,
									toolCallId: b.id as string,
									input: b.arguments,
									state: "output-available" as const,
									output: { text: output.text, images: output.images },
								}) as never,
					);
				} else {
					parts.push({
						type: `tool-${toolName}` as const,
						toolCallId: b.id as string,
						input: b.arguments,
						state: "output-error" as const,
						errorText: "Tool call was interrupted before a result was received.",
					} as never);
				}
				} else if (b.type === "bridgeCall") {
				parts.push({
					type: "data-bridge" as const,
					id: b.id as string,
					data: {
						name: b.name as string,
						arguments: b.arguments,
						...(b.result !== undefined ? { result: b.result, isError: b.isError === true } : {}),
					},
				} as never);
			} else if (b.type === "context" && b.text) {
					parts.push({ type: "data-context" as const, id: "context", data: b.text as string } as never);
				} else if (b.type === "error" && b.text) {
					parts.push({ type: "data-error" as const, id: `error-${parts.length}`, data: b.text as string } as never);
				} else if (b.type === "compress" && b.summary) {
					parts.push({ type: "data-compress" as const, id: "compress", data: b.summary as string } as never);
				} else if (b.type === "subtask" && b.messages) {
					parts.push({ type: "data-subtask" as const, id: `subtask-${b.id as string}`, data: b.messages } as never);
				} else if (b.type === "usage") {
					const u = b as { input?: number; output?: number; cache?: number; totalIn?: number; totalOut?: number; totalCache?: number };
					parts.push({
						type: "data-usage" as const,
						id: `usage-r${usageRestored++}`,
						data: {
							input: u.input ?? 0,
							output: u.output ?? 0,
							...(u.cache !== undefined ? { cache: u.cache } : {}),
							...(u.totalIn !== undefined ? { totalIn: u.totalIn } : {}),
							...(u.totalOut !== undefined ? { totalOut: u.totalOut } : {}),
							...(u.totalCache !== undefined ? { totalCache: u.totalCache } : {}),
						},
					} as never);
				}
			}
			const usage = (m as { usage?: ModelUsage }).usage;
			if (usage && usageRestored === 0) {
				parts.push({
					type: "data-usage" as const,
					id: "usage-r0",
					data: {
						input: usage.inputTokens,
						output: usage.outputTokens,
						...(usage.cacheReadTokens !== undefined ? { cache: usage.cacheReadTokens } : {}),
					},
				} as never);
			}
			return { id: (m as { id?: string }).id ?? crypto.randomUUID(), role: "assistant" as const, parts };
		})
		.filter((m) => m.parts.length > 0);
}

/**
 * Sessions keep tool results as text: image blocks are stripped by
 * `upsertSession` anyway, and an in-memory screenshot would otherwise reach
 * the exported session as base64.
 */
function persistedToolResult(output: unknown): Array<{ type: "text"; text: string }> {
	return toolOutputToContent(output).filter((c): c is { type: "text"; text: string } => c.type === "text");
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
		| { type: "bridgeCall"; id: string; name: string; arguments: unknown; result?: string; isError?: boolean }
		| { type: "context"; text: string }
		| { type: "error"; text: string }
		| { type: "thinking"; thinking: string; signature?: string }
		| { type: "compress"; summary: string }
		| { type: "subtask"; id: string; messages: unknown }
		| { type: "usage"; input: number; output: number; cache?: number; totalIn?: number; totalOut?: number; totalCache?: number }
	> = [];
	const out: Session["messages"] = [];
	let usage: ModelUsage | undefined;
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
					content: persistedToolResult(tp.output),
				});
			} else if (tp.errorText) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: tp.errorText }],
					isError: true,
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
					content: persistedToolResult(tp.output),
				});
			} else if (tp.errorText) {
				out.push({
					role: "toolResult",
					toolCallId: tp.toolCallId,
					content: [{ type: "text", text: tp.errorText }],
					isError: true,
				});
			}
		} else if (pt.type === "data-context") {
			const data = (part as { data: unknown }).data;
			if (typeof data === "string" && data) blocks.push({ type: "context", text: data });
		} else if (pt.type === "data-error") {
			const data = (part as { data?: unknown }).data;
			if (typeof data === "string" && data) blocks.push({ type: "error", text: data });
		} else if (pt.type === "data-bridge") {
			const data = (part as { data?: unknown }).data as
				| { name?: string; arguments?: unknown; result?: string; isError?: boolean }
				| undefined;
			if (data && typeof data.name === "string") {
				blocks.push({
					type: "bridgeCall",
					id: (part as { id?: string }).id ?? crypto.randomUUID(),
					name: data.name,
					arguments: data.arguments ?? null,
					...(data.result !== undefined ? { result: data.result, isError: data.isError === true } : {}),
				} as never);
			}
		} else if (pt.type === "data-compress") {
			const data = (part as { data: unknown }).data;
			if (typeof data === "string" && data) blocks.push({ type: "compress", summary: data } as never);
		} else if (pt.type === "data-subtask") {
			const data = (part as { data: unknown }).data;
			const id = (part as { id?: string }).id ?? "subtask";
			if (data) blocks.push({ type: "subtask", id, messages: data } as never);
		} else if (pt.type === "data-usage") {
			const data = (part as { data: unknown }).data as
				| { input?: number; output?: number; cache?: number; totalIn?: number; totalOut?: number; totalCache?: number }
				| undefined;
			if (data && typeof data === "object") {
				blocks.push({
					type: "usage",
					input: data.input ?? 0,
					output: data.output ?? 0,
					...(data.cache !== undefined ? { cache: data.cache } : {}),
					...(data.totalIn !== undefined ? { totalIn: data.totalIn } : {}),
					...(data.totalOut !== undefined ? { totalOut: data.totalOut } : {}),
					...(data.totalCache !== undefined ? { totalCache: data.totalCache } : {}),
				});
				usage = {
					inputTokens: data.input ?? 0,
					outputTokens: data.output ?? 0,
					...(data.cache !== undefined ? { cacheReadTokens: data.cache } : {}),
				};
			}
		}
	}
	const assistantMsg: Session["messages"][number] = { role: "assistant", content: blocks as never, stopReason: "end" };
	if (usage) assistantMsg.usage = usage;
	// Never persist an assistant message with no content: a failed turn
	// would otherwise be stored as an empty shell that providers reject
	// (HTTP 400) on every subsequent send.
	if (blocks.length > 0) out.unshift(assistantMsg);
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
		<li className={`${TOOL_CARD} ${TOOL_BORDER.ok}`}>
			<div
				className={TOOL_HEAD}
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
				<span className={`${TOOL_CHEVRON} ${expanded ? "rotate-90" : ""}`} aria-hidden="true">▸</span>
				<code className="flex-1 font-semibold text-primary">context</code>
				<span className={`text-[0.7rem] tracking-[0.04em] uppercase ${TOOL_STATUS_COLOR.ok}`}>{label}</span>
			</div>
			{expanded && <pre className={TOOL_BODY}>{text}</pre>}
		</li>
	);
}

function ErrorCard({ text }: { text: string }) {
	return (
		<li className={`${TOOL_CARD} ${TOOL_BORDER.error}`}>
			<div className={TOOL_HEAD}>
				<span className={`${TOOL_CHEVRON} rotate-90`} aria-hidden="true">▸</span>
				<code className="flex-1 font-semibold text-primary">error</code>
				<span className={`text-[0.7rem] tracking-[0.04em] uppercase ${TOOL_STATUS_COLOR.error}`}>error</span>
			</div>
			<pre className={TOOL_BODY}>{text}</pre>
		</li>
	);
}

function ToolCardView({ toolName, part }: { toolName: string; part: { toolCallId: string; input: unknown; state: string; output?: unknown; errorText?: string } }) {
	const [expanded, setExpanded] = useState(false);
	const status = part.state.includes("error") ? "error" : part.state.includes("available") && part.output !== undefined ? "ok" : "running";
	const result = part.errorText ?? toolOutputText(part.output);
	// Check if output contains image data
	const images = typeof part.output === "object" && part.output !== null && "images" in part.output
		? (part.output as { images: Array<{ mediaType: string; data: string }> }).images
		: [];
	return (
		<li className={`${TOOL_CARD} ${TOOL_BORDER[status]}`}>
			<div
				className={TOOL_HEAD}
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
				<span className={`${TOOL_CHEVRON} ${expanded ? "rotate-90" : ""}`} aria-hidden="true">▸</span>
				<code className="flex-1 font-semibold text-primary">{toolName}</code>
				<span className={`text-[0.7rem] tracking-[0.04em] uppercase ${TOOL_STATUS_COLOR[status]}`}>
					{status === "running" ? "running…" : status}
				</span>
			</div>
			{expanded && <pre className={TOOL_BODY}>{formatJSON(part.input)}</pre>}
			{expanded && (images.length > 0 || result) && (
				<div className={TOOL_BODY}>
					{images.length > 0 && images.map((img, i) => (
						<img key={i} src={`data:${img.mediaType};base64,${img.data}`} className="my-[4px] max-w-full rounded-[4px]" alt={`Screenshot ${i + 1}`} />
					))}
					{result && <span>{result}</span>}
				</div>
			)}
		</li>
	);
}

function UsageBadge({ data }: { data: { input: number; output: number; cache?: number; totalIn?: number; totalOut?: number; totalCache?: number } }) {
	// `cache` is a subset of `input` (tokens the provider served from its
	// prompt cache); shown only when > 0 so providers that don't report it
	// stay clean.
	const cachedIn = data.cache ? ` (${formatTokens(data.cache)} cached)` : "";
	const parts = [`${formatTokens(data.input)} in${cachedIn}`, `${formatTokens(data.output)} out`];
	if (data.totalIn !== undefined && data.totalOut !== undefined) {
		const cachedTotal = data.totalCache ? ` (${formatTokens(data.totalCache)} cached)` : "";
		parts.push(`cumulative: ${formatTokens(data.totalIn)} in${cachedTotal} · ${formatTokens(data.totalOut)} out`);
	}
	return <span className="mt-[2px] block py-[2px] text-[0.72rem] text-current/50">{parts.join(" · ")}</span>;
}

interface SubtaskMessage {
	role: "assistant" | "toolResult";
	content: string;
	toolName?: string;
	usage?: ModelUsage;
	cumulative?: ModelUsage;
}

function SubtaskCard({ messages }: { messages: SubtaskMessage[] }) {
	const [expanded, setExpanded] = useState(true);
	return (
		<li className={`${TOOL_CARD} ${TOOL_BORDER.ok}`}>
			<div
				className={TOOL_HEAD}
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
				<span className={`${TOOL_CHEVRON} ${expanded ? "rotate-90" : ""}`} aria-hidden="true">▸</span>
				<code className="flex-1 font-semibold text-primary">subtask</code>
				<span className={`text-[0.7rem] tracking-[0.04em] uppercase ${TOOL_STATUS_COLOR.ok}`}>{messages.length} messages</span>
			</div>
			{expanded && (
				<div className="border-t border-current/10 px-[8px] py-[6px]">
					{messages.map((msg, i) => {
						if (msg.role === "assistant") {
							return (
								<div key={i} className="mb-[6px]">
									<div className="text whitespace-normal"><Markdown>{msg.content}</Markdown></div>
									{msg.usage && (
									<UsageBadge
										data={{
											input: msg.usage.inputTokens,
											output: msg.usage.outputTokens,
											...(msg.usage.cacheReadTokens !== undefined ? { cache: msg.usage.cacheReadTokens } : {}),
											...(msg.cumulative?.inputTokens !== undefined ? { totalIn: msg.cumulative.inputTokens } : {}),
											...(msg.cumulative?.outputTokens !== undefined ? { totalOut: msg.cumulative.outputTokens } : {}),
											...(msg.cumulative?.cacheReadTokens !== undefined ? { totalCache: msg.cumulative.cacheReadTokens } : {}),
										}}
									/>
								)}
								</div>
							);
						}
						return (
							<div key={i} className="border-b border-current/[6%] py-[3px] text-[0.78rem]">
								<code className="mr-[6px] text-current/60">{msg.toolName ?? "tool"}</code>
								<span className="text-current/70">{msg.content}</span>
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
	const [skills, setSkills] = useState<Skill[]>([]);
	const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [enabledModels, setEnabledModels] = useState<ModelConfig[]>([]);
	const [modelProviders, setModelProviders] = useState<CuliqSettings["providers"]>([]);
	const [modelId, setModelId] = useState("");
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const logRef = useRef<HTMLUListElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	const addNotice = useCallback((variant: "err" | "notice", text: string) => {
		setNotices((prev) => [...prev, { id: noticeId++, variant, text }].slice(-5));
	}, []);

	const { messages, status, sendMessage, stop, setMessages } = useChat({
		id: currentSession.id,
		// Initial messages for THIS chat id. Because ChatView is remounted per
		// session (via `key` in main.tsx), useChat re-initializes with the loaded
		// history here — the only reliable way to populate old messages.
		messages: convertSessionToUI(currentSession),
		transport: chatTransport,
		onError: (error) => {
			addNotice("err", error.message);
		},
	});

	useEffect(() => {
		return transport.onMessage((msg) => {
			if (msg.type === "log" && msg.level === "error") {
				addNotice("err", `[bg] ${msg.text}`);
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
		void listEnabledSkills().then(setSkills);
	}, []);

	useEffect(() => {
		const apply = (s: CuliqSettings) => {
			const enabled = s.models.filter((m) => m.enabled);
			setEnabledModels(enabled);
			setModelProviders(s.providers);
			setThinkingExpanded(s.expandThinking);
			setModelId((prev) => {
				if (prev && enabled.some((m) => m.id === prev)) return prev;
				const saved = currentSession.modelId;
				if (saved && enabled.some((m) => m.id === saved)) return saved;
				return enabled[0]?.id ?? "";
			});
		};
		void loadSettings().then(apply);
		const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
			if (area !== "local" || !(SETTINGS_STORAGE_KEY in changes)) return;
			void loadSettings().then(apply);
		};
		chrome.storage.onChanged.addListener(onChanged);
		return () => chrome.storage.onChanged.removeListener(onChanged);
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
		if (!modelId) {
			addNotice("err", "No model enabled. Enable one in Settings → Models.");
			return;
		}
		chatTransport.setModel(modelId);
		currentSession.modelId = modelId;
		const mode = contextMode === "none" ? undefined : contextMode;
		chatTransport.setContextMode(mode);
		chatTransport.setWindowId(getPanelWindowId());
		const allToolNames = customTools.map((t) => t.toolName);
		const isAllEnabled = enabledTools.size === allToolNames.length;
		chatTransport.setCustomTools(isAllEnabled ? undefined : [...enabledTools]);
		chatTransport.setReasoning(reasoning || undefined);
		chatTransport.setEnabledSkills(enabledSkills.length ? enabledSkills : undefined);
		if (editingId) {
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === editingId);
				return idx >= 0 ? prev.slice(0, idx) : prev;
			});
			setEditingId(null);
		}
		void sendMessage({ text });
		setContextMode("none");
		setEnabledSkills([]);
	}, [sendMessage, contextMode, chatTransport, customTools, enabledTools, reasoning, editingId, setMessages, enabledSkills, modelId, addNotice]);

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
			addNotice("err", `export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, [messages, addNotice]);

	const startEdit = useCallback((id: string) => {
		const msg = messages.find((m) => m.id === id);
		if (!msg) return;
		const text = msg.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
		setEditingId(id);
		if (inputRef.current) {
			inputRef.current.value = text;
			autosizeInput(inputRef.current);
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
						thinkingExpanded={thinkingExpanded}
						isEditing={msg.id === editingId}
						onEdit={startEdit}
						onCancelEdit={cancelEdit}
					/>
				))}
				{notices.map((n) => (
					<li
						className={
							n.variant === "err"
								? `${MSG_BASE} border-danger/35 text-danger`
								: `${MSG_BASE} border border-dashed border-current/25 text-[0.78rem] text-current/55`
						}
						key={n.id}
					>
						{n.text}
					</li>
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
						<option value="page+screenshot">Current page + screenshot</option>
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
				{skills.length > 0 && (
					<label className="context-field context-field-multi">
						<span>Skills</span>
						<select
							multiple
							size={Math.min(skills.length, 3)}
							onChange={(e) => {
								const selected = new Set<string>(
									Array.from((e.target as HTMLSelectElement).selectedOptions, (o) => o.value)
								);
								setEnabledSkills([...selected]);
							}}
						>
							{skills.map((s) => (
								<option key={s.name} value={s.name} selected={enabledSkills.includes(s.name)}>{s.name}</option>
							))}
						</select>
					</label>
				)}
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
				autosizeInput(input);
			}}>
				<textarea
					id="input"
					ref={inputRef}
					rows={1}
					disabled={busy}
					placeholder="ask the agent…  (Shift+Enter for newline)"
					onInput={(e) => autosizeInput(e.currentTarget)}
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
				<div className="composer-actions">
					<label className="context-field">
						<span>Model</span>
						<select
							value={modelId}
							onChange={(e) => {
								const id = (e.target as HTMLSelectElement).value;
								setModelId(id);
								currentSession.modelId = id;
								if (currentSession.messages.length > 0) void persistCurrent();
							}}
						>
							{enabledModels.length === 0 && <option value="">No enabled models</option>}
							{enabledModels.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name} ({modelProviders.find((p) => p.id === m.providerId)?.name ?? m.providerId})
								</option>
							))}
						</select>
					</label>
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
					<button type="submit" className={busy ? "danger" : undefined}>
						{busy ? "stop" : "send"}
					</button>
				</div>
			</form>
		</>
	);
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function ThinkingBlock({ text, defaultOpen }: { text: string; defaultOpen: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="mb-[4px]">
			<button
				type="button"
				className="cursor-pointer rounded-[4px] border border-current/20 bg-none px-[6px] py-[2px] text-[0.75rem] text-current/60 hover:bg-current/[6%] hover:text-inherit"
				onClick={() => setOpen((v) => !v)}
			>
				{open ? "hide thinking" : "show thinking"}
			</button>
			{open && (
				<pre className="m-0 mt-[4px] max-h-[300px] overflow-y-auto whitespace-pre-wrap rounded-[4px] border border-current/10 bg-current/[4%] px-[8px] py-[6px] text-[0.78rem] break-words">
					{text}
				</pre>
			)}
		</div>
	);
}

function MessageView({ msg, thinkingExpanded, isEditing, onEdit, onCancelEdit }: {
	msg: UIMessage;
	thinkingExpanded: boolean;
	isEditing?: boolean;
	onEdit?: (id: string) => void;
	onCancelEdit?: () => void;
}) {
	if (msg.role === "user") {
		const textParts = msg.parts.filter((p): p is { type: "text"; text: string } => p.type === "text");
		const text = textParts.map((p) => p.text).join("");
		return (
			<li
				className={
					isEditing
						? `${USER_MSG} bg-warning/[18%] border-warning/40`
						: `${USER_MSG} bg-primary/[18%] border-primary/35`
				}
			>
				<span>{text}</span>
				{isEditing ? (
					<span className="mt-[4px] flex items-center gap-[6px]">
						<span className="text-[0.7rem] italic text-warning/80">editing</span>
						<button
							type="button"
							className="cursor-pointer rounded-[3px] border border-current/25 bg-none px-[4px] py-0 text-[0.7rem]"
							onClick={() => onCancelEdit?.()}
						>
							cancel
						</button>
					</span>
				) : (
					<button
						type="button"
						className="absolute top-[2px] right-[2px] cursor-pointer rounded-[3px] border-none bg-current/10 px-[4px] py-0 text-[0.7rem] opacity-0 transition-opacity duration-150 group-hover:opacity-100"
						title="Edit message"
						onClick={() => onEdit?.(msg.id)}
					>
						edit
					</button>
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
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				if (part.text) {
					elements.push(<ThinkingBlock key={`th-${i}`} text={part.text as string} defaultOpen={thinkingExpanded} />);
				}
			} else if (part.type === "data-context" && typeof part.data === "string") {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				elements.push(<ContextCard key={`ctx-${i}`} text={part.data as string} />);
			} else if (part.type === "data-compress" && typeof part.data === "string") {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				elements.push(<ContextCard key={`cmp-${i}`} text={part.data} label="compressed" />);
			} else if (part.type === "data-usage" && typeof part.data === "object") {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				elements.push(
					<UsageBadge
						key={`ub-${i}`}
						data={part.data as { input: number; output: number; cache?: number; totalIn?: number; totalOut?: number; totalCache?: number }}
					/>,
				);
			} else if (part.type === "data-subtask" && Array.isArray(part.data)) {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				elements.push(<SubtaskCard key={`st-${i}`} messages={part.data as SubtaskMessage[]} />);
			} else if (part.type === "data-error" && typeof part.data === "string") {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				elements.push(<ErrorCard key={`err-${i}`} text={part.data} />);
			} else if (part.type === "data-bridge" && typeof part.data === "object") {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				const d = part.data as { name: string; arguments: unknown; result?: string; isError?: boolean };
				const bridgePart = {
					toolCallId: part.id as string,
					input: d.arguments,
					state: d.result !== undefined ? (d.isError ? "output-error" : "output-available") : "input-available",
					output: d.result,
					errorText: d.isError ? d.result : undefined,
				};
				elements.push(<ToolCardView key={`br-${part.id as string}`} toolName={d.name} part={bridgePart} />);
			} else if (part.type === "tool-invocation") {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				const tp = part as unknown as { toolCallId: string; toolName: string; input: unknown; state: string; output?: unknown; errorText?: string };
				elements.push(<ToolCardView key={tp.toolCallId ?? i} toolName={tp.toolName} part={tp} />);
			} else if (part.type.startsWith("tool-")) {
				if (textContent) {
					elements.push(<div className="text whitespace-normal" key={`t-${i}`}><Markdown>{textContent}</Markdown></div>);
					textContent = "";
				}
				const toolName = part.type.slice(5);
				const toolPart = part as { type: string; toolCallId: string; input: unknown; state: string; output?: unknown; errorText?: string };
				elements.push(<ToolCardView key={toolPart.toolCallId ?? i} toolName={toolName} part={toolPart} />);
			}
		}
		if (textContent) {
			elements.push(<div className="text whitespace-normal" key="t-end"><Markdown>{textContent}</Markdown></div>);
		}
		if (elements.length === 0) return null;
		const isCard = (el: JSX.Element) =>
			el.type === ToolCardView || el.type === ContextCard || el.type === UsageBadge || el.type === SubtaskCard || el.type === ErrorCard;
		if (elements.every((el) => !isCard(el))) {
			return <li className={ASSISTANT_MSG}>{elements}</li>;
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
					isCard(group[0]) ? group[0] : <li className={ASSISTANT_MSG} key={`a-${i}`}>{group}</li>,
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
