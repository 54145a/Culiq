import { WebHfs } from "@humanfs/web";
import { createFsApi, type OpfsBackend } from "./opfs-api";

/**
 * Browser/extension seam for OPFS, backed by humanfs.
 *
 * `@humanfs/web` only uses `createWritable` / `getFileHandle` /
 * `getDirectoryHandle` / `removeEntry` — never `createSyncAccessHandle` — so it
 * is safe in an MV3 service worker (unlike `opfs-tools`, which needed Workers).
 *
 * Importing `@humanfs/web` evaluates a module-level
 * `await navigator.storage.getDirectory()` for its own default `hfs` export, so
 * that handle already exists by the time we build our instance; the promise
 * below memoises our own binding to it.
 */
let backend: Promise<OpfsBackend> | undefined;

function getBackend(): Promise<OpfsBackend> {
	return (backend ??= navigator.storage.getDirectory().then((root) => new WebHfs({ root })));
}

const api = createFsApi(getBackend);

export const write = api.write;
export const readText = api.readText;
export const remove = api.remove;
export const listDir = api.listDir;
export const listDirEntries = api.listDirEntries;
export const createDir = api.createDir;
