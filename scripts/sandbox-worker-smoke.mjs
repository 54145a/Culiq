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
