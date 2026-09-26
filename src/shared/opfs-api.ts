import type { Hfs } from "@humanfs/core";

/**
 * The subset of humanfs this extension uses. Kept structural so the mapping
 * below is testable without a browser (`scripts/opfs-smoke.mjs` injects a fake
 * backend; `opfs.ts` injects the real `WebHfs`).
 */
export type OpfsBackend = Pick<Hfs, "text" | "write" | "deleteAll" | "list" | "createDirectory">;

export interface OpfsApi {
	write: (path: string, content: string) => Promise<void>;
	readText: (path: string) => Promise<string | null>;
	remove: (path: string) => Promise<boolean>;
	listDir: (path: string) => Promise<string[]>;
	listDirEntries: (path: string) => Promise<Array<{ name: string; kind: string }>>;
	createDir: (path: string) => Promise<void>;
}

function assertSafePath(path: string): string {
	const cleaned = path.replace(/\\/g, "/");
	if (cleaned.startsWith("/")) throw new Error(`Invalid path (must be relative): ${path}`);
	const parts = cleaned.split("/").filter(Boolean);
	if (parts.some((p) => p === "..")) throw new Error(`Invalid path (no parent traversal): ${path}`);
	return parts.join("/");
}

/** humanfs requires a non-empty path and treats `"."` as the root. */
function resolvePath(path: string): string {
	return assertSafePath(path) || ".";
}

/** The root can be listed, but deleting it would wipe every persisted skill and tool. */
function assertDeletable(path: string): string {
	const cleaned = assertSafePath(path);
	if (cleaned === "" || cleaned === ".") {
		throw new Error(`Invalid path (refusing to delete the OPFS root): "${path}"`);
	}
	return cleaned;
}

/**
 * Map the humanfs API onto the small surface the extension uses. Preserves the
 * contract of the previous hand-written wrapper: missing files read as `null`,
 * missing directories list as `[]`, `remove` is recursive and reports whether
 * anything was deleted, and `listDir` is sorted.
 */
export function createFsApi(getBackend: () => Promise<OpfsBackend>): OpfsApi {
	return {
		write: async (path, content) => {
			await (await getBackend()).write(resolvePath(path), content);
		},

		readText: async (path) => (await (await getBackend()).text(resolvePath(path))) ?? null,

		remove: async (path) => (await getBackend()).deleteAll(assertDeletable(path)),

		listDir: async (path) => {
			const names: string[] = [];
			for await (const entry of (await getBackend()).list(resolvePath(path))) {
				names.push(entry.name);
			}
			return names.sort();
		},

		listDirEntries: async (path) => {
			const entries: Array<{ name: string; kind: string }> = [];
			for await (const entry of (await getBackend()).list(resolvePath(path))) {
				entries.push({ name: entry.name, kind: entry.isDirectory ? "directory" : "file" });
			}
			return entries;
		},

		createDir: async (path) => {
			await (await getBackend()).createDirectory(resolvePath(path));
		},
	};
}
