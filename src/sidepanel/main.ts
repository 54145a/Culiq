import { loadSettings, saveTheme, type ThemePreference } from "@shared/config";
import { BgConnection, type ConnectionState } from "./bg-connection";
import {
	currentSessionId,
	isBusy,
	loadSessionIntoChat,
	mountChat,
	onSessionChange,
	startFreshSession,
} from "./chat-view";
import { mountSessions } from "./sessions-view";
import { mountSettings } from "./settings-view";

type ViewName = "chat" | "sessions" | "settings";

const statusEl = document.getElementById("status") as HTMLSpanElement;
const themeToggle = document.getElementById("theme-toggle") as HTMLButtonElement;
const settingsRoot = document.getElementById("view-settings") as HTMLElement;
const sessionsRoot = document.getElementById("view-sessions") as HTMLElement;
const views: Record<ViewName, HTMLElement> = {
	chat: document.getElementById("view-chat") as HTMLElement,
	sessions: sessionsRoot,
	settings: settingsRoot,
};

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("nav[role='tablist'] button"));

let settingsMounted = false;
let themePreference: ThemePreference = "system";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedTheme(): "light" | "dark" {
	if (themePreference !== "system") return themePreference;
	return systemTheme.matches ? "dark" : "light";
}

function applyTheme(): void {
	const theme = resolvedTheme();
	document.documentElement.dataset.theme = theme;
	const next = theme === "dark" ? "light" : "dark";
	themeToggle.textContent = theme === "dark" ? "☀" : "☾";
	themeToggle.title = `Switch to ${next} theme`;
	themeToggle.setAttribute("aria-label", `Switch to ${next} theme`);
}

async function initializeTheme(): Promise<void> {
	const settings = await loadSettings();
	themePreference = settings.theme;
	applyTheme();
}

systemTheme.addEventListener("change", () => {
	if (themePreference === "system") applyTheme();
});

themeToggle.addEventListener("click", () => {
	themePreference = resolvedTheme() === "dark" ? "light" : "dark";
	applyTheme();
	void saveTheme(themePreference);
});

function switchView(name: ViewName): void {
	for (const tab of tabs) {
		tab.setAttribute("aria-selected", String(tab.dataset.view === name));
	}
	for (const [key, el] of Object.entries(views) as [ViewName, HTMLElement][]) {
		el.dataset.active = String(key === name);
	}
	if (name === "settings" && !settingsMounted) {
		settingsMounted = true;
		void mountSettings(settingsRoot);
	}
	if (name === "sessions") sessionsView.refresh();
}

for (const tab of tabs) {
	tab.addEventListener("click", () => switchView(tab.dataset.view as ViewName));
}

void initializeTheme();

const connection = new BgConnection();
connection.onState((state: ConnectionState, rtt) => {
	switch (state) {
		case "connecting":
			statusEl.textContent = "connecting…";
			statusEl.dataset.state = "pending";
			return;
		case "connected":
			statusEl.textContent = rtt !== undefined ? `connected · ${rtt}ms` : "connected";
			statusEl.dataset.state = "ok";
			return;
		case "reconnecting":
			statusEl.textContent = "reconnecting…";
			statusEl.dataset.state = "pending";
			return;
	}
});

mountChat({
	send: (msg) => connection.send(msg),
	onMessage: (handler) => connection.onMessage(handler),
});

const sessionsView = mountSessions(sessionsRoot, {
	currentId: () => currentSessionId(),
	canSwitch: () => !isBusy(),
	onSwitch: async (id) => {
		await loadSessionIntoChat(id);
		switchView("chat");
	},
	onNew: async () => {
		await startFreshSession();
	},
});

onSessionChange(() => sessionsView.refresh());

connection.start();
