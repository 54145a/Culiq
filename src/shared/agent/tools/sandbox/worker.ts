/**
 * Sandbox worker factory. The worker runs as a static extension file loaded via
 * chrome.runtime.getURL — MV3 service workers have no URL.createObjectURL, so
 * blob-based workers cannot be created from the background. The bridge surface
 * (sandbox.chrome.* etc.) is built by the worker from the BRIDGE_SPEC paths sent
 * in the init message, so it always matches the .d.ts injected in the prompt.
 */
import { BRIDGE_SPEC } from "./api";

export function createSandboxWorker(): Worker {
	const worker = new Worker(chrome.runtime.getURL("sandbox-worker.js"));
	worker.postMessage({ kind: "init", paths: Object.keys(BRIDGE_SPEC) });
	return worker;
}
