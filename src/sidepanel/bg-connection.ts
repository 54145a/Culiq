import { type BgToPanel, PANEL_PORT, type PanelToBg } from "@shared/transport/protocol";

type Listener = (msg: BgToPanel) => void;

const KEEPALIVE_MS = 20_000;
const RECONNECT_DELAY_MS = 250;

export type ConnectionState = "connecting" | "connected" | "reconnecting";

export class BgConnection {
	private port: chrome.runtime.Port | null = null;
	private listeners = new Set<Listener>();
	private stateListeners = new Set<(s: ConnectionState, rttMs?: number) => void>();
	private reconnectTimer: number | null = null;
	private keepaliveTimer: number | null = null;
	private state: ConnectionState = "connecting";
	private pendingPings = new Map<string, number>();

	start(): void {
		this.connect();
	}

	send(msg: PanelToBg): void {
		if (!this.port) {
			this.connect();
		}
		try {
			this.port?.postMessage(msg);
		} catch {
			this.handleDisconnect();
		}
	}

	onMessage(cb: Listener): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	onState(cb: (state: ConnectionState, rttMs?: number) => void): () => void {
		this.stateListeners.add(cb);
		cb(this.state);
		return () => this.stateListeners.delete(cb);
	}

	private setState(state: ConnectionState, rttMs?: number): void {
		this.state = state;
		for (const cb of this.stateListeners) cb(state, rttMs);
	}

	private connect(): void {
		if (this.port) return;
		try {
			this.port = chrome.runtime.connect({ name: PANEL_PORT });
		} catch {
			this.scheduleReconnect();
			return;
		}

		this.port.onMessage.addListener((msg: BgToPanel) => {
			if (msg.type === "pong") {
				const sentAt = this.pendingPings.get(msg.nonce);
				this.pendingPings.delete(msg.nonce);
				const rtt = sentAt ? Date.now() - sentAt : undefined;
				this.setState("connected", rtt);
				return;
			}
			for (const cb of this.listeners) cb(msg);
		});

		this.port.onDisconnect.addListener(() => this.handleDisconnect());

		this.ping();
		this.startKeepalive();
	}

	private handleDisconnect(): void {
		this.port = null;
		this.pendingPings.clear();
		this.stopKeepalive();
		this.setState("reconnecting");
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer != null) return;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, RECONNECT_DELAY_MS);
	}

	private ping(): void {
		const nonce = crypto.randomUUID();
		this.pendingPings.set(nonce, Date.now());
		try {
			this.port?.postMessage({ type: "ping", nonce } satisfies PanelToBg);
		} catch {
			this.handleDisconnect();
		}
	}

	private startKeepalive(): void {
		this.stopKeepalive();
		this.keepaliveTimer = window.setInterval(() => this.ping(), KEEPALIVE_MS);
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer != null) {
			window.clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}
}
