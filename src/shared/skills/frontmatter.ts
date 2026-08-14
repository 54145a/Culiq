export interface SkillFrontmatter {
	name: string;
	description: string;
	body: string;
}

/**
 * Parse a SKILL.md following the AgentSkills spec (agentskills.io): a YAML
 * frontmatter block between leading `---` markers with at least `name` and
 * `description`, followed by the markdown body. Only the two required scalar
 * fields are parsed; everything else is ignored.
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

	return { name, description, body };
}
