import type { CustomToolMeta, SavedCustomTool } from "./types";
import { extractMetaFromArtifact } from "./parse";
import { file, dir, write } from "@shared/opfs";

const TOOLS_DIR = "tools";

function toolFile(name: string, file: string): string {
	return `${TOOLS_DIR}/${name}/${file}`;
}

export async function deleteUserCustomTool(name: string): Promise<void> {
	await dir(`${TOOLS_DIR}/${name}`).remove();
}

/**
 * List all user custom tools from OPFS.
 * Reads metadata from `culiq-tool.meta.json` (new format) first,
 * falls back to legacy formats and auto-migrates.
 */
export async function listUserCustomTools(): Promise<CustomToolMeta[]> {
	let names: string[];
	try {
		names = (await dir(TOOLS_DIR).children()).map((c) => c.name).sort();
	} catch {
		return [];
	}
	const out: CustomToolMeta[] = [];
	for (const name of names) {
		// New format: culiq-tool.meta.json
		const metaRaw = await file(toolFile(name, "culiq-tool.meta.json")).text();
		if (metaRaw) {
			try {
				const parsed = JSON.parse(metaRaw) as Omit<CustomToolMeta, "source">;
				const source = (parsed as Record<string, unknown>).source === "builtin" ? "builtin" : "user";
				out.push({ ...parsed, source });
				continue;
			} catch { /* skip malformed */ }
		}

		// Legacy: culiq-tool.json
		const jsonRaw = await file(toolFile(name, "culiq-tool.json")).text();
		if (jsonRaw) {
			try {
				const parsed = JSON.parse(jsonRaw) as Omit<CustomToolMeta, "source">;
				await write(toolFile(name, "culiq-tool.meta.json"), JSON.stringify(parsed, null, "\t"));
				out.push({ ...parsed, source: "user" });
				continue;
			} catch { /* skip malformed */ }
		}

		// Legacy: package.json with culiq field
		const pkgRaw = await file(toolFile(name, "package.json")).text();
		if (pkgRaw) {
			try {
				const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
				const culiq = pkg.culiq as Record<string, unknown> | undefined;
				if (culiq) {
					const executionMode = culiq.executionMode === "parallel" || culiq.executionMode === "sequential"
						? culiq.executionMode
						: undefined;
					const parsed: Omit<CustomToolMeta, "source"> = {
						name: String(pkg.name ?? name),
						description: String(pkg.description ?? ""),
						parameters: (culiq.parameters as Record<string, unknown>) ?? {},
						...(executionMode ? { executionMode } : {}),
					};
					await write(toolFile(name, "culiq-tool.meta.json"), JSON.stringify(parsed, null, "\t"));
					out.push({ ...parsed, source: "user" });
					continue;
				}
			} catch { /* skip malformed */ }
		}
	}
	return out;
}

export async function getUserCustomToolArtifact(name: string): Promise<string | null> {
	const content = await file(toolFile(name, "culiq-tool.js")).text();
	return content || null;
}

export async function saveUserCustomTool(tool: SavedCustomTool): Promise<void> {
	await write(toolFile(tool.name, "culiq-tool.js"), tool.artifact);
	// Cache metadata at install time.
	const meta: Omit<CustomToolMeta, "source"> = {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
	};
	await write(toolFile(tool.name, "culiq-tool.meta.json"), JSON.stringify(meta, null, "\t"));
}

/**
 * Extract tool metadata from an artifact source string by parsing with acorn.
 * Returns null if the artifact cannot be parsed or lacks required fields.
 */
export { extractMetaFromArtifact };
