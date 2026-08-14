/** Low-level OPFS helpers for skill storage. Paths are relative to the OPFS root. */

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
	entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

function assertSafePath(path: string): string {
	const cleaned = path.replace(/\\/g, "/");
	if (cleaned.startsWith("/")) throw new Error(`Invalid path (must be relative): ${path}`);
	const parts = cleaned.split("/").filter(Boolean);
	if (parts.some((p) => p === "..")) throw new Error(`Invalid path (no parent traversal): ${path}`);
	return parts.join("/");
}

async function rootDir(): Promise<FileSystemDirectoryHandle> {
	return navigator.storage.getDirectory();
}

async function getDir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
	const root = await rootDir();
	let dir = root;
	for (const part of parts) {
		dir = await dir.getDirectoryHandle(part, { create });
	}
	return dir;
}

async function getFile(parts: string[], create: boolean): Promise<FileSystemFileHandle> {
	const dir = await getDir(parts.slice(0, -1), create);
	return dir.getFileHandle(parts[parts.length - 1], { create });
}

export async function readTextFile(path: string): Promise<string | null> {
	const parts = assertSafePath(path).split("/");
	try {
		const handle = await getFile(parts, false);
		return await (await handle.getFile()).text();
	} catch (err) {
		if (err instanceof DOMException && err.name === "NotFoundError") return null;
		throw err;
	}
}

export async function writeTextFile(path: string, content: string): Promise<void> {
	const parts = assertSafePath(path).split("/");
	const handle = await getFile(parts, true);
	const writable = await handle.createWritable();
	await writable.write(content);
	await writable.close();
}

export async function listDir(path: string): Promise<string[]> {
	const parts = assertSafePath(path).split("/").filter(Boolean);
	let dir: FileSystemDirectoryHandle;
	try {
		dir = parts.length === 0 ? await rootDir() : await getDir(parts, false);
	} catch (err) {
		if (err instanceof DOMException && err.name === "NotFoundError") return [];
		throw err;
	}
	const names: string[] = [];
	for await (const [name] of (dir as IterableDirectoryHandle).entries()) names.push(name);
	return names.sort();
}

export async function deleteEntry(path: string): Promise<boolean> {
	const parts = assertSafePath(path).split("/");
	const dir = await getDir(parts.slice(0, -1), false);
	try {
		await dir.removeEntry(parts[parts.length - 1], { recursive: true });
		return true;
	} catch (err) {
		if (err instanceof DOMException && err.name === "NotFoundError") return false;
		throw err;
	}
}
