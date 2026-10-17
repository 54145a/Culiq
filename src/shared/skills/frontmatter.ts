export interface SkillFrontmatter {
	name: string;
	description: string;
	body: string;
	version?: string;
	author?: string;
	license?: string;
	dependsOn?: string[];
	tools?: string[];
	triggers?: string[];
	keywords?: string[];
}

/**
 * Parse a SKILL.md following the AgentSkills spec (agentskills.io): a YAML
 * frontmatter block between leading `---` markers with at least `name` and
 * `description`, followed by the markdown body.
 *
 * Additional scalar fields (version, author, license) and sequence fields
 * (depends_on, tools, triggers, keywords) are parsed when present; missing
 * or malformed fields yield undefined / [] rather than throwing.
 */
export function parseSkillMarkdown(content: string): SkillFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) {
		throw new Error("SKILL.md must start with a YAML frontmatter block delimited by `---`.");
	}
	const frontmatter = match[1];
	const body = (match[2] ?? "").trim();

	const fields = new Map<string, string>();
	for (const line of frontmatter.split(/\r?\n/)) {
		const m = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*?)\s*$/.exec(line);
		if (m) fields.set(m[1].toLowerCase(), m[2].replace(/^["']|["']$/g, ""));
	}

	const name = fields.get("name")?.trim();
	const description = fields.get("description")?.trim();
	if (!name) throw new Error("SKILL.md frontmatter is missing `name`.");
	if (!description) throw new Error("SKILL.md frontmatter is missing `description`.");

	return {
		name,
		description,
		body,
		version: fields.get("version") || undefined,
		author: fields.get("author") || undefined,
		license: fields.get("license") || undefined,
		dependsOn: parseStringArray(fields.get("depends_on")),
		tools: parseStringArray(fields.get("tools")),
		triggers: parseStringArray(fields.get("triggers")),
		keywords: parseStringArray(fields.get("keywords")),
	};
}

/** Parse a YAML scalar that may be a comma/space-separated list or inline [] */
function parseStringArray(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1);
		return inner ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
	}
	// comma or newline separated
	const items = trimmed.split(/[\n,]+/).map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
	return items.length > 0 ? items : undefined;
}
