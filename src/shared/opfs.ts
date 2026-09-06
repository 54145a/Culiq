/**
 * Thin wrapper around opfs-tools that adds path safety via assertSafePath.
 * All OPFS operations in the extension should go through this module.
 */
import { file as otFile, dir as otDir, write as otWrite } from "opfs-tools";

export type { OTFile, OTDir } from "opfs-tools";

function assertSafePath(path: string): string {
	const cleaned = path.replace(/\\/g, "/");
	if (cleaned.startsWith("/")) throw new Error(`Invalid path (must be relative): ${path}`);
	const parts = cleaned.split("/").filter(Boolean);
	if (parts.some((p) => p === "..")) throw new Error(`Invalid path (no parent traversal): ${path}`);
	return parts.join("/");
}

/** Access a file with path safety. */
export function file(path: string) {
	return otFile(assertSafePath(path));
}

/** Access a directory with path safety. */
export function dir(path: string) {
	return otDir(assertSafePath(path));
}

/** Write a file with path safety. */
export async function write(path: string, content: string) {
	await otWrite(assertSafePath(path), content);
}
