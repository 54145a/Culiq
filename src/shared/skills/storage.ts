/** Low-level persistence for skills: OPFS files plus extension metadata in chrome.storage.local. */

import type { Skill } from "./index";

export type SkillSource = Skill["source"];

export interface SkillMeta {
	source: SkillSource;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

const META_KEY = "curio.skills.meta";
type MetaMap = Record<string, SkillMeta>;

async function readMeta(): Promise<MetaMap> {
	const raw = await chrome.storage.local.get(META_KEY);
	return (raw[META_KEY] as MetaMap | undefined) ?? {};
}

async function writeMeta(meta: MetaMap): Promise<void> {
	await chrome.storage.local.set({ [META_KEY]: meta });
}

export async function getSkillMeta(name: string): Promise<SkillMeta | undefined> {
	const meta = await readMeta();
	return meta[name];
}

export async function setSkillMeta(name: string, meta: SkillMeta): Promise<void> {
	const all = await readMeta();
	all[name] = meta;
	await writeMeta(all);
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
	const all = await readMeta();
	const entry = all[name];
	if (!entry) return;
	entry.enabled = enabled;
	entry.updatedAt = Date.now();
	await writeMeta(all);
}

export async function deleteSkillMeta(name: string): Promise<void> {
	const all = await readMeta();
	delete all[name];
	await writeMeta(all);
}

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
