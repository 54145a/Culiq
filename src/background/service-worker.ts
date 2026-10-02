import { setupProviderRegistry } from "@shared/ai/sdk";
import { runAgentLoop } from "@shared/agent";
import { getSystemPrompt } from "@shared/agent/system-prompt";
import { getSkill, listEnabledSkills } from "@shared/skills";
import { closeSandbox, setSandboxContext } from "@shared/agent/tools/sandbox";
import { ensureCustomToolsLoaded, refreshCustomTools, syncBuiltinTools } from "@shared/custom-tools";
import { runSubagent } from "@shared/agent/subagent";
import { CAPABILITY_INFO, loadSettings, resolveDefaultModel, type Capability } from "@shared/config";
import { closeMcp, createMcpTools } from "@shared/mcp";
import { callContent, findTargetTab, isProtectedUrl, setPanelWindow, setTargetTab } from "@shared/transport/tab-rpc";
import { captureScreenshotContent } from "@shared/agent/tools/browser/screenshot";
import { type ImageContent, type TextContent } from "@shared/ai/types";
import { type ChatContextMode } from "@shared/transport/protocol";
import { type BgToPanel, PANEL_PORT, type PanelToBg } from "@shared/transport/protocol";
import { getTools } from "./tool-registry";

chrome.runtime.onInstalled.addListener(() => {
	if (chrome.sidePanel?.setPanelBehavior) {
		chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
	}
});

// Preload built-in + user custom tools so the first chat doesn't wait on OPFS.
// Sync built-in tools from static files, then preload all custom tools.
void syncBuiltinTools()
	.then((errors) => {
		if (errors.length > 0) console.warn("[culiq] syncBuiltinTools errors:", errors);
		return ensureCustomToolsLoaded();
	})
	.catch((err) => console.error("[culiq] syncBuiltinTools failed:", err));

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
	// `reason` is often a DOMException, which stringifies as "[object DOMException]",
	// so log the parts that identify it.
	const reason = e.reason as { name?: string; message?: string; stack?: string } | undefined;
	console.error(`[culiq sw] unhandled rejection: ${reason?.name ?? typeof e.reason}: ${reason?.message ?? String(e.reason)}`, e.reason);
	if (reason?.stack) console.error(reason.stack);
});

const activeTurns = new Map<string, { controller: AbortController; port: chrome.runtime.Port }>();

import { setPopupWindowId, clearIfMatches, isStandaloneMode, getPopupWindowId } from "@shared/standalone";
chrome.windows.onRemoved.addListener((id) => {
	clearIfMatches(id);
});

async function openPopupWindow(send: (m: BgToPanel) => void): Promise<void> {
	if (isStandaloneMode()) {
		try {
			await chrome.windows.update(getPopupWindowId()!, { focused: true });
			return;
		} catch {
			setPopupWindowId(undefined);
		}
	}
	const url = chrome.runtime.getURL("src/sidepanel/index.html?window=1");
	const win = await chrome.windows.create({ url, type: "popup", width: 440, height: 720 });
	if (!win?.id) return;
	setPopupWindowId(win.id);
	send({ type: "panel_transfer" });
	closeSidebar();
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
		const resolved = resolveDefaultModel(settings);

		if (!resolved) {
			sendErrorEnd("No default model configured. Open Settings → Models.");
			return;
		}

		if (!resolved.provider.apiKey) {
			sendErrorEnd(`${resolved.provider.name}: API key not configured. Open Settings → Providers.`);
			return;
		}

		const { provider, model } = resolved;
		const controller = new AbortController();
		activeTurns.set(turnId, { controller, port });
		setTargetTab(undefined);

		// Per-model capability overrides. All capabilities are enabled by default
		// (including every sandbox-exposed tool); only the model's own disabled list
		// (currently only `screenshot` is user-toggleable) is subtracted.
		const disabled = settings.modelCapabilities[model.id]?.disabledCapabilities ?? [];
		const enabled = new Set<Capability>(Object.keys(CAPABILITY_INFO) as Capability[]);
		for (const d of disabled) enabled.delete(d);

		try {
			setPanelWindow(msg.windowId);
			await ensureCustomToolsLoaded();
			const skills = enabled.has("use_skill") ? await listEnabledSkills() : [];
			const lastSent = msg.messages[msg.messages.length - 1];
			const wantsPageShare = msg.contextMode === "page+screenshot" && lastSent?.role === "user";
			const pageShare = wantsPageShare ? await buildPageShare(controller.signal, enabled.has("screenshot")) : null;
			const context = await buildSendTimeContext(msg.contextMode, pageShare !== null);
			const mcpTools = await createMcpTools(controller.signal);
			const customOverride = msg.enabledCustomTools;
			const allTools = [
				...getTools().filter(
					(tool) => {
						if (!tool.custom) return enabled.has(tool.name as Capability);
						if (customOverride) return customOverride.includes(tool.name);
						return !settings.disabledTools.includes(tool.name);
					},
				),
				...mcpTools,
			];
			const systemPrompt = getSystemPrompt({
				skills,
				sandboxEnabled: enabled.has("sandbox_exec"),
				tools: allTools,
			});

			// Append current time — and, for the "page + screenshot" context mode,
			// the shared page text and screenshot — to the user's own message. A
			// second user turn would break the providers' user/assistant alternation.
			const messages = [...msg.messages];
			const last = messages[messages.length - 1];
			if (last && last.role === "user") {
				const extra: Array<TextContent | ImageContent> = [
					...(pageShare?.blocks ?? []),
				];

				// Inject selected skills' SKILL.md content into this message.
				if (msg.enabledSkills?.length) {
					for (const name of msg.enabledSkills) {
						const skill = await getSkill(name);
						if (skill) {
							extra.push({ type: "text", text: `[skill: ${skill.name}]\n${skill.content}` });
						}
					}
				}

				extra.push({ type: "text", text: `[current time: ${new Date().toLocaleString()}]` });
				const existing: Array<TextContent | ImageContent> =
					typeof last.content === "string"
						? last.content
							? [{ type: "text", text: last.content }]
							: []
						: last.content;
				messages[messages.length - 1] = { ...last, content: [...existing, ...extra] };
			}

			const sandboxToolsForSubagent = allTools.filter(
				(tool) => !tool.custom && tool.name !== "subtask" && tool.name !== "sandbox_exec",
			);
			setSandboxContext(controller.signal, {
				enabled,
				subagent: (task) => {
					const subtaskId = `subtask-${crypto.randomUUID().slice(0, 8)}`;
					return runSubagent(task, sandboxToolsForSubagent, systemPrompt, controller.signal, 5, subtaskId, (event) => send({ type: "agent_event", turnId, event }));
				},
				eventSink: (event) => send({ type: "agent_event", turnId, event }),
			});
			await runAgentLoop(
				{
					systemPrompt,
					messages,
					tools: allTools,
				},
				{
					model: { id: model.name, provider: provider.id },
					contextManagement: settings.contextManagement,
					contextWindow: model.contextWindow,
					sessionId: msg.sessionId,
					...(msg.reasoning ? { reasoning: msg.reasoning as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } : model.reasoning ? { reasoning: model.reasoning } : {}),
				},
				(event) => send({ type: "agent_event", turnId, event }),
				controller.signal,
				[context, pageShare?.summary].filter(Boolean).join("\n\n") || undefined,
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
 * - contextMode "page+screenshot" (when the share succeeded): the page's text and
 *   screenshot ride along in the user's message.
 * - always: if the focused page is a browser-internal page (and not our own
 *   extension page), warn the agent that DOM tools cannot touch it and it may be
 *   a fresh/blank tab, so it navigates instead of failing read_dom.
 */
async function buildSendTimeContext(contextMode: ChatContextMode | undefined, pageShared: boolean): Promise<string> {
	const blocks: string[] = [];
	// The "current page" is the tab next to the panel (its own window's active
	// tab), not the focused window — the user may have switched windows.
	const current = await findTargetTab();
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
	} else if (contextMode === "page+screenshot" && pageShared && currentUrl) {
		blocks.push(
			`The user shared the current page as context in their latest message: "${current?.title ?? ""}" (tab ${current?.id}, ${currentUrl}). ` +
				`Work from that attached material instead of calling read_dom or screenshot. It is a snapshot from when the message was sent — re-read the page if it may have changed since.`,
		);
	}

	if (internal) {
		blocks.push(
			`The current page is a browser-internal page: ${currentUrl}. DOM tools (read_dom, click, type, screenshot) cannot operate on it. Use \`fetch_url\` with a new URL to open a web page.`,
		);
	}

	return blocks.join("\n\n");
}

const PAGE_SHARE_MAX_CHARS = 4000;

interface PageShare {
	blocks: Array<TextContent | ImageContent>;
	summary: string;
}

/**
 * Context mode "page+screenshot": attach the current page's rendered text and a
 * screenshot to the outgoing user message, so the agent starts from what the
 * user is looking at instead of spending turns on read_dom/screenshot.
 *
 * One-shot by construction: the panel rebuilds the history from its own UI
 * messages on every send, so neither the text nor the image is persisted or
 * re-sent next turn. The two halves are attempted independently — a page the
 * content script cannot reach still yields a screenshot, and vice versa.
 */
async function buildPageShare(signal: AbortSignal, withImage: boolean): Promise<PageShare | null> {
	const tab = await findTargetTab();
	if (!tab?.url || isProtectedUrl(tab.url)) return null;

	const blocks: Array<TextContent | ImageContent> = [];
	const notes: string[] = [];

	try {
		const dom = await callContent({ method: "read_dom", mode: "markdown", maxChars: PAGE_SHARE_MAX_CHARS });
		if (dom.content.trim()) {
			blocks.push({
				type: "text",
				text: `[Current page text — "${dom.title}", captured when this message was sent${dom.truncated ? `, first ${dom.chars} chars` : ""}]\n\n${dom.content}`,
			});
			notes.push(`page text (${dom.chars} chars${dom.truncated ? ", truncated" : ""})`);
		}
	} catch (err) {
		console.warn("[culiq sw] page share: read_dom failed:", err);
	}

	if (withImage) {
		try {
			const shot = await captureScreenshotContent(signal);
			blocks.push({
				type: "text",
				text: `[Attached to this message by the "current page + screenshot" context mode — a snapshot from when the message was sent]\n${shot.prompt}`,
			});
			blocks.push(shot.image);
			notes.push(`screenshot (${shot.mediaType === "image/webp" ? "WebP" : "PNG"}, ${shot.bytes} bytes)`);
		} catch (err) {
			console.warn("[culiq sw] page share: screenshot failed:", err);
		}
	}

	if (blocks.length === 0) return null;
	return {
		blocks,
		summary: `Page shared as context: ${notes.join(" + ")}. Attached to this send only; not saved to the session.`,
	};
}
