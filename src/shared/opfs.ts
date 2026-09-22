/**
 * Thin OPFS wrapper with path safety via assertSafePath.
 * Uses the standard File System Access API directly (no Workers) so it works
 * in both the service worker and page contexts. The previous `opfs-tools`
 * library required Workers (`createSyncAccessHandle`), which are unavailable
 * in Chrome extension service workers.
 */

function assertSafePath(path: string): string {
	const cleaned = path.replace(/\\/g, "/");
	if (cleaned.startsWith("/")) throw new Error(`Invalid path (must be relative): ${path}`);
	const parts = cleaned.split("/").filter(Boolean);
	if (parts.some((p) => p === "..")) throw new Error(`Invalid path (no parent traversal): ${path}`);
	return parts.join("/");
}

/** Resolve a relative OPFS path to a FileSystemDirectoryHandle + file name. */
async function resolveFile(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
	const parts = assertSafePath(path).split("/");
	const name = parts.pop()!;
	let dir = await navigator.storage.getDirectory();
	for (const part of parts) {
		dir = await dir.getDirectoryHandle(part, { create });
	}
	return { dir, name };
}

/** Resolve a relative OPFS path to a FileSystemDirectoryHandle. */
async function resolveDir(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
	const parts = assertSafePath(path).split("/").filter(Boolean);
	let dir = await navigator.storage.getDirectory();
	for (const part of parts) {
		dir = await dir.getDirectoryHandle(part, { create });
	}
	return dir;
}

/** Write a string to an OPFS file (creates parent dirs as needed). */
export async function write(path: string, content: string): Promise<void> {
	const { dir, name } = await resolveFile(path, true);
	const handle = await dir.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write(content);
	await writable.close();
}

/** Read a text file; returns null if not found. */
export async function readText(path: string): Promise<string | null> {
	try {
		const { dir, name } = await resolveFile(path, false);
		const handle = await dir.getFileHandle(name, { create: false });
		return await (await handle.getFile()).text();
	} catch (err) {
		if (err instanceof DOMException && err.name === "NotFoundError") return null;
		throw err;
	}
}

/** Delete a file or directory from OPFS. */
export async function remove(path: string): Promise<boolean> {
	const parts = assertSafePath(path).split("/");
	const entryName = parts.pop()!;
	try {
		let parent = await navigator.storage.getDirectory();
		for (const part of parts) {
			parent = await parent.getDirectoryHandle(part, { create: false });
		}
		await parent.removeEntry(entryName, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

/** List child names in an OPFS directory. Returns [] if not found. */
export async function listDir(path: string): Promise<string[]> {
	try {
		const dir = await resolveDir(path, false);
		const names: string[] = [];
		for await (const [name] of dir.entries()) {
			names.push(name);
		}
		return names.sort();
	} catch {
		return [];
	}
}

/** List directory entries with name and kind. Returns [] if not found. */
export async function listDirEntries(path: string): Promise<Array<{ name: string; kind: string }>> {
	try {
		const dir = await resolveDir(path, false);
		const entries: Array<{ name: string; kind: string }> = [];
		for await (const [name, handle] of dir.entries()) {
			entries.push({ name, kind: handle.kind });
		}
		return entries;
	} catch {
		return [];
	}
}

/** Create a directory at the given path (creates parents as needed). */
export async function createDir(path: string): Promise<void> {
	await resolveDir(path, true);
}
