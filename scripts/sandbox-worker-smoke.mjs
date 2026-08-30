/**
 * Smoke test: runs public/sandbox-frame.js in a mocked browser context and
 * verifies the init → eval → bridge → bridge-result → eval-result round trip
 * that sandbox_exec relies on. The sandbox runs agent code directly in the
 * sandboxed iframe page (not a Worker), relaying through window.parent.
 *
 * Run: node scripts/sandbox-worker-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const src = readFileSync(new URL("../public/sandbox-frame.js", import.meta.url), "utf8");
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

const parentPosted = [];
const windowListeners = [];
const fakeWindow = {
	addEventListener: (_type, l) => windowListeners.push(l),
	parent: { postMessage: (msg) => parentPosted.push(msg) },
};

const context = createContext({
	window: fakeWindow,
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
runInContext(src, context);

if (windowListeners.length !== 1) throw new Error("sandbox-frame host did not register a message listener");
const host = windowListeners[0];

const wait = (ms) => new Promise((r) => setTimeout(r, 10));

host({ data: { __culiq: "sandbox", sessionId: "s1", data: { kind: "init", paths } } });
host({ data: { __culiq: "sandbox", sessionId: "s1", data: { kind: "eval", id: 1, code: "return await sandbox.chrome.tabs.query({ active: true })" } } });
await wait();

const bridge = parentPosted.find((m) => m.data.kind === "bridge");
if (!bridge || bridge.data.path !== "tabs.query") throw new Error("bridge call missing or wrong path");

host({ data: { __culiq: "sandbox", sessionId: "s1", data: { kind: "bridge-result", id: bridge.data.id, ok: true, value: [{ id: 42 }] } } });
await wait();

const result = parentPosted.find((m) => m.data.kind === "eval-result");
if (!result || !result.data.ok || !String(result.data.value).includes("42")) throw new Error("eval-result missing or wrong");

host({ data: { __culiq: "sandbox", sessionId: "s1", data: { kind: "close" } } });
console.log("sandbox frame smoke OK: bridge", bridge.data.path, "=>", result.data.value.trim());