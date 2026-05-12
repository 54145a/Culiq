import { runAgentLoop } from "@shared/agent";
import { SYSTEM_PROMPT } from "@shared/agent/system-prompt";
import { getActiveProvider, loadSettings } from "@shared/config";
import { type BgToPanel, PANEL_PORT, type PanelToBg } from "@shared/transport/protocol";
import { getTools } from "./tool-registry";

chrome.runtime.onInstalled.addListener(() => {
	chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

self.addEventListener("error", (e: ErrorEvent) => {
	console.error("[curio sw] uncaught error:", e.message, e.error);
});
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
	console.error("[curio sw] unhandled rejection:", e.reason);
});

const activeTurns = new Map<string, AbortController>();

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
				void handleChat(msg, send);
				return;
			case "chat_abort": {
				const ctrl = activeTurns.get(msg.turnId);
				ctrl?.abort();
				return;
			}
		}
	});

	port.onDisconnect.addListener(() => {
		for (const ctrl of activeTurns.values()) ctrl.abort();
		activeTurns.clear();
	});

	send({ type: "log", level: "info", text: "background connected" });
});

async function handleChat(msg: Extract<PanelToBg, { type: "chat_send" }>, send: (m: BgToPanel) => void): Promise<void> {
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
		activeTurns.set(turnId, controller);

		try {
			await runAgentLoop(
				{ systemPrompt: SYSTEM_PROMPT, messages: msg.messages, tools: getTools() },
				{
					model: { id: provider.model, provider: provider.id },
					apiKey: provider.apiKey,
					baseUrl: provider.baseUrl,
				},
				(event) => send({ type: "agent_event", turnId, event }),
				controller.signal,
			);
		} finally {
			activeTurns.delete(turnId);
		}
	} catch (err) {
		console.error("[curio sw] handleChat failed:", err);
		sendErrorEnd(err instanceof Error ? err.message : String(err));
	}
}
