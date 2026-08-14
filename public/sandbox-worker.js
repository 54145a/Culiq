/**
 * Sandbox worker for sandbox_exec. A dedicated worker with no chrome.* access —
 * extension access goes through the postMessage bridge handled in the service
 * worker. Kept as a static extension file so the MV3 service worker can create
 * it from chrome.runtime.getURL (URL.createObjectURL does not exist there).
 *
 * The SW sends { kind: "init", paths } on creation; this builds sandbox.chrome.*
 * and the top-level bridge functions from the shared BRIDGE_SPEC paths.
 */

var MAX_FILE_BYTES = 1048576;

function safePath(p) {
  if (typeof p !== "string") throw new Error("fs: path must be a string");
  const cleaned = p.replace(/\\/g, "/");
  if (cleaned.startsWith("/")) throw new Error("fs: path must be relative");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.some((x) => x === "..")) throw new Error("fs: parent traversal is not allowed");
  return parts.join("/");
}

function serialize(v) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(v, function (_k, val) {
      if (val === undefined) return "[undefined]";
      if (val === null) return null;
      if (typeof val === "function") return "[Function " + (val.name || "anonymous") + "]";
      if (typeof val === "symbol") return val.toString();
      if (typeof val === "bigint") return val.toString() + "n";
      if (val instanceof Error) return { __type: "Error", name: val.name, message: val.message, stack: val.stack };
      if (val instanceof Date) return { __type: "Date", iso: val.toISOString() };
      if (val instanceof RegExp) return val.toString();
      if (val instanceof Map) return { __type: "Map", entries: Array.from(val.entries()).slice(0, 50) };
      if (val instanceof Set) return { __type: "Set", values: Array.from(val.values()).slice(0, 50) };
      if (typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }, 2);
  } catch (err) {
    return "[stringify failed: " + (err instanceof Error ? err.message : String(err)) + "]";
  }
}

async function opfsRoot() {
  return navigator.storage.getDirectory();
}

async function getDir(parts, create) {
  let dir = await opfsRoot();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function getFile(parts, create) {
  const dir = await getDir(parts.slice(0, -1), create);
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

const fs = {
  async read(p) {
    const parts = safePath(p).split("/");
    const handle = await getFile(parts, false);
    const file = await handle.getFile();
    if (file.size > MAX_FILE_BYTES) throw new Error("fs: file too large (" + file.size + " bytes)");
    return await file.text();
  },
  async write(p, content) {
    if (typeof content !== "string") throw new Error("fs: content must be a string");
    if (content.length > MAX_FILE_BYTES) throw new Error("fs: content too large");
    const parts = safePath(p).split("/");
    const handle = await getFile(parts, true);
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  },
  async list(p) {
    const parts = safePath(p).split("/").filter(Boolean);
    let dir;
    try {
      dir = parts.length === 0 ? await opfsRoot() : await getDir(parts, false);
    } catch (err) {
      if (err && err.name === "NotFoundError") return [];
      throw err;
    }
    const out = [];
    for await (const entry of dir.entries()) out.push(entry[0]);
    return out.sort();
  },
  async delete(p) {
    const parts = safePath(p).split("/");
    const dir = await getDir(parts.slice(0, -1), false);
    await dir.removeEntry(parts[parts.length - 1], { recursive: true });
  },
  async mkdir(p) {
    const parts = safePath(p).split("/").filter(Boolean);
    if (parts.length) await getDir(parts, true);
  },
};

const sandbox = {
  fs,
  fetch: (input, init) => fetch(input, init),
};

const bridgeCalls = new Map();
let nextBridgeId = 1;
function bridgeCall(path, args) {
  return new Promise((resolve, reject) => {
    const id = nextBridgeId++;
    bridgeCalls.set(id, { resolve, reject });
    self.postMessage({ kind: "bridge", id, path, args });
  });
}

self.onmessage = (e) => {
  const data = e.data || {};

  if (data.kind === "init") {
    sandbox.chrome = {};
    for (const path of data.paths) {
      const dot = path.indexOf(".");
      if (dot === -1) {
        sandbox[path] = (...args) => bridgeCall(path, args);
      } else {
        const ns = path.slice(0, dot);
        const method = path.slice(dot + 1);
        (sandbox.chrome[ns] ??= {})[method] = (...args) => bridgeCall(path, args);
      }
    }
    return;
  }

  if (data.kind === "bridge-result") {
    const pending = bridgeCalls.get(data.id);
    if (!pending) return;
    bridgeCalls.delete(data.id);
    if (data.ok) pending.resolve(data.value);
    else pending.reject(new Error(data.error || "bridge error"));
    return;
  }

  if (data.kind !== "eval") return;
  void (async () => {
    try {
      const fn = new Function("sandbox", "return (async () => { " + data.code + " })()");
      const value = await fn(sandbox);
      self.postMessage({ kind: "eval-result", id: data.id, ok: true, value: typeof value === "string" ? value : serialize(value) });
    } catch (err) {
      self.postMessage({ kind: "eval-result", id: data.id, ok: false, error: (err && (err.stack || err.message)) || String(err) });
    }
  })();
};
