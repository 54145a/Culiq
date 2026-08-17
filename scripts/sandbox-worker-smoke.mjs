/**
 * Smoke test: runs public/sandbox-worker.js in a mocked worker context and
 * verifies the init → bridge → eval-result round trip that sandbox_exec relies
 * on. Catches regressions like worker creation from blob URLs in the MV3
 * service worker (URL.createObjectURL does not exist there).
 *
 * Run: node scripts/sandbox-worker-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const script = readFileSync(new URL("../public/sandbox-worker.js", import.meta.url), "utf8");
const paths = [
	"tabs.query",
	"tabs.get",
	"tabs.update",
	"tabs.create",
	"tabs.duplicate",
	"tabs.reload",
	"windows.get",
	"windows.update",
	"evalInTab",
	"evalInAllFrames",
	"docs",
];

const posted = [];
const self = { postMessage: (msg) => posted.push(msg), onmessage: null };
const context = createContext({
	self,
	navigator: { storage: { getDirectory: async () => ({}) } },
	fetch: async () => ({ ok: true, text: async () => "{}" }),
	console,
	setTimeout,
	WeakSet,
	Map,
	Set,
	Promise,
	JSON,
	Error,
	Date,
	RegExp,
	Object,
	Array,
});
runInContext(script, context);

const wait = (ms) => new Promise((r) => setTimeout(r, 10));

self.onmessage({ data: { kind: "init", paths } });
self.onmessage({ data: { kind: "eval", id: 1, code: "return await sandbox.chrome.tabs.query({ active: true })" } });
await wait();
const bridge = posted.find((m) => m.kind === "bridge");
if (!bridge || bridge.path !== "tabs.query") throw new Error("bridge call missing or wrong path");

self.onmessage({ data: { kind: "bridge-result", id: bridge.id, ok: true, value: [{ id: 42 }] } });
await wait();
const result = posted.find((m) => m.kind === "eval-result");
if (!result || !result.ok || !String(result.value).includes("42")) throw new Error("eval-result missing or wrong");
console.log("sandbox worker smoke OK: bridge", bridge.path, "=>", result.value.trim());

// ---------------------------------------------------------------------------
// Phase 2: sandbox-frame host relay — the worker runs in a hidden iframe inside
// the panel (a window context has Worker in both browsers) and relays through
// chrome.runtime. The single-panel guard means one listener, no duplicates.
// ---------------------------------------------------------------------------
const hostSrc = readFileSync(new URL("../public/sandbox-frame.js", import.meta.url), "utf8");

const workers = new Map();
const swReceived = [];
const runtimeListeners = [];
const fakeChrome = {
	runtime: {
		onMessage: {
			addListener: (l) => runtimeListeners.push(l),
		},
		sendMessage: (msg) => swReceived.push(msg),
		getURL: (p) => `chrome-extension://id/${p}`,
	},
};
const fakeWorkerGlobal = {
	Worker: class {
		constructor(url) {
			this.url = url;
			this.handler = null;
			this.terminated = false;
			workers.set("s1", this);
		}
		addEventListener(_evt, cb) {
			this.handler = cb;
		}
		postMessage(d) {
			this.lastPost = d;
		}
		terminate() {
			this.terminated = true;
			workers.delete("s1");
		}
	},
};
const octx = createContext({ ...fakeWorkerGlobal, chrome: fakeChrome, Map, console });
runInContext(hostSrc, octx);
if (runtimeListeners.length !== 1) throw new Error("sandbox-frame host did not register a listener");

const host = runtimeListeners[0];
host({ type: "sandbox_send", sessionId: "s1", data: { kind: "init", paths } });
if (!workers.has("s1")) throw new Error("sandbox-frame host did not create a worker");
const w = workers.get("s1");
if (w.url !== "chrome-extension://id/sandbox-worker.js") throw new Error("sandbox-frame worker URL wrong");
if (w.lastPost?.kind !== "init") throw new Error("init not forwarded to worker");

host({ type: "sandbox_send", sessionId: "s1", data: { kind: "eval", id: 9, code: "x" } });
if (w.lastPost?.id !== 9) throw new Error("eval not forwarded to worker");

w.handler({ data: { kind: "bridge", id: 9, path: "tabs.query", args: [] } });
const relayed = swReceived.find((m) => m.type === "sandbox_msg" && m.sessionId === "s1");
if (!relayed || relayed.data.path !== "tabs.query") throw new Error("worker -> SW relay missing");

host({ type: "sandbox_send", sessionId: "s1", data: { kind: "close" } });
if (w.terminated !== true || workers.has("s1")) throw new Error("worker not terminated on close");
console.log("sandbox-frame relay smoke OK");

