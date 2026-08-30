import type { AgentTool } from "../agent/types";
import { getBuiltinCustomTools } from "./builtin";
import { buildCustomToolAgentTool } from "./build";
import { getUserCustomToolArtifact, listUserCustomTools } from "./storage";

export type { CustomToolMeta, SavedCustomTool } from "./types";

let cache: AgentTool[] = [];
let loadPromise: Promise<AgentTool[]> | null = null;

/** Load built-in + user custom tools from OPFS and register them as AgentTools. */
export async function loadCustomTools(): Promise<AgentTool[]> {
	const builtin = getBuiltinCustomTools();
	const userMetas = await listUserCustomTools();
	const userTools: AgentTool[] = [];
	for (const meta of userMetas) {
		const artifact = await getUserCustomToolArtifact(meta.name);
		if (artifact) userTools.push(buildCustomToolAgentTool(meta, artifact));
	}
	cache = [...builtin, ...userTools];
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
