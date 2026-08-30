import { setupProviderRegistry } from "@shared/ai/sdk";
import { runAgentLoop } from "@shared/agent";
import { getSystemPrompt } from "@shared/agent/system-prompt";
import { listEnabledSkills } from "@shared/skills";
import { closeSandbox, setSandboxContext } from "@shared/agent/tools/sandbox";
import { ensureCustomToolsLoaded, refreshCustomTools } from "@shared/custom-tools";
import { runSubagent } from "@shared/agent/subagent";
import { CAPABILITY_INFO, loadSettings, type Capability } from "@shared/config";
import { closeMcp, createMcpTools } from "@shared/mcp";
import { getPanelWindowTab, isProtectedUrl, setPanelWindow } from "@shared/transport/tab-rpc";
import { type ChatContextMode } from "@shared/transport/protocol";
import { type BgToPanel, PANEL_PORT, type PanelToBg } from "@shared/transport/protocol";
import { getTools } from "./tool-registry";

chrome.runtime.onInstalled.addListener(() => {
	if (chrome.sidePanel?.setPanelBehavior) {
		chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
	}
});

// Preload built-in + user custom tools so the first chat doesn't wait on OPFS.
void ensureCustomToolsLoaded();

// The settings UI asks the SW to re-scan OPFS after a tool is installed/removed.
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
	if (msg?.type === "reload_custom_tools") void refreshCustomTools();
});

// Firefox: clicking the toolbar action toggles the sidebar.
// On Chrome this never fires because setPanelBehavior intercepts the click.
const sidebarAction = (chrome as unknown as { sidebarAction?: { toggle?: () => Promise<void> } }).sidebarAction;
if (sidebarAction?.toggle) {
	chrome.action.onClicked.addListener(() => {
		sidebarAction.toggle?.()?.catch(() => {});
	});
}

self.addEventListener("error", (e: ErrorEvent) => {
	console.error("[culiq sw] uncaught error:", e.message, e.error);
});
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
	console.error("[culiq sw] unhandled rejection:", e.reason);
});

const activeTurns = new Map<string, { controller: AbortController; port: chrome.runtime.Port }>();

let popupWindowId: number | undefined;
chrome.windows.onRemoved.addListener((id) => {
	if (id === popupWindowId) popupWindowId = undefined;
});

async function openPopupWindow(send: (m: BgToPanel) => void): Promise<void> {
	if (popupWindowId !== undefined) {
		try {
			await chrome.windows.update(popupWindowId, { focused: true });
			return;
		} catch {
			popupWindowId = undefined;
		}
	}
	const url = chrome.runtime.getURL("src/sidepanel/index.html?window=1");
	const win = await chrome.windows.create({ url, type: "popup", width: 440, height: 720 });
	if (!win?.id) return;
	popupWindowId = win.id;
	send({ type: "panel_transfer" });
	void closeSidebar();
}

/** Firefox can close its sidebar programmatically; Chrome's sidePanel API cannot. */
function closeSidebar(): void {
	const sidebar = (chrome as unknown as { sidebarAction?: { close?: () => Promise<void> } }).sidebarAction;
	sidebar?.close?.().catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== PANEL_PORT) return;

	const send = (msg: BgToPanel) => {
		try {
			port.postMessage(msg);
		} catch (err) {
			console.warn("[culiq sw] postMessage failed:", err);
		}
	};

	port.onMessage.addListener((msg: PanelToBg) => {
		switch (msg.type) {
			case "ping":
				send({ type: "pong", nonce: msg.nonce });
				return;
			case "chat_send":
				void handleChat(msg, send, port);
				return;
			case "chat_abort": {
				activeTurns.get(msg.turnId)?.controller.abort();
				return;
			}
			case "open_window":
				void openPopupWindow(send);
				return;
		}
	});

	port.onDisconnect.addListener(() => {
		// Only abort turns started by this panel; a placeholder panel disconnecting
		// must not kill the active panel's turn.
		for (const [turnId, turn] of activeTurns) {
			if (turn.port === port) {
				turn.controller.abort();
				activeTurns.delete(turnId);
			}
		}
	});

	send({ type: "log", level: "info", text: "background connected" });
});

async function handleChat(msg: Extract<PanelToBg, { type: "chat_send" }>, send: (m: BgToPanel) => void, port: chrome.runtime.Port): Promise<void> {
	const turnId = msg.turnId;
	const sendErrorEnd = (errorMessage: string) =>
		send({
			type: "agent_event",
			turnId,
			event: { type: "agent_end", messages: msg.messages, stopReason: "error", errorMessage },
		});

	try {
		const settings = await loadSettings();
		setupProviderRegistry(settings.providers);
		const provider = settings.providers.find((p) => p.id === settings.defaultProviderId);

		if (!provider?.apiKey) {
			sendErrorEnd(`${provider?.id ?? "default"}: API key not configured. Open Settings.`);
			return;
		}

		const controller = new AbortController();
		activeTurns.set(turnId, { controller, port });

		// Per-model capability overrides. All capabilities are enabled by default
		// (including every sandbox-exposed tool); only the model's own disabled list
		// (currently only `screenshot` is user-toggleable) is subtracted.
		const modelKey = `${provider.id}:${provider.defaultModel}`;
		const disabled = settings.modelCapabilities[modelKey]?.disabledCapabilities ?? [];
		const enabled = new Set<Capability>(Object.keys(CAPABILITY_INFO) as Capability[]);
		for (const d of disabled) enabled.delete(d);

		try {
			setPanelWindow(msg.windowId);
			await ensureCustomToolsLoaded();
			const skills = enabled.has("use_skill") ? await listEnabledSkills() : [];
			const context = await buildSendTimeContext(msg.contextMode);
			const mcpTools = await createMcpTools(controller.signal);
			const allTools = [
				...getTools().filter((tool) => enabled.has(tool.name as Capability) || tool.custom),
				...mcpTools,
			];
			const systemPrompt = getSystemPrompt({
				skills,
				sandboxEnabled: enabled.has("sandbox_exec"),
				context,
				tools: allTools,
			});

			// Append current time so the agent knows the session timestamp.
			const messages = [...msg.messages];
			const last = messages[messages.length - 1];
			if (last && last.role === "user") {
				const ts = `\n\n[current time: ${new Date().toLocaleString()}]`;
				if (typeof last.content === "string") {
					messages[messages.length - 1] = { ...last, content: last.content + ts };
				} else {
					messages[messages.length - 1] = { ...last, content: [...last.content, { type: "text", text: ts }] };
				}
			}

			const sandboxToolsForSubagent = allTools.filter(
				(tool) => !tool.custom && tool.name !== "subtask" && tool.name !== "sandbox_exec",
			);
			setSandboxContext(controller.signal, {
				enabled,
				subagent: (task) => runSubagent(task, sandboxToolsForSubagent, systemPrompt, controller.signal),
				eventSink: (event) => send({ type: "agent_event", turnId, event }),
			});
			await runAgentLoop(
				{
					systemPrompt,
					messages,
					tools: allTools,
				},
				{
					model: { id: provider.defaultModel, provider: provider.id },
					contextManagement: settings.contextManagement,
				},
				(event) => send({ type: "agent_event", turnId, event }),
				controller.signal,
				context || undefined,
			);
		} finally {
			closeSandbox(controller.signal);
			await closeMcp(controller.signal);
			activeTurns.delete(turnId);
			setPanelWindow(undefined);
		}
	} catch (err) {
		console.error("[culiq sw] handleChat failed:", err);
		sendErrorEnd(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Meta-context appended to the system prompt at send time:
 * - contextMode "tabs": all open tabs (id/title/url) so the agent can switch between them.
 * - contextMode "current": the focused tab's id/title/url.
 * - always: if the focused page is a browser-internal page (and not our own
 *   extension page), warn the agent that DOM tools cannot touch it and it may be
 *   a fresh/blank tab, so it navigates instead of failing read_dom.
 */
async function buildSendTimeContext(contextMode: ChatContextMode | undefined): Promise<string> {
	const blocks: string[] = [];
	// The "current page" is the tab next to the panel (its own window's active
	// tab), not the focused window — the user may have switched windows.
	const current = (await getPanelWindowTab()) ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
	const currentUrl = current?.url;
	const isOurPage = currentUrl !== undefined && currentUrl.startsWith(`chrome-extension://${chrome.runtime.id}`);
	const internal = currentUrl !== undefined && isProtectedUrl(currentUrl) && !isOurPage;

	if (contextMode === "tabs") {
		const tabs = await chrome.tabs.query({});
		const lines = tabs
			.filter((t) => t.id !== undefined && t.url && !isProtectedUrl(t.url))
			.map((t) => `- [${t.id}]${t.active ? " (active)" : ""} "${t.title ?? ""}" ${t.url}`);
		if (lines.length > 0) {
			blocks.push(`The user shared all open tabs. Open tabs:\n${lines.join("\n")}\n\nUse switch_tab to switch tabs and read_dom to inspect a tab's content.`);
		}
	} else if (contextMode === "current" && currentUrl && !internal && !isOurPage) {
		blocks.push(`The current page is "${current?.title ?? ""}" (tab ${current?.id}, ${currentUrl}).`);
	}

	if (internal) {
		blocks.push(
			`The current page is a browser-internal page: ${currentUrl}. DOM tools (read_dom, query, click, type, screenshot) cannot operate on it — if the user wants a web page, open one with navigate instead.`,
		);
	}

	return blocks.join("\n\n");
}
