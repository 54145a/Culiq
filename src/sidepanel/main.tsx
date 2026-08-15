import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loadSettings, saveTheme, type ThemePreference } from "@shared/config";
import { type PanelToBg } from "@shared/transport/protocol";
import { BgConnection, type ConnectionState } from "./bg-connection";
import {
	ChatView,
	type ChatTransport,
	currentSessionId,
	isBusy,
	loadSessionIntoChat,
	onSessionChange,
	startFreshSession,
} from "./chat-view";
import { refreshSessions, SessionsView, type SessionsViewOptions } from "./sessions-view";
import { SettingsView } from "./settings-view";

type ViewName = "chat" | "sessions" | "settings";

const isPopupWindow = new URLSearchParams(location.search).get("window") === "1";
if (isPopupWindow) document.body.dataset.mode = "window";

// While a pop-out window is open, the sidebar shows a placeholder instead of the UI.
const POPUP_ACTIVE_KEY = "curio.popup.active";

const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

const connection = new BgConnection();
const transport: ChatTransport = {
	send: (msg) => connection.send(msg),
	onMessage: (handler) => connection.onMessage(handler),
};

function App() {
	const [view, setView] = useState<ViewName>("chat");
	const [visited, setVisited] = useState<{ sessions: boolean; settings: boolean }>({ sessions: false, settings: false });
	const [conn, setConn] = useState<{ state: ConnectionState; rtt?: number }>({ state: "connecting" });
	const [pref, setPref] = useState<ThemePreference>("system");
	const [, setSystemTick] = useState(0);

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

	useEffect(() => {
		connection.start();
	}, []);

	useEffect(() => {
		if (isPopupWindow) return;
		const sync = (active: boolean) => {
			document.body.dataset.popupActive = active ? "true" : "false";
		};
		const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
			if (area === "session" && changes[POPUP_ACTIVE_KEY]) sync(changes[POPUP_ACTIVE_KEY].newValue === true);
		};
		chrome.storage.onChanged.addListener(onChange);
		void chrome.storage.session.get(POPUP_ACTIVE_KEY).then((v) => sync(v[POPUP_ACTIVE_KEY] === true));
		return () => chrome.storage.onChanged.removeListener(onChange);
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
					<h1>Curio</h1>
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
								onClick={() => connection.send({ type: "open_window" } satisfies PanelToBg)}
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
				<ChatView transport={transport} />
			</section>
			<section id="view-sessions" className="view" data-active={view === "sessions" ? "true" : "false"}>
				{(visited.sessions || view === "sessions") && <SessionsView options={sessionsOptions} />}
			</section>
			<section id="view-settings" className="view" data-active={view === "settings" ? "true" : "false"}>
				{(visited.settings || view === "settings") && <SettingsView />}
			</section>
			<section id="view-popup-hint" className="view" data-active="false">
				<div className="popup-hint">
					<p>Curio is open in a separate window.</p>
					<p className="hint">You can close this side panel.</p>
				</div>
			</section>
		</>
	);
}

render(<App />, document.getElementById("app")!);
