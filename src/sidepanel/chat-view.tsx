import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { AgentEvent } from "@shared/agent/types";
import type { Message, ToolResultContent } from "@shared/ai/types";
import { deriveTitle, getCurrentId, getSession, newSession, type Session, setCurrent, upsertSession } from "@shared/sessions";
import { type BgToPanel, type PanelToBg } from "@shared/transport/protocol";
import { renderMarkdown } from "./markdown";

export interface ChatTransport {
	send(msg: PanelToBg): void;
	onMessage(handler: (msg: BgToPanel) => void): () => void;
}

interface LiveToolCard {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: "running" | "ok" | "error";
	result: string;
}

/** Chronological log entries of the in-progress run: bubbles and tool cards interleaved. */
type LiveItem = { kind: "bubble"; spans: { index: number; raw: string }[] } | { kind: "tool"; card: LiveToolCard };

interface LiveState {
	items: LiveItem[];
}

interface Notice {
	id: number;
	className: string;
	text: string;
}

interface ChatStore {
	current: Session;
	persisted: boolean;
	turnId?: string;
	busy: boolean;
	live: LiveState | null;
	notices: Notice[];
	listeners: Set<() => void>;
}

const store: ChatStore = {
	current: newSession(),
	persisted: false,
	busy: false,
	live: null,
	notices: [],
	listeners: new Set(),
};

function notify(): void {
	for (const cb of store.listeners) cb();
}

/** Re-render on any store change. History markdown is cached (see getHistory), so deltas stay cheap. */
function useStoreUpdate(): void {
	const [, force] = useState(0);
	useEffect(() => {
		const onNotify = () => force((v) => v + 1);
		store.listeners.add(onNotify);
		return () => {
			store.listeners.delete(onNotify);
		};
	}, []);
}

const sessionChangeListeners = new Set<() => void>();
export function onSessionChange(cb: () => void): () => void {
	sessionChangeListeners.add(cb);
	return () => sessionChangeListeners.delete(cb);
}

function notifySessionChange(): void {
	for (const cb of sessionChangeListeners) cb();
}

export function isBusy(): boolean {
	return store.turnId !== undefined;
}

export function currentSessionId(): string {
	return store.current.id;
}

let noticeId = 0;
function addNotice(className: string, text: string): void {
	store.notices = [...store.notices, { id: noticeId++, className, text }];
	notify();
}

async function persistCurrent(): Promise<void> {
	await upsertSession(store.current);
	if (!store.persisted) {
		store.persisted = true;
		await setCurrent(store.current.id);
	}
	notifySessionChange();
}

function handleAgentEvent(event: AgentEvent): void {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "assistant") {
				const items = store.live ? [...store.live.items, { kind: "bubble" as const, spans: [] }] : [{ kind: "bubble" as const, spans: [] }];
				store.live = { items };
				notify();
			}
			return;
		case "message_update":
			if (!store.live) return;
			{
				let bubble: Extract<LiveItem, { kind: "bubble" }> | undefined;
				for (let i = store.live.items.length - 1; i >= 0; i--) {
					const item = store.live.items[i];
					if (item.kind === "bubble") {
						bubble = item;
						break;
					}
				}
				if (bubble) {
					let span = bubble.spans.find((s) => s.index === event.delta.contentIndex);
					if (!span) {
						span = { index: event.delta.contentIndex, raw: "" };
						bubble.spans.push(span);
					}
					span.raw += event.delta.text;
				}
				store.live = { ...store.live };
			}
			notify();
			return;
		case "tool_execution_start":
			if (!store.live) return;
			store.live = {
				items: [...store.live.items, { kind: "tool", card: { id: event.toolCallId, name: event.toolName, args: event.args, status: "running", result: "" } }],
			};
			notify();
			return;
		case "tool_execution_end":
			if (!store.live) return;
			store.live = {
				items: store.live.items.map((item) =>
					item.kind === "tool" && item.card.id === event.toolCallId
						? { kind: "tool", card: { ...item.card, status: event.isError ? "error" : "ok", result: toolResultText(event.result.content) } }
						: item,
				),
			};
			notify();
			return;
		case "context_compressed":
			addNotice(
				"msg notice",
				`Context compressed: ${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens · kept ${event.keptTurns} recent turn${event.keptTurns === 1 ? "" : "s"} verbatim`,
			);
			return;
		case "agent_end":
			finalizeAgent(event.messages, event.stopReason, event.errorMessage);
			return;
	}
}

function finalizeAgent(messages: Message[], stopReason: string, errorMessage?: string): void {
	store.current.messages = messages;
	store.current.updatedAt = Date.now();
	store.current.title = deriveTitle(messages);
	store.live = null;
	store.turnId = undefined;
	store.busy = false;
	notify();
	if (stopReason === "error" && errorMessage) addNotice("msg err", errorMessage);
	else if (stopReason === "max_turns") addNotice("msg err", "Reached max turns. Send another message to continue.");
	else if (stopReason === "aborted") addNotice("msg err", "Stopped.");
	void persistCurrent();
}

function submitTurn(transport: ChatTransport, text: string): void {
	const trimmed = text.trim();
	if (!trimmed || store.turnId) return;
	store.current.messages = [...store.current.messages, { role: "user", content: trimmed }];
	store.current.updatedAt = Date.now();
	store.current.title = deriveTitle(store.current.messages);
	store.live = null;
	const turnId = crypto.randomUUID();
	store.turnId = turnId;
	store.busy = true;
	notify();
	void persistCurrent();
	transport.send({ type: "chat_send", turnId, messages: store.current.messages });
}

export async function loadSessionIntoChat(id: string): Promise<void> {
	if (store.turnId) return;
	const session = await getSession(id);
	if (!session) return;
	store.current = session;
	store.persisted = true;
	store.live = null;
	store.notices = [];
	store.current.messages = session.messages;
	notify();
	await setCurrent(session.id);
	notifySessionChange();
}

export async function startFreshSession(): Promise<void> {
	if (store.turnId) return;
	store.current = newSession();
	store.persisted = false;
	store.live = null;
	store.notices = [];
	notify();
	await setCurrent(null);
	notifySessionChange();
}

async function hydrateFromStorage(): Promise<void> {
	const id = await getCurrentId();
	if (!id) return;
	const session = await getSession(id);
	if (!session) return;
	store.current = session;
	store.persisted = true;
	store.current.messages = session.messages;
	notify();
	notifySessionChange();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type HistoryItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; textBlocks: { index: number; html: string }[] }
	| { kind: "tool"; card: LiveToolCard };

function buildHistory(messages: Message[]): HistoryItem[] {
	const items: HistoryItem[] = [];
	const pending = new Map<string, number>();
	for (const m of messages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("");
			items.push({ kind: "user", text });
		} else if (m.role === "assistant") {
			let bubble: Extract<HistoryItem, { kind: "assistant" }> | null = null;
			for (let i = 0; i < m.content.length; i++) {
				const block = m.content[i];
				if (block.type === "text" && block.text.length > 0) {
					if (!bubble) {
						bubble = { kind: "assistant", textBlocks: [] };
						items.push(bubble);
					}
					bubble.textBlocks.push({ index: i, html: renderMarkdown(block.text) });
				} else if (block.type === "toolCall") {
					pending.set(block.id, items.length);
					items.push({ kind: "tool", card: { id: block.id, name: block.name, args: block.arguments, status: "running", result: "" } });
				}
			}
		} else if (m.role === "toolResult") {
			const idx = pending.get(m.toolCallId);
			if (idx === undefined) continue;
			const item = items[idx];
			if (item.kind === "tool") {
				item.card.status = m.isError ? "error" : "ok";
				item.card.result = toolResultText(m.content);
			}
			pending.delete(m.toolCallId);
		}
	}
	return items;
}

// Rebuild history only when the messages reference changes (never per streaming delta).
let historyCache: { messages: Message[]; items: HistoryItem[] } | null = null;
function getHistory(messages: Message[]): HistoryItem[] {
	if (!historyCache || historyCache.messages !== messages) {
		historyCache = { messages, items: buildHistory(messages) };
	}
	return historyCache.items;
}

function renderHistoryItem(item: HistoryItem, index: number): JSX.Element {
	switch (item.kind) {
		case "user":
			return (
				<li className="msg user" key={index}>
					{item.text}
				</li>
			);
		case "assistant":
			return (
				<li className="msg assistant" key={index}>
					{item.textBlocks.map((t) => (
						<div className="text md" key={t.index} dangerouslySetInnerHTML={{ __html: t.html }} />
					))}
				</li>
			);
		case "tool":
			return <ToolCardView key={item.card.id} card={item.card} />;
	}
}

function ToolCardView({ card }: { card: LiveToolCard }) {
	const [expanded, setExpanded] = useState(false);
	const toggle = () => setExpanded(!expanded);
	return (
		<li className="tool-card" data-status={card.status} data-expanded={String(expanded)}>
			<div
				className="tool-head"
				role="button"
				tabIndex={0}
				aria-expanded={expanded}
				title="Click to expand"
				onClick={toggle}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						toggle();
					}
				}}
			>
				<span className="tool-chevron" aria-hidden="true">
					▸
				</span>
				<code>{card.name}</code>
				<span className="tool-status">{card.status === "running" ? "running…" : card.status}</span>
			</div>
			<pre className="tool-args">{formatJSON(card.args)}</pre>
			<div className="tool-body">{card.result}</div>
		</li>
	);
}

function Composer({ busy, transport, inputRef }: { busy: boolean; transport: ChatTransport; inputRef: { current: HTMLTextAreaElement | null } }) {
	const [value, setValue] = useState("");
	const submit = (e: Event) => {
		e.preventDefault();
		if (busy) {
			const turnId = store.turnId;
			if (turnId) transport.send({ type: "chat_abort", turnId });
			return;
		}
		submitTurn(transport, value);
		setValue("");
	};
	return (
		<form id="form" onSubmit={submit}>
			<textarea
				id="input"
				ref={inputRef}
				rows={1}
				value={value}
				disabled={busy}
				placeholder="ask the agent…  (Shift+Enter for newline)"
				onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
						e.preventDefault();
						submit(e);
					}
				}}
			/>
			<button type="submit" className={busy ? "danger" : undefined}>
				{busy ? "stop" : "send"}
			</button>
		</form>
	);
}

export function ChatView({ transport }: { transport: ChatTransport }) {
	useStoreUpdate();
	const messages = store.current.messages;
	const live = store.live;
	const notices = store.notices;
	const busy = store.busy;
	const logRef = useRef<HTMLUListElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		return transport.onMessage((msg) => {
			if (msg.type === "log") {
				if (msg.level === "error") addNotice("msg err", `[bg] ${msg.text}`);
				return;
			}
			if (msg.type === "agent_event") handleAgentEvent(msg.event);
		});
	}, [transport]);

	useEffect(() => {
		void hydrateFromStorage();
	}, []);

	useEffect(() => {
		const el = logRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, live, notices]);

	useEffect(() => {
		if (!busy) inputRef.current?.focus();
	}, [messages, busy]);

	const history = useMemo(() => getHistory(messages), [messages]);

	const title = useMemo(() => {
		const liveBubbles = live ? live.items.filter((i) => i.kind === "bubble").length : 0;
		const count = messages.length + liveBubbles;
		const tokens = totalTokens(messages);
		const parts = [`${count} message${count === 1 ? "" : "s"}`];
		if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
		return parts.join("  ·  ");
	}, [messages, live]);

	return (
		<>
			<div className="chat-actions">
				<span id="chat-title">{title}</span>
				<button id="new-session" type="button" title="Start a fresh conversation" disabled={busy} onClick={() => void startFreshSession()}>
					+ New
				</button>
			</div>
			<ul id="log" ref={logRef} aria-live="polite">
				{history.map(renderHistoryItem)}
				{live?.items.map((item, i) =>
					item.kind === "bubble"
						? item.spans.length > 0
							? (
									<li className="msg assistant" key={`live-${i}`}>
										{item.spans.map((s) => (
											<div className="text md" key={s.index} dangerouslySetInnerHTML={{ __html: renderMarkdown(s.raw) }} />
										))}
									</li>
								)
							: null
						: <ToolCardView key={item.card.id} card={item.card} />,
				)}
				{notices.map((n) => (
					<li className={n.className} key={n.id}>
						{n.text}
					</li>
				))}
			</ul>
			<Composer busy={busy} transport={transport} inputRef={inputRef} />
		</>
	);
}

function toolResultText(content: ToolResultContent[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function totalTokens(messages: Message[]): number {
	let sum = 0;
	for (const m of messages) {
		if (m.role === "assistant" && m.usage) {
			sum += m.usage.inputTokens + m.usage.outputTokens;
		}
	}
	return sum;
}

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
