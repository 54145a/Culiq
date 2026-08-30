import { deleteEntry, listDir, readTextFile, writeTextFile } from "../skills/storage";
import type { CustomToolMeta, SavedCustomTool } from "./types";

const TOOLS_DIR = "tools";

function toolFile(name: string, file: string): string {
	return `${TOOLS_DIR}/${name}/${file}`;
}

export async function saveUserCustomTool(tool: SavedCustomTool): Promise<void> {
	await writeTextFile(
		toolFile(tool.name, "culiq-tool.json"),
		JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		}),
	);
	await writeTextFile(toolFile(tool.name, "culiq-tool.js"), tool.artifact);
}

export async function deleteUserCustomTool(name: string): Promise<void> {
	await deleteEntry(`${TOOLS_DIR}/${name}`);
}

export async function listUserCustomTools(): Promise<CustomToolMeta[]> {
	const names = await listDir(TOOLS_DIR);
	const out: CustomToolMeta[] = [];
	for (const name of names) {
		const raw = await readTextFile(toolFile(name, "culiq-tool.json"));
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw) as Omit<CustomToolMeta, "source">;
			out.push({ ...parsed, source: "user" });
		} catch {
			// skip malformed entry
		}
	}
	return out;
}

export async function getUserCustomToolArtifact(name: string): Promise<string | null> {
	return readTextFile(toolFile(name, "culiq-tool.js"));
}
