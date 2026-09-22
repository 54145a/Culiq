import type { CustomToolMeta } from "./types";
import { extractMetaFromArtifact } from "./parse";
import { readText, listDir, write, remove } from "@shared/opfs";

const TOOLS_DIR = "tools";

function toolFile(name: string, f: string): string {
	return `${TOOLS_DIR}/${name}/${f}`;
}

export async function deleteUserCustomTool(name: string): Promise<void> {
	await remove(`${TOOLS_DIR}/${name}`);
}

interface StoredToolEntry {
	toolName: string;
	description: string;
	parameters: Record<string, unknown>;
	executionMode?: "parallel" | "sequential";
}

interface StoredPackageMeta {
	name: string;
	tools: StoredToolEntry[];
}

function isPackageMeta(v: unknown): v is StoredPackageMeta {
	return typeof v === "object" && v !== null && "tools" in v && Array.isArray((v as StoredPackageMeta).tools);
}

/**
 * List all user custom tools from OPFS.
 * Reads metadata from `culiq-tool.meta.json`.
 * Supports both multi-tool (`{ name, tools: [...] }`) and legacy single-tool formats.
 */
export async function listUserCustomTools(): Promise<CustomToolMeta[]> {
	let names: string[];
	try {
		names = await listDir(TOOLS_DIR);
	} catch {
		return [];
	}
	const out: CustomToolMeta[] = [];
	for (const pkgName of names) {
		const metaRaw = await readText(toolFile(pkgName, "culiq-tool.meta.json"));
		if (!metaRaw) continue;
		try {
			const parsed = JSON.parse(metaRaw);
			const source: CustomToolMeta["source"] = (parsed as Record<string, unknown>).source === "builtin" ? "builtin" : "user";

			if (isPackageMeta(parsed)) {
				for (let i = 0; i < parsed.tools.length; i++) {
					const t = parsed.tools[i];
					out.push({
						name: parsed.name,
						toolName: t.toolName,
						description: t.description,
						parameters: t.parameters,
						source,
						toolIndex: i,
						...(t.executionMode ? { executionMode: t.executionMode } : {}),
					});
				}
			} else {
				// Legacy single-tool format: { name, description, parameters, ... }
				const toolName = parsed.name ?? pkgName;
				out.push({
					name: pkgName,
					toolName,
					description: String(parsed.description ?? ""),
					parameters: parsed.parameters ?? {},
					source,
					toolIndex: -1,
					...(parsed.executionMode ? { executionMode: parsed.executionMode } : {}),
				});
			}
		} catch { /* skip malformed */ }
	}
	return out;
}

export async function getUserCustomToolArtifact(name: string): Promise<string | null> {
	const content = await readText(toolFile(name, "culiq-tool.js"));
	return content || null;
}

/**
 * Save a multi-tool package to OPFS.
 * The artifact is a single JS file; the meta lists all tools in the package.
 */
export async function saveCustomToolPackage(
	pkgName: string,
	artifact: string,
	tools: Array<{ toolName: string; description: string; parameters: Record<string, unknown>; executionMode?: "parallel" | "sequential" }>,
): Promise<void> {
	await write(toolFile(pkgName, "culiq-tool.js"), artifact);
	const meta: StoredPackageMeta = { name: pkgName, tools };
	await write(toolFile(pkgName, "culiq-tool.meta.json"), JSON.stringify(meta, null, "\t"));
}

export { extractMetaFromArtifact };
