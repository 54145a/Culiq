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
	"click",
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

// The fetch response proxy must expose status/ok/headers as values while still
// forwarding body methods to the SW.
const evalOnce = async (id, code, respond) => {
	host({ data: { __culiq: "sandbox", sessionId: "s2", data: { kind: "init", paths } } });
	host({ data: { __culiq: "sandbox", sessionId: "s2", data: { kind: "eval", id, code } } });
	for (let i = 0; i < 20; i++) {
		await wait();
		const call = parentPosted.filter((m) => m.data.kind === "bridge" && !responded.has(m.data.id)).at(-1);
		if (!call) continue;
		responded.add(call.data.id);
		const value = await respond(call.data.path, call.data.args);
		host({ data: { __culiq: "sandbox", sessionId: "s2", data: { kind: "bridge-result", id: call.data.id, ok: true, value } } });
	}
	return parentPosted.filter((m) => m.data.kind === "eval-result" && m.data.id === id).at(-1);
};

const responded = new Set();
const fetchResult = await evalOnce(
	7,
	`const res = await sandbox.fetch("https://example.com");
	 const body = await res.text();
	 return [res.status, res.ok, res.headers["content-type"], body].join("|");`,
	async (path) => {
		if (path === "fetch") {
			return { __type: "response", id: "r1", status: 201, ok: true, headers: { "content-type": "text/plain" } };
		}
		if (path === "response.text") return "BODY";
		return null;
	},
);

if (!fetchResult || !fetchResult.data.ok) throw new Error("fetch eval-result missing or failed");
if (!String(fetchResult.data.value).includes("201|true|text/plain|BODY")) {
	throw new Error(`fetch response metadata not exposed: ${JSON.stringify(fetchResult.data.value)}`);
}
console.log("sandbox fetch proxy OK:", String(fetchResult.data.value).trim());

// Top-level helpers take one options object and the frame forwards it intact.
const clickResult = await evalOnce(8, `return await sandbox.click({ selector: "#go" });`, async () => "clicked: #go");
if (!clickResult || !clickResult.data.ok) throw new Error("options-object helper call failed");
const clickBridge = parentPosted.find((m) => m.data.kind === "bridge" && m.data.path === "click");
if (!clickBridge || clickBridge.data.args.length !== 1 || clickBridge.data.args[0].selector !== "#go") {
	throw new Error(`options object not forwarded intact: ${JSON.stringify(clickBridge?.data.args)}`);
}
console.log("sandbox options forwarding OK:", JSON.stringify(clickBridge.data.args));

// The SW-side handlers validate that shape.
const { optsOf, optionalOpts, requireString, requireNumber } = await import("../src/shared/agent/tools/sandbox/options.ts");
const expectThrows = (label, fn) => {
	try {
		fn();
	} catch {
		return;
	}
	throw new Error(`${label}: expected a throw`);
};
if (optsOf([{ selector: "#a" }], "click").selector !== "#a") throw new Error("optsOf rejected an options object");
expectThrows("optsOf positional", () => optsOf(["#a"], "click"));
expectThrows("optsOf array", () => optsOf([["#a"]], "click"));
if (Object.keys(optionalOpts([], "readDom")).length !== 0) throw new Error("optionalOpts did not default to {}");
expectThrows("optionalOpts positional", () => optionalOpts(["#a"], "readDom"));
if (requireString({ selector: "#b" }, "selector", "click") !== "#b") throw new Error("requireString failed");
expectThrows("requireString missing", () => requireString({}, "selector", "click"));
expectThrows("requireString empty", () => requireString({ selector: "" }, "selector", "click"));
if (requireNumber({ tabId: "42" }, "tabId", "switchTab") !== 42) throw new Error("requireNumber coercion failed");
expectThrows("requireNumber missing", () => requireNumber({}, "tabId", "switchTab"));
console.log("sandbox options contract OK");