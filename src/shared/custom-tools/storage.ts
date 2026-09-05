import { deleteEntry, listDir, readTextFile, writeTextFile } from "../skills/storage";
import type { CustomToolMeta, SavedCustomTool } from "./types";
import { extractMetaFromArtifact } from "./parse";

const TOOLS_DIR = "tools";

function toolFile(name: string, file: string): string {
	return `${TOOLS_DIR}/${name}/${file}`;
}

export async function deleteUserCustomTool(name: string): Promise<void> {
	await deleteEntry(`${TOOLS_DIR}/${name}`);
}

/**
 * List all user custom tools from OPFS.
 * Reads metadata from `culiq-tool.meta.json` (new format) first,
 * falls back to legacy formats and auto-migrates.
 */
export async function listUserCustomTools(): Promise<CustomToolMeta[]> {
	const names = await listDir(TOOLS_DIR);
	const out: CustomToolMeta[] = [];
	for (const name of names) {
		// New format: culiq-tool.meta.json
		const metaRaw = await readTextFile(toolFile(name, "culiq-tool.meta.json"));
		if (metaRaw) {
			try {
				const parsed = JSON.parse(metaRaw) as Omit<CustomToolMeta, "source">;
				const source = (parsed as Record<string, unknown>).source === "builtin" ? "builtin" : "user";
				out.push({ ...parsed, source });
				continue;
			} catch { /* skip malformed */ }
		}

		// Legacy: culiq-tool.json
		const jsonRaw = await readTextFile(toolFile(name, "culiq-tool.json"));
		if (jsonRaw) {
			try {
				const parsed = JSON.parse(jsonRaw) as Omit<CustomToolMeta, "source">;
				await writeTextFile(toolFile(name, "culiq-tool.meta.json"), JSON.stringify(parsed, null, "\t"));
				out.push({ ...parsed, source: "user" });
				continue;
			} catch { /* skip malformed */ }
		}

		// Legacy: package.json with culiq field
		const pkgRaw = await readTextFile(toolFile(name, "package.json"));
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
					await writeTextFile(toolFile(name, "culiq-tool.meta.json"), JSON.stringify(parsed, null, "\t"));
					out.push({ ...parsed, source: "user" });
					continue;
				}
			} catch { /* skip malformed */ }
		}
	}
	return out;
}

export async function getUserCustomToolArtifact(name: string): Promise<string | null> {
	return readTextFile(toolFile(name, "culiq-tool.js"));
}

export async function saveUserCustomTool(tool: SavedCustomTool): Promise<void> {
	await writeTextFile(toolFile(tool.name, "culiq-tool.js"), tool.artifact);
	// Cache metadata at install time.
	const meta: Omit<CustomToolMeta, "source"> = {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
	};
	await writeTextFile(toolFile(tool.name, "culiq-tool.meta.json"), JSON.stringify(meta, null, "\t"));
}

/**
 * Extract tool metadata from an artifact source string by parsing with acorn.
 * Returns null if the artifact cannot be parsed or lacks required fields.
 */
export { extractMetaFromArtifact };
