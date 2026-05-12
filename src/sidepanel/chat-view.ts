import type { AgentEvent, AgentToolResult } from "@shared/agent/types";
import type { AssistantMessage, Message } from "@shared/ai/types";
import {
	deriveTitle,
	getCurrentId,
	getSession,
	newSession,
	type Session,
	setCurrent,
	upsertSession,
} from "@shared/sessions";
import { type BgToPanel, type PanelToBg } from "@shared/transport/protocol";
import { renderMarkdown } from "./markdown";

const logEl = document.getElementById("log") as HTMLUListElement;
const formEl = document.getElementById("form") as HTMLFormElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = formEl.querySelector("button") as HTMLButtonElement;
const newSessionBtn = document.getElementById("new-session") as HTMLButtonElement;
const titleEl = document.getElementById("chat-title") as HTMLSpanElement;

interface AssistantBubbleRef {
	li: HTMLLIElement;
	textByIndex: Map<number, HTMLElement>;
}

interface ToolCardRef {
	li: HTMLLIElement;
	bodyEl: HTMLDivElement;
	statusEl: HTMLSpanElement;
}

interface RuntimeState {
	current: Session;
	persisted: boolean;
	currentAssistant?: AssistantBubbleRef;
	toolCards: Map<string, ToolCardRef>;
	turnId?: string;
}

const state: RuntimeState = {
	current: newSession(),
	persisted: false,
	toolCards: new Map(),
};

export interface ChatTransport {
	send(msg: PanelToBg): void;
	onMessage(handler: (msg: BgToPanel) => void): () => void;
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
	return state.turnId !== undefined;
}

export function currentSessionId(): string {
	return state.current.id;
}

export async function loadSessionIntoChat(id: string): Promise<void> {
	if (state.turnId) return;
	const session = await getSession(id);
	if (!session) return;
	state.current = session;
	state.persisted = true;
	state.currentAssistant = undefined;
	state.toolCards.clear();
	logEl.innerHTML = "";
	renderHistory(session.messages);
	await setCurrent(session.id);
	updateTitle();
	notifySessionChange();
	inputEl.focus();
}

export async function startFreshSession(): Promise<void> {
	if (state.turnId) return;
	state.current = newSession();
	state.persisted = false;
	state.currentAssistant = undefined;
	state.toolCards.clear();
	logEl.innerHTML = "";
	await setCurrent(null);
	updateTitle();
	notifySessionChange();
	inputEl.focus();
}

export function mountChat(transport: ChatTransport): void {
	transport.onMessage((msg) => {
		if (msg.type === "log") {
			if (msg.level === "error") appendError(`[bg] ${msg.text}`);
			return;
		}
		if (msg.type === "agent_event") {
			handleAgentEvent(msg.event);
		}
	});

	formEl.addEventListener("submit", (e) => {
		e.preventDefault();
		onSubmitOrAbort(transport);
	});

	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			onSubmitOrAbort(transport);
		}
	});

	newSessionBtn.addEventListener("click", () => void startFreshSession());

	updateTitle();
	inputEl.focus();
	void hydrateFromStorage();
}

async function hydrateFromStorage(): Promise<void> {
	const id = await getCurrentId();
	if (!id) return;
	const session = await getSession(id);
	if (!session) return;
	state.current = session;
	state.persisted = true;
	renderHistory(session.messages);
	updateTitle();
	notifySessionChange();
}

function onSubmitOrAbort(transport: ChatTransport): void {
	if (state.turnId) {
		transport.send({ type: "chat_abort", turnId: state.turnId });
		return;
	}
	const text = inputEl.value.trim();
	if (!text) return;

	state.current.messages.push({ role: "user", content: text });
	state.current.updatedAt = Date.now();
	state.current.title = deriveTitle(state.current.messages);
	appendUser(text);
	void persistCurrent();

	const turnId = crypto.randomUUID();
	state.turnId = turnId;
	setBusy(true);
	transport.send({ type: "chat_send", turnId, messages: state.current.messages });
	inputEl.value = "";
	updateTitle();
}

async function persistCurrent(): Promise<void> {
	await upsertSession(state.current);
	if (!state.persisted) {
		state.persisted = true;
		await setCurrent(state.current.id);
	}
	notifySessionChange();
}

function handleAgentEvent(event: AgentEvent): void {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "assistant") startAssistantBubble();
			return;
		case "message_update":
			updateAssistantBubble(event.delta);
			return;
		case "message_end":
			if (event.message.role === "assistant") finalizeAssistantBubble(event.message);
			return;
		case "tool_execution_start":
			startToolCard(event.toolCallId, event.toolName, event.args);
			return;
		case "tool_execution_end":
			finalizeToolCard(event.toolCallId, event.result, event.isError);
			return;
		case "agent_end":
			finalizeAgent(event.messages, event.stopReason, event.errorMessage);
			return;
	}
}

function createAssistantBubble(): AssistantBubbleRef {
	const li = document.createElement("li");
	li.className = "msg assistant";
	logEl.appendChild(li);
	return { li, textByIndex: new Map() };
}

function startAssistantBubble(): void {
	state.currentAssistant = createAssistantBubble();
	scrollToBottom();
}

function updateAssistantBubble(delta: { kind: "text"; contentIndex: number; text: string }): void {
	const bubble = state.currentAssistant;
	if (!bubble) return;
	let span = bubble.textByIndex.get(delta.contentIndex);
	if (!span) {
		span = document.createElement("div");
		span.className = "text md";
		span.dataset.raw = "";
		bubble.li.appendChild(span);
		bubble.textByIndex.set(delta.contentIndex, span);
	}
	const raw = (span.dataset.raw ?? "") + delta.text;
	span.dataset.raw = raw;
	span.innerHTML = renderMarkdown(raw);
	scrollToBottom();
}

function finalizeAssistantBubble(message: AssistantMessage): void {
	const bubble = state.currentAssistant;
	if (!bubble) return;
	state.current.messages.push(message);
	const hasText = message.content.some((c) => c.type === "text" && c.text.length > 0);
	const hasToolCalls = message.content.some((c) => c.type === "toolCall");
	if (!hasText && hasToolCalls) bubble.li.remove();
	state.currentAssistant = undefined;
}

function createToolCard(_toolCallId: string, toolName: string, args: Record<string, unknown>): ToolCardRef {
	const li = document.createElement("li");
	li.className = "tool-card";
	li.dataset.status = "running";
	li.dataset.expanded = "false";

	const head = document.createElement("div");
	head.className = "tool-head";
	const chevron = document.createElement("span");
	chevron.className = "tool-chevron";
	chevron.textContent = "▸";
	chevron.setAttribute("aria-hidden", "true");
	const name = document.createElement("code");
	name.textContent = toolName;
	const statusEl = document.createElement("span");
	statusEl.className = "tool-status";
	statusEl.textContent = "running…";
	head.append(chevron, name, statusEl);
	head.setAttribute("role", "button");
	head.setAttribute("tabindex", "0");
	head.setAttribute("aria-expanded", "false");
	head.title = "Click to expand";

	const argsEl = document.createElement("pre");
	argsEl.className = "tool-args";
	argsEl.textContent = formatJSON(args);

	const bodyEl = document.createElement("div");
	bodyEl.className = "tool-body";

	const toggle = () => {
		const open = li.dataset.expanded !== "true";
		li.dataset.expanded = String(open);
		head.setAttribute("aria-expanded", String(open));
	};
	head.addEventListener("click", toggle);
	head.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggle();
		}
	});

	li.append(head, argsEl, bodyEl);
	logEl.appendChild(li);
	return { li, bodyEl, statusEl };
}

function startToolCard(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
	const card = createToolCard(toolCallId, toolName, args);
	state.toolCards.set(toolCallId, card);
	scrollToBottom();
}

function updateToolCardResult(card: ToolCardRef, resultText: string, isError: boolean): void {
	card.li.dataset.status = isError ? "error" : "ok";
	card.statusEl.textContent = isError ? "error" : "ok";
	card.bodyEl.textContent = resultText;
}

function finalizeToolCard(toolCallId: string, result: AgentToolResult, isError: boolean): void {
	const card = state.toolCards.get(toolCallId);
	if (!card) return;
	updateToolCardResult(card, result.content.map((c) => c.text).join("\n"), isError);
}

function renderHistory(messages: Message[]): void {
	logEl.innerHTML = "";
	const pendingCards = new Map<string, ToolCardRef>();
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : msg.content.map((c) => c.text).join("");
			appendUser(text);
		} else if (msg.role === "assistant") {
			let bubble: AssistantBubbleRef | undefined;
			for (let i = 0; i < msg.content.length; i++) {
				const block = msg.content[i];
				if (block.type === "text") {
					if (block.text.length === 0) continue;
					if (!bubble) bubble = createAssistantBubble();
					let span = bubble.textByIndex.get(i);
					if (!span) {
						span = document.createElement("div");
						span.className = "text md";
						bubble.li.appendChild(span);
						bubble.textByIndex.set(i, span);
					}
					span.dataset.raw = block.text;
					span.innerHTML = renderMarkdown(block.text);
				} else if (block.type === "toolCall") {
					const card = createToolCard(block.id, block.name, block.arguments);
					pendingCards.set(block.id, card);
				}
			}
		} else if (msg.role === "toolResult") {
			const card = pendingCards.get(msg.toolCallId);
			if (!card) continue;
			updateToolCardResult(card, msg.content.map((c) => c.text).join("\n"), msg.isError === true);
			pendingCards.delete(msg.toolCallId);
		}
	}
	scrollToBottom();
}

function finalizeAgent(messages: Message[], stopReason: string, errorMessage?: string): void {
	state.current.messages = messages;
	state.current.updatedAt = Date.now();
	state.current.title = deriveTitle(messages);
	void persistCurrent();
	state.toolCards.clear();
	state.currentAssistant = undefined;
	state.turnId = undefined;
	setBusy(false);
	updateTitle();
	if (stopReason === "error" && errorMessage) appendError(errorMessage);
	else if (stopReason === "max_turns") appendError("Reached max turns. Send another message to continue.");
	else if (stopReason === "aborted") appendError("Stopped.");
	inputEl.focus();
}

function appendUser(text: string): void {
	const li = document.createElement("li");
	li.className = "msg user";
	li.textContent = text;
	logEl.appendChild(li);
	scrollToBottom();
}

function appendError(text: string): void {
	const li = document.createElement("li");
	li.className = "msg err";
	li.textContent = text;
	logEl.appendChild(li);
	scrollToBottom();
}

function setBusy(busy: boolean): void {
	if (busy) {
		sendBtn.textContent = "stop";
		sendBtn.classList.add("danger");
		sendBtn.disabled = false;
		inputEl.disabled = true;
		newSessionBtn.disabled = true;
	} else {
		sendBtn.textContent = "send";
		sendBtn.classList.remove("danger");
		sendBtn.disabled = false;
		inputEl.disabled = false;
		newSessionBtn.disabled = false;
	}
}

function scrollToBottom(): void {
	logEl.scrollTop = logEl.scrollHeight;
}

function formatJSON(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function updateTitle(): void {
	const count = state.current.messages.length;
	const tokens = totalTokens(state.current.messages);
	const parts = [`${count} message${count === 1 ? "" : "s"}`];
	if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
	titleEl.textContent = parts.join("  ·  ");
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
