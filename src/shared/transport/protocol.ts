import type { AgentEvent } from "../agent/types";
import type { Message } from "../ai/types";

export type PanelToBg =
	| { type: "ping"; nonce: string }
	| { type: "chat_send"; turnId: string; messages: Message[] }
	| { type: "chat_abort"; turnId: string }
	| { type: "open_window" };

export type BgToPanel =
	| { type: "pong"; nonce: string }
	| { type: "log"; level: "info" | "warn" | "error"; text: string }
	| { type: "agent_event"; turnId: string; event: AgentEvent };

export const PANEL_PORT = "curio.panel";
