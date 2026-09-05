import type { AgentTool } from "../agent/types";
import { buildCustomToolAgentTool } from "./build";
import { extractMetaFromArtifact } from "./parse";
import { getUserCustomToolArtifact, listUserCustomTools } from "./storage";
import { writeTextFile } from "../skills/storage";

const BUILTIN_MANIFEST = ["bing_search"];

export type { CustomToolMeta, SavedCustomTool } from "./types";

let cache: AgentTool[] = [];
let loadPromise: Promise<AgentTool[]> | null = null;

/**
 * Sync built-in custom tools from the extension's static files to OPFS.
 * Called on every startup to ensure built-in tools are up to date.
 */
export async function syncBuiltinTools(): Promise<string[]> {
	const errors: string[] = [];
	for (const name of BUILTIN_MANIFEST) {
		try {
			const url = chrome.runtime.getURL(`custom-tools/${name}/culiq-tool.js`);
			const res = await fetch(url);
			if (!res.ok) {
				errors.push(`${name}: fetch failed (${res.status})`);
				continue;
			}
			const artifact = await res.text();
			await writeTextFile(`tools/${name}/culiq-tool.js`, artifact);

			// Extract and cache metadata.
			const meta = extractMetaFromArtifact(artifact);
			if (meta) {
				await writeTextFile(
					`tools/${name}/culiq-tool.meta.json`,
					JSON.stringify({ ...meta, source: "builtin" }, null, "\t"),
				);
			}
		} catch (err) {
			errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return errors;
}

/** Load built-in + user custom tools from OPFS and register them as AgentTools. */
export async function loadCustomTools(): Promise<AgentTool[]> {
	const userMetas = await listUserCustomTools();
	const userTools: AgentTool[] = [];
	for (const meta of userMetas) {
		const artifact = await getUserCustomToolArtifact(meta.name);
		if (artifact) userTools.push(buildCustomToolAgentTool(meta, artifact));
	}
	cache = userTools;
	return cache;
}

/** Idempotent loader; safe to call on every chat. */
export function ensureCustomToolsLoaded(): Promise<AgentTool[]> {
	if (!loadPromise) loadPromise = loadCustomTools();
	return loadPromise;
}

export function getCustomTools(): AgentTool[] {
	return cache;
}

/** Reload user tools (after install/delete) and return the refreshed list. */
export async function refreshCustomTools(): Promise<AgentTool[]> {
	loadPromise = loadCustomTools();
	return loadPromise;
}
