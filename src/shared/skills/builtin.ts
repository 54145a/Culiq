import { parseSkillMarkdown } from "./frontmatter";
import type { Skill } from "./index";

/**
 * Builtin skills ship with the extension under `public/skills/<name>/`.
 * The `scripts` list must mirror the files in that directory.
 *
 * Currently no builtin skills are bundled; the directory is reserved so a
 * curated set can be added later without changing the loading code.
 */
const BUILTIN_MANIFEST: Array<{ name: string; scripts: string[] }> = [];

const BUILTIN_PREFIX = "skills";

function builtinUrl(name: string, ...parts: string[]): string {
	return chrome.runtime.getURL([BUILTIN_PREFIX, name, ...parts].join("/"));
}

async function fetchText(url: string): Promise<string | null> {
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

export async function listBuiltinSkills(): Promise<Skill[]> {
	const out: Skill[] = [];
	for (const entry of BUILTIN_MANIFEST) {
		const raw = await fetchText(builtinUrl(entry.name, "SKILL.md"));
		if (!raw) continue;
		try {
			const { name, description } = parseSkillMarkdown(raw);
			const scripts: Record<string, string> = {};
			for (const file of entry.scripts) {
				const src = await fetchText(builtinUrl(entry.name, "scripts", file));
				if (src !== null) scripts[file] = src;
			}
			out.push({
				id: `builtin:${name}`,
				name,
				description,
				content: raw,
				scripts,
				source: "builtin",
				enabled: true,
				createdAt: 0,
				updatedAt: 0,
			});
		} catch {
			// skip malformed builtin skill
		}
	}
	return out;
}
