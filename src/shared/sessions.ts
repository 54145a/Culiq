import type { Message } from "./ai/types";

const STORE_KEY = "curio.sessions.v2";
const LEGACY_KEY = "curio.session.current.v1";
const TITLE_MAX = 48;

export interface Session {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: Message[];
}

interface SessionsStore {
	version: 2;
	currentId: string | null;
	sessions: Record<string, Session>;
}

let cache: SessionsStore | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

async function readStore(): Promise<SessionsStore> {
	if (cache) return cache;
	const raw = await chrome.storage.local.get([STORE_KEY, LEGACY_KEY]);
	const stored = raw[STORE_KEY] as SessionsStore | undefined;
	if (stored && stored.version === 2) {
		cache = stored;
		return cache;
	}

	const legacy = raw[LEGACY_KEY] as { messages?: Message[] } | undefined;
	const next: SessionsStore = { version: 2, currentId: null, sessions: {} };
	if (legacy?.messages && legacy.messages.length > 0) {
		const session = newSession(legacy.messages);
		next.sessions[session.id] = session;
		next.currentId = session.id;
	}
	cache = next;
	return cache;
}

async function writeStore(): Promise<void> {
	if (!cache) return;
	const snapshot = cache;
	writeChain = writeChain.then(() => chrome.storage.local.set({ [STORE_KEY]: snapshot }));
	await writeChain;
}

export async function listSessions(): Promise<Session[]> {
	const store = await readStore();
	return Object.values(store.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getCurrentId(): Promise<string | null> {
	const store = await readStore();
	return store.currentId;
}

export async function getSession(id: string): Promise<Session | null> {
	const store = await readStore();
	return store.sessions[id] ?? null;
}

export async function setCurrent(id: string | null): Promise<void> {
	const store = await readStore();
	if (store.currentId === id) return;
	store.currentId = id;
	await writeStore();
}

export async function upsertSession(session: Session): Promise<void> {
	const store = await readStore();
	store.sessions[session.id] = {
		...session,
		messages: session.messages.map((message) =>
			message.role === "toolResult"
				? { ...message, content: message.content.filter((block) => block.type === "text") }
				: message,
		),
	};
	await writeStore();
}

export async function deleteSession(id: string): Promise<void> {
	const store = await readStore();
	if (!store.sessions[id]) return;
	delete store.sessions[id];
	if (store.currentId === id) store.currentId = null;
	await writeStore();
}

export function newSession(messages: Message[] = []): Session {
	const now = Date.now();
	return {
		id: crypto.randomUUID(),
		title: deriveTitle(messages),
		createdAt: now,
		updatedAt: now,
		messages,
	};
}

export function deriveTitle(messages: Message[]): string {
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text = typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join(" ");
		const trimmed = text.replace(/\s+/g, " ").trim();
		if (trimmed.length === 0) continue;
		return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;
	}
	return "New session";
}

export function formatRelativeTime(ts: number): string {
	const delta = Date.now() - ts;
	const sec = Math.floor(delta / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min} min ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr} hr ago`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
	const date = new Date(ts);
	return date.toLocaleDateString();
}
