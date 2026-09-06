#!/usr/bin/env node

import { mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(__dirname, "template");

const name = process.argv[2];
if (!name) {
	console.error("Usage: create-culiq <project-name>");
	process.exit(1);
}

if (!/^(?:@[^/]+\/)?[a-zA-Z0-9._-]+$/.test(name)) {
	console.error(`Invalid project name: ${name}`);
	process.exit(1);
}

const target = resolve(process.cwd(), name);
try {
	mkdirSync(target, { recursive: true });
} catch (err) {
	console.error(`Cannot create directory: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}

cpSync(templateDir, target, { recursive: true });

// Replace name in package.json
const pkgPath = resolve(target, "package.json");
const pkg = readFileSync(pkgPath, "utf8").replace('"name": "my-tool"', `"name": "${name}"`);
writeFileSync(pkgPath, pkg);

// Replace name in culiq-tool.js
const toolPath = resolve(target, "culiq-tool.js");
const tool = readFileSync(toolPath, "utf8")
	.replace(/name:\s*"my-tool"/g, `name: "${name}"`)
	.replace(/name:\s*"my_tool"/g, `name: "${name}"`);
writeFileSync(toolPath, tool);

console.log(`Created ${name}`);
console.log(`  cd ${name}`);
console.log(`  pnpm install`);
console.log(`  pnpm check    # type-check your tool`);
