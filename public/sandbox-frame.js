/**
 * Sandbox host for sandbox_exec, loaded as a hidden *sandboxed* iframe
 * (`sandbox="allow-scripts"`) in the active side panel. Runs agent code directly
 * in this page — NOT a Worker: a dedicated Worker inherits the extension_pages
 * CSP (no unsafe-eval), while this sandboxed page uses the manifest
 * `content_security_policy.sandbox` value (which allows eval). The iframe is
 * opaque-origin (no chrome.* access), so all traffic is relayed through the
 * parent panel via window.postMessage; the panel forwards it to the service
 * worker over chrome.runtime.
 *
 * Protocol:
 *   parent -> frame:  { __culiq: "sandbox", sessionId, data }   init / eval / bridge-result / close
 *   frame -> parent:  { __culiq: "sandbox", sessionId, data }   eval-result / bridge (request)
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

/** One sandbox session = one agent turn. Each holds its own sandbox object and pending bridge calls. */
const sessions = new Map();

function session(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, sandbox: { fs, fetch: (input, init) => fetch(input, init) }, pending: new Map(), nextBridgeId: 1 };
    sessions.set(id, s);
  }
  return s;
}

function bridgeCall(sess, path, args) {
  return new Promise((resolve, reject) => {
    const id = sess.nextBridgeId++;
    sess.pending.set(id, { resolve, reject });
    window.parent.postMessage({ __culiq: "sandbox", sessionId: sess.id, data: { kind: "bridge", id, path, args } }, "*");
  });
}

function buildShims(sess, paths) {
  sess.sandbox.chrome = {};
  for (const path of paths) {
    const dot = path.indexOf(".");
    if (dot === -1) {
      sess.sandbox[path] = (...args) => bridgeCall(sess, path, args);
    } else {
      const ns = path.slice(0, dot);
      const method = path.slice(dot + 1);
      (sess.sandbox.chrome[ns] ??= {})[method] = (...args) => bridgeCall(sess, path, args);
    }
  }
}

function send(sess, data) {
  window.parent.postMessage({ __culiq: "sandbox", sessionId: sess.id, data }, "*");
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || msg.__culiq !== "sandbox") return;
  const sess = session(msg.sessionId);
  const data = msg.data || {};

  if (data.kind === "init") {
    buildShims(sess, data.paths || []);
    return;
  }

  if (data.kind === "close") {
    sessions.delete(msg.sessionId);
    return;
  }

  if (data.kind === "bridge-result") {
    const pending = sess.pending.get(data.id);
    if (pending) {
      sess.pending.delete(data.id);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new Error(data.error || "bridge error"));
    }
    return;
  }

  if (data.kind === "eval") {
    void (async () => {
      try {
        const fn = new Function("sandbox", "return (async () => { " + data.code + " })()");
        const value = await fn(sess.sandbox);
        send(sess, { kind: "eval-result", id: data.id, ok: true, value: typeof value === "string" ? value : serialize(value) });
      } catch (err) {
        send(sess, { kind: "eval-result", id: data.id, ok: false, error: (err && (err.stack || err.message)) || String(err) });
      }
    })();
  }
});