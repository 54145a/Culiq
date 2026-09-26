import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { loadSettings, saveTheme, type ThemePreference } from "@shared/config";
import { type BgToPanel, type PanelToBg } from "@shared/transport/protocol";
import { BgConnection, type ConnectionState } from "./bg-connection";
import {
	ChatView,
	type ChatTransport,
	currentSessionId,
	isBusy,
	loadSessionIntoChat,
	onSessionChange,
	setActiveIdNotifier,
	startFreshSession,
} from "./chat-view";
import { ExtensionChatTransport } from "./extension-chat-transport";
import { refreshSessions, SessionsView, type SessionsViewOptions } from "./sessions-view";
import { SettingsView } from "./settings-view";
import { setPanelWindowId } from "./window";

type ViewName = "chat" | "sessions" | "settings";

// The tab next to this panel lives in the panel's own window — capture it so
// the background can target the right tab even when another window is focused.
void chrome.windows.getCurrent().then((win) => setPanelWindowId(win?.id));

const isPopupWindow = new URLSearchParams(location.search).get("window") === "1";
if (isPopupWindow) document.body.dataset.mode = "window";

// Single-panel guard: only one panel (side panel or pop-out window) runs the UI
// at a time. Each panel writes {id, ts} to session storage and heartbeats it; a
// panel seeing a fresh foreign id shows a placeholder instead of the UI. This
// also makes the sandbox iframe broadcast-safe (exactly one listener exists).
const PANEL_KEY = "culiq.panel.active";
const PANEL_TTL_MS = 10_000;
const HEARTBEAT_MS = 3_000;

interface PanelFlag {
	id: string;
	ts: number;
}

function isPanelFlag(value: unknown): value is PanelFlag {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PanelFlag).id === "string" &&
		typeof (value as PanelFlag).ts === "number"
	);
}

const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

const connection = new BgConnection();
const transport: ChatTransport = {
	send: (msg) => connection.send(msg),
	onMessage: (handler) => connection.onMessage(handler),
};
// Singleton transport for the chat. Created once (not per ChatView mount) so that
// switching sessions (which remounts ChatView via `key`) does not accumulate
// BgConnection listeners — the constructor registers a listener on each build.
const chatTransport = new ExtensionChatTransport(
	(msg: PanelToBg) => connection.send(msg),
	(cb: (msg: BgToPanel) => void) => connection.onMessage(cb),
);

function App() {
	const [view, setView] = useState<ViewName>("chat");
	const [visited, setVisited] = useState<{ sessions: boolean; settings: boolean }>({ sessions: false, settings: false });
	// Drives ChatView's `key`: changing it remounts ChatView, which (re)creates the
	// useChat instance with the selected session's history as its initial messages.
	const [activeSessionKey, setActiveSessionKey] = useState<string>("none");
	setActiveIdNotifier(setActiveSessionKey);
	const [conn, setConn] = useState<{ state: ConnectionState; rtt?: number }>({ state: "connecting" });
	const [pref, setPref] = useState<ThemePreference>("system");
	const [, setSystemTick] = useState(0);

	const [blocked, setBlockedState] = useState(false);
	const blockedRef = useRef(false);
	const panelIdRef = useRef(crypto.randomUUID());
	const yieldPanelRef = useRef<() => void>(() => {});
	const heartbeatRef = useRef<number | undefined>(undefined);

	const setBlocked = (b: boolean) => {
		blockedRef.current = b;
		setBlockedState(b);
		document.body.dataset.popupActive = b ? "true" : "false";
	};

	useEffect(() => {
		const myId = panelIdRef.current;

		const clearOwnFlag = async () => {
			const raw = await chrome.storage.session.get(PANEL_KEY);
			const flag = raw[PANEL_KEY];
			if (isPanelFlag(flag) && flag.id === myId) await chrome.storage.session.remove(PANEL_KEY);
		};

		const stopHeartbeat = () => {
			if (heartbeatRef.current !== undefined) {
				window.clearInterval(heartbeatRef.current);
				heartbeatRef.current = undefined;
			}
		};

		const startHeartbeat = () => {
			if (heartbeatRef.current === undefined) {
				heartbeatRef.current = window.setInterval(() => {
					void chrome.storage.session.set({ [PANEL_KEY]: { id: myId, ts: Date.now() } });
				}, HEARTBEAT_MS);
			}
		};

		const takeOver = async () => {
			await chrome.storage.session.set({ [PANEL_KEY]: { id: myId, ts: Date.now() } });
			setBlocked(false);
			startHeartbeat();
		};

		// Yield to the pop-out window: stop heartbeating, clear our flag, show placeholder.
		const yieldPanel = () => {
			stopHeartbeat();
			void clearOwnFlag();
			setBlocked(true);
		};
		yieldPanelRef.current = yieldPanel;

		const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
			if (area !== "session" || !changes[PANEL_KEY]) return;
			const flag = changes[PANEL_KEY].newValue;
			if (isPanelFlag(flag) && flag.id !== myId && flag.ts > Date.now() - PANEL_TTL_MS) {
				stopHeartbeat();
				setBlocked(true);
			} else if (blockedRef.current) {
				void takeOver();
			}
		};
		chrome.storage.onChanged.addListener(onChange);

		void (async () => {
			const raw = await chrome.storage.session.get(PANEL_KEY);
			const flag = raw[PANEL_KEY];
			if (isPanelFlag(flag) && flag.id !== myId && flag.ts > Date.now() - PANEL_TTL_MS) {
				setBlocked(true);
			} else {
				await takeOver();
			}
		})();

		const onUnload = () => {
			stopHeartbeat();
			void clearOwnFlag();
		};
		window.addEventListener("beforeunload", onUnload);

		return () => {
			chrome.storage.onChanged.removeListener(onChange);
			window.removeEventListener("beforeunload", onUnload);
			stopHeartbeat();
		};
	}, []);

	// When blocked (another panel active), poll session storage to detect
	// when that panel closes or crashes so we can take over immediately.
	useEffect(() => {
		if (!blocked) return;
		const poll = window.setInterval(async () => {
			const raw = await chrome.storage.session.get(PANEL_KEY);
			const flag = raw[PANEL_KEY];
			if (!isPanelFlag(flag) || flag.ts <= Date.now() - PANEL_TTL_MS) {
				// Other panel gone or stale — take over.
				await chrome.storage.session.set({ [PANEL_KEY]: { id: panelIdRef.current, ts: Date.now() } });
				setBlocked(false);
				if (heartbeatRef.current === undefined) {
					heartbeatRef.current = window.setInterval(() => {
						void chrome.storage.session.set({ [PANEL_KEY]: { id: panelIdRef.current, ts: Date.now() } });
					}, HEARTBEAT_MS);
				}
			}
		}, HEARTBEAT_MS);
		return () => window.clearInterval(poll);
	}, [blocked]);

	// Hidden iframe hosts the sandbox; only the active panel creates one. The
	// page is declared in manifest `sandbox.pages`, so Chrome serves it from a
	// unique origin with the sandbox CSP (eval allowed, no chrome.* access).
	useEffect(() => {
		if (blocked) return;
		const iframe = document.createElement("iframe");
		iframe.className = "sandbox-frame";
		iframe.src = chrome.runtime.getURL("sandbox-frame.html");

		// The iframe is opaque-origin (no chrome.* access), so relay its sandbox
		// traffic to/from the background service worker over runtime messaging.
		const onRuntimeMessage = (msg: { type?: string; sessionId?: string; data?: unknown }) => {
			if (msg?.type === "sandbox_send") {
				iframe.contentWindow?.postMessage({ __culiq: "sandbox", sessionId: msg.sessionId, data: msg.data }, "*");
			} else if (msg?.type === "sandbox_close") {
				iframe.contentWindow?.postMessage({ __culiq: "sandbox", sessionId: msg.sessionId, data: { kind: "close" } }, "*");
			}
			return false;
		};
		chrome.runtime.onMessage.addListener(onRuntimeMessage);
		const onWindowMessage = (e: MessageEvent) => {
			if (e.source !== iframe.contentWindow || !e.data || e.data.__culiq !== "sandbox") return;
			void chrome.runtime.sendMessage({ type: "sandbox_msg", sessionId: e.data.sessionId, data: e.data.data });
		};
		window.addEventListener("message", onWindowMessage);

		document.body.appendChild(iframe);
		return () => {
			chrome.runtime.onMessage.removeListener(onRuntimeMessage);
			window.removeEventListener("message", onWindowMessage);
			iframe.remove();
		};
	}, [blocked]);

	useEffect(() => {
		return connection.onState((state, rtt) => setConn({ state, rtt }));
	}, []);

	useEffect(() => {
		void loadSettings().then((s) => setPref(s.theme));
		const onChange = () => setSystemTick((t) => t + 1);
		systemTheme.addEventListener("change", onChange);
		return () => systemTheme.removeEventListener("change", onChange);
	}, []);

	useEffect(() => {
		return onSessionChange(() => refreshSessions());
	}, []);

	// Handle panel_transfer from SW: the pop-out window is taking over, so yield.
	useEffect(() => {
		return connection.onMessage((msg) => {
			if (msg.type === "panel_transfer") yieldPanelRef.current();
		});
	}, []);

	useEffect(() => {
		connection.start();
	}, []);

	const theme = pref === "system" ? (systemTheme.matches ? "dark" : "light") : pref;
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	const switchView = (name: ViewName) => {
		setView(name);
		if (name === "sessions") setVisited((v) => ({ ...v, sessions: true }));
		if (name === "settings") setVisited((v) => ({ ...v, settings: true }));
	};

	const toggleTheme = () => {
		const next: ThemePreference = theme === "dark" ? "light" : "dark";
		setPref(next);
		void saveTheme(next);
	};

	const onPopout = () => {
		// Yield first so the new window becomes the single active panel.
		yieldPanelRef.current();
		connection.send({ type: "open_window" } satisfies PanelToBg);
	};

	const statusText =
		conn.state === "connected"
			? conn.rtt !== undefined
				? `connected · ${conn.rtt}ms`
				: "connected"
			: conn.state === "reconnecting"
				? "reconnecting…"
				: "connecting…";
	const statusState = conn.state === "connected" ? "ok" : "pending";
	const nextTheme = theme === "dark" ? "light" : "dark";

	const sessionsOptions: SessionsViewOptions = {
		currentId: () => currentSessionId(),
		canSwitch: () => !isBusy(),
		onSwitch: async (id) => {
			await loadSessionIntoChat(id);
			setView("chat");
		},
		onNew: async () => {
			await startFreshSession();
		},
	};

	return (
		<>
			<header>
				<div className="brand">
					<h1>Culiq</h1>
					<div className="header-actions">
						<span id="status" data-state={statusState}>
							{statusText}
						</span>
						{!isPopupWindow && (
							<button
								id="popout-toggle"
								type="button"
								aria-label="Open in window"
								title="Open in separate window"
								onClick={onPopout}
							>
								⛶
							</button>
						)}
						<button
							id="theme-toggle"
							type="button"
							aria-label={`Switch to ${nextTheme} theme`}
							title={`Switch to ${nextTheme} theme`}
							onClick={toggleTheme}
						>
							{theme === "dark" ? "☀" : "☾"}
						</button>
					</div>
				</div>
				<nav role="tablist">
					{(["chat", "sessions", "settings"] as ViewName[]).map((name) => (
						<button
							key={name}
							type="button"
							role="tab"
							data-view={name}
							aria-selected={view === name}
							onClick={() => switchView(name)}
						>
							{name === "chat" ? "Chat" : name === "sessions" ? "Sessions" : "Settings"}
						</button>
					))}
				</nav>
			</header>
			<section id="view-chat" className="view" data-active={view === "chat" ? "true" : "false"}>
				<ChatView key={activeSessionKey} transport={transport} chatTransport={chatTransport} />
			</section>
			<section id="view-sessions" className="view" data-active={view === "sessions" ? "true" : "false"}>
				{(visited.sessions || view === "sessions") && <SessionsView options={sessionsOptions} />}
			</section>
			<section id="view-settings" className="view" data-active={view === "settings" ? "true" : "false"}>
				{(visited.settings || view === "settings") && <SettingsView />}
			</section>
			<section id="view-popup-hint" className="view" data-active="false">
				<div className="popup-hint">
					<p>Culiq is already running in another panel.</p>
					<p className="hint">Close that panel to continue here.</p>
				</div>
			</section>
		</>
	);
}

render(<App />, document.getElementById("app")!);
