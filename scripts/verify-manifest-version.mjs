// @ts-nocheck
/**
 * Release guard: the built manifest version must match the release tag.
 * Run: node scripts/verify-manifest-version.mjs <chrome|firefox> <expected version>
 */
import { readFileSync } from "node:fs";

const [target, expected] = process.argv.slice(2);
if (!target || !expected) {
	console.error("usage: node scripts/verify-manifest-version.mjs <chrome|firefox> <expected version>");
	process.exit(2);
}

const path = `dist-${target}/manifest.json`;
let actual;
try {
	actual = JSON.parse(readFileSync(path, "utf8")).version;
} catch (err) {
	console.error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}

if (actual !== expected) {
	console.error(`version mismatch: ${path} says "${actual}" but the tag expects "${expected}"`);
	console.error("bump src/manifest.base.json (and package.json) before tagging a release");
	process.exit(1);
}

console.log(`${path} version ${actual} matches the tag`);
