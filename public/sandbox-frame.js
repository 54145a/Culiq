/**
 * Sandbox host for sandbox_exec, loaded as a hidden iframe in the active
 * side panel / pop-up window. A window context can call `new Worker` in both
 * Chrome and Firefox, so this unifies the sandbox across browsers. The
 * single-panel guard guarantees only one such iframe exists, so relaying over
 * chrome.runtime (broadcast) never duplicates responses.
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
