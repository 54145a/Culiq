// @ts-nocheck
/**
 * Smoke test for the OPFS wrapper (src/shared/opfs-api.ts) driven through the
 * real humanfs core with an in-memory impl — no browser required.
 * Run: node scripts/opfs-smoke.mjs
 */
import { Hfs } from "@humanfs/core";
import { createFsApi } from "../src/shared/opfs-api.ts";

let pass = 0;
let fail = 0;
const expect = (label, actual, want) => {
	const ok = JSON.stringify(actual) === JSON.stringify(want);
	if (ok) pass++;
	else {
		fail++;
		console.log(`FAIL ${label}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(want)}`);
	}
};
const expectRejects = async (label, fn) => {
	try {
		await fn();
		fail++;
		console.log(`FAIL ${label}: resolved instead of throwing`);
	} catch {
		pass++;
	}
};

/** Minimal in-memory HfsImpl mirroring @humanfs/web semantics. */
function memoryImpl() {
	const files = new Map();
	const dirs = new Set();
	const norm = (p) => {
		const s = String(p).replace(/^\.\//, "").replace(/\/+$/, "");
		return s === "." ? "" : s;
	};
	const parentOf = (p) => {
		const i = p.lastIndexOf("/");
		return i < 0 ? "" : p.slice(0, i);
	};
	const ensureDirs = (p) => {
		let cur = parentOf(p);
		while (cur) {
			dirs.add(cur);
			cur = parentOf(cur);
		}
	};
	const childrenOf = (dir) => {
		const out = new Map();
		for (const d of dirs) if (parentOf(d) === dir && d) out.set(d.slice(dir ? dir.length + 1 : 0), "directory");
		for (const f of files.keys()) if (parentOf(f) === dir) out.set(f.slice(dir ? dir.length + 1 : 0), "file");
		return out;
	};
	const exists = (p) => files.has(p) || dirs.has(p) || [...childrenOf(p).keys()].length > 0;

	return {
		files,
		async bytes(p) {
			const v = files.get(norm(p));
			return v === undefined ? undefined : new TextEncoder().encode(v);
		},
		async write(p, contents) {
			const key = norm(p);
			files.set(key, typeof contents === "string" ? contents : new TextDecoder().decode(contents));
			ensureDirs(key);
		},
		async createDirectory(p) {
			dirs.add(norm(p));
			ensureDirs(norm(p));
		},
		async deleteAll(p) {
			const key = norm(p);
			if (!exists(key)) return false;
			files.delete(key);
			dirs.delete(key);
			for (const f of [...files.keys()]) if (f.startsWith(`${key}/`)) files.delete(f);
			for (const d of [...dirs]) if (d.startsWith(`${key}/`)) dirs.delete(d);
			return true;
		},
		async *list(p) {
			const dir = norm(p);
			if (!exists(dir)) return;
			for (const [name, kind] of childrenOf(dir)) {
				yield { name, isFile: kind === "file", isDirectory: kind === "directory", isSymlink: false };
			}
		},
	};
}

const makeApi = () => {
	const backend = new Hfs({ impl: memoryImpl() });
	return createFsApi(async () => backend);
};

// 1. write creates parent directories; read round-trips
{
	const api = makeApi();
	await api.write("tools/bing/culiq-tool.js", "artifact");
	expect("write + readText round-trip", await api.readText("tools/bing/culiq-tool.js"), "artifact");
}

// 2. missing paths follow the wrapper contract
{
	const api = makeApi();
	expect("missing file reads as null", await api.readText("tools/nope.js"), null);
	expect("missing directory lists as []", await api.listDir("tools"), []);
	expect("missing directory entries as []", await api.listDirEntries("tools"), []);
	expect("removing a missing path is false", await api.remove("tools"), false);
}

// 3. listDir is sorted; listDirEntries maps kind
{
	const api = makeApi();
	await api.write("skills/b/SKILL.md", "b");
	await api.write("skills/a/SKILL.md", "a");
	await api.write("skills/readme.txt", "r");
	expect("listDir sorted", await api.listDir("skills"), ["a", "b", "readme.txt"]);
	expect("listDirEntries kinds", (await api.listDirEntries("skills")).sort((x, y) => x.name.localeCompare(y.name)), [
		{ name: "a", kind: "directory" },
		{ name: "b", kind: "directory" },
		{ name: "readme.txt", kind: "file" },
	]);
}

// 4. remove is recursive (non-empty directory) and reports success
{
	const api = makeApi();
	await api.write("tools/pkg/culiq-tool.js", "x");
	await api.write("tools/pkg/culiq-tool.meta.json", "{}");
	expect("recursive remove returns true", await api.remove("tools/pkg"), true);
	expect("children are gone", await api.listDir("tools"), []);
	expect("second remove returns false", await api.remove("tools/pkg"), false);
}

// 5. createDir is recursive
{
	const api = makeApi();
	await api.createDir("skills/deep/nested");
	expect("createDir lists at first level", await api.listDir("skills"), ["deep"]);
	expect("createDir lists nested", await api.listDirEntries("skills/deep"), [{ name: "nested", kind: "directory" }]);
}

// 6. root path ("") still works — sandbox.tree() calls with a possibly empty path
{
	const api = makeApi();
	await api.write("top.txt", "1");
	expect("empty path lists the root", await api.listDir(""), ["top.txt"]);
	expect("dot path lists the root", await api.listDir("."), ["top.txt"]);
}

// 7. path guard still rejects absolute and parent-traversal paths
{
	const api = makeApi();
	await expectRejects("absolute path rejected", () => api.listDir("/etc"));
	await expectRejects("traversal rejected", () => api.write("../outside.txt", "x"));
	await expectRejects("traversal rejected in the middle", () => api.readText("tools/../../x"));
}

// 8. the root can be listed but never deleted (sandbox fs.delete("") / dir("").remove())
{
	const api = makeApi();
	await api.write("skills/keep/SKILL.md", "keep me");
	await expectRejects("remove('') rejected", () => api.remove(""));
	await expectRejects("remove('.') rejected", () => api.remove("."));
	await expectRejects("remove('./') rejected", () => api.remove("./"));
	expect("root survived", await api.readText("skills/keep/SKILL.md"), "keep me");
	expect("root still lists", await api.listDir(""), ["skills"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
