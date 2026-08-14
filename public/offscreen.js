/**
 * Offscreen document host for sandbox_exec. Chrome MV3 service workers cannot
 * call `new Worker`, so the sandbox worker runs in this window context and the
 * service worker relays messages through chrome.runtime. One host serves every
 * sandbox session, keyed by sessionId (Chrome keeps a single offscreen doc).
 *
 * Protocol (all via chrome.runtime messages):
 *   SW -> host:  { type: "sandbox_send", sessionId, data }   forward to worker
 *   SW -> host:  { type: "sandbox_close", sessionId }        terminate worker
 *   host -> SW:  { type: "sandbox_msg", sessionId, data }    from worker
 */
const workers = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "sandbox_send") return false;
  const id = msg.sessionId;

  if (msg.data && msg.data.kind === "close") {
    const w = workers.get(id);
    if (w) {
      w.terminate();
      workers.delete(id);
    }
    return false;
  }

  let worker = workers.get(id);
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL("sandbox-worker.js"));
    worker.addEventListener("message", (e) => {
      chrome.runtime.sendMessage({ type: "sandbox_msg", sessionId: id, data: e.data });
    });
    workers.set(id, worker);
  }
  worker.postMessage(msg.data);
  return false;
});
