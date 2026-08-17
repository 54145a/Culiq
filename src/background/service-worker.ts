import { runAgentLoop } from "@shared/agent";
import { getSystemPrompt } from "@shared/agent/system-prompt";
import { buildAvailableSkillsBlock, listEnabledSkills } from "@shared/skills";
import { closeSandbox, generateSandboxDts } from "@shared/agent/tools/sandbox";
import { getActiveProvider, loadSettings, type Capability } from "@shared/config";
import { closeMcp, createMcpTools } from "@shared/mcp";
import { isProtectedUrl } from "@shared/transport/tab-rpc";
import { type ChatContextMode } from "@shared/transport/protocol";
import { type BgToPanel, PANEL_PORT, type PanelToBg } from "@shared/transport/protocol";
import { getTools } from "./tool-registry";

chrome.runtime.onInstalled.addListener(() => {
	if (chrome.sidePanel?.setPanelBehavior) {
		chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
	}
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
	console.error("[curio sw] uncaught error:", e.message, e.error);
});
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
	console.error("[curio sw] unhandled rejection:", e.reason);
});

const activeTurns = new Map<string, { controller: AbortController; port: chrome.runtime.Port }>();

let popupWindowId: number | undefined;
chrome.windows.onRemoved.addListener((id) => {
	if (id === popupWindowId) popupWindowId = undefined;
});

async function openPopupWindow(): Promise<void> {
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
	popupWindowId = win.id;
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
			console.warn("[curio sw] postMessage failed:", err);
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
				void openPopupWindow();
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
		const provider = getActiveProvider(settings);

		if (!provider.apiKey) {
			sendErrorEnd(`${provider.id}: API key not configured. Open Settings.`);
			return;
		}

		const controller = new AbortController();
		activeTurns.set(turnId, { controller, port });

		const enabled = new Set<Capability>(settings.capabilities);

		try {
			const skills = enabled.has("use_skill") ? await listEnabledSkills() : [];
			const sandboxDts = enabled.has("sandbox_exec") ? `\n\n${generateSandboxDts()}` : "";
			const context = await buildSendTimeContext(msg.contextMode);
			const systemPrompt =
				getSystemPrompt(settings.capabilities) + buildAvailableSkillsBlock(skills) + sandboxDts + (context ? `\n\n${context}` : "");
			const mcpTools = await createMcpTools(controller.signal);

			await runAgentLoop(
				{
					systemPrompt,
					messages: msg.messages,
					tools: [...getTools().filter((tool) => enabled.has(tool.name as Capability)), ...mcpTools],
				},
				{
					model: { id: provider.model, provider: provider.id },
					apiKey: provider.apiKey,
					baseUrl: provider.baseUrl,
					contextManagement: settings.contextManagement,
				},
				(event) => send({ type: "agent_event", turnId, event }),
				controller.signal,
			);
		} finally {
			closeSandbox(controller.signal);
			await closeMcp(controller.signal);
			activeTurns.delete(turnId);
		}
	} catch (err) {
		console.error("[curio sw] handleChat failed:", err);
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
	const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	const focusedUrl = focused?.url;
	const isOurPage = focusedUrl !== undefined && focusedUrl.startsWith(`chrome-extension://${chrome.runtime.id}`);
	const internal = focusedUrl !== undefined && isProtectedUrl(focusedUrl) && !isOurPage;

	if (contextMode === "tabs") {
		const tabs = await chrome.tabs.query({});
		const lines = tabs
			.filter((t) => t.id !== undefined && t.url && !isProtectedUrl(t.url))
			.map((t) => `- [${t.id}]${t.active ? " (active)" : ""} "${t.title ?? ""}" ${t.url}`);
		if (lines.length > 0) {
			blocks.push(`The user shared all open tabs. Open tabs:\n${lines.join("\n")}\n\nUse switch_tab to switch tabs and read_dom to inspect a tab's content.`);
		}
	} else if (contextMode === "current" && focusedUrl && !internal && !isOurPage) {
		blocks.push(`The current page is "${focused?.title ?? ""}" (tab ${focused?.id}, ${focusedUrl}).`);
	}

	if (internal) {
		blocks.push(
			`The current page is a browser-internal page: ${focusedUrl}. DOM tools (read_dom, query, click, type, screenshot) cannot operate on it — if the user wants a web page, open one with navigate instead.`,
		);
	}

	return blocks.join("\n\n");
}
