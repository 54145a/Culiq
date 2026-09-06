import { listBuiltinSkills } from "./builtin";
import { parseSkillMarkdown } from "./frontmatter";
import { deleteSkillMeta, getSkillMeta, setSkillEnabled as setMetaEnabled, setSkillMeta } from "./storage";
import { file as opfsFile, dir, write } from "@shared/opfs";

export interface Skill {
	id: string;
	name: string;
	description: string;
	/** Full SKILL.md content (frontmatter + body). */
	content: string;
	/** Script files: file name -> source. */
	scripts: Record<string, string>;
	/** "builtin" ships with the extension; "user" is installed into OPFS. */
	source: "builtin" | "user";
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

const SKILLS_DIR = "skills";

function skillDir(name: string): string {
	return `${SKILLS_DIR}/${name}`;
}

function skillFilePath(name: string, file: string): string {
	return `${SKILLS_DIR}/${name}/${file}`;
}

/** List user skills stored in OPFS. */
export async function listUserSkills(): Promise<Skill[]> {
	const names = (await dir(SKILLS_DIR).children()).map((c) => c.name).sort();
	const skills: Skill[] = [];
	for (const name of names) {
		const skill = await getUserSkill(name);
		if (skill) skills.push(skill);
	}
	return skills;
}

export async function getUserSkill(name: string): Promise<Skill | undefined> {
	const content = await opfsFile(skillFilePath(name, "SKILL.md")).text();
	if (!content) return undefined;
	let parsed: ReturnType<typeof parseSkillMarkdown>;
	try {
		parsed = parseSkillMarkdown(content);
	} catch {
		return undefined;
	}

	const meta = (await getSkillMeta(parsed.name)) ?? {
		source: "user" as const,
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
	};

	const scripts: Record<string, string> = {};
	const files = (await dir(skillDir(name)).children()).map((c) => c.name);
	for (const file of files) {
		if (file === "SKILL.md") continue;
		scripts[file] = await opfsFile(skillFilePath(name, file)).text();
	}

	return {
		id: `user:${parsed.name}`,
		name: parsed.name,
		description: parsed.description,
		content,
		scripts,
		source: "user",
		enabled: meta.enabled,
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
	};
}

export async function saveUserSkill(skill: Skill): Promise<void> {
	await write(skillFilePath(skill.name, "SKILL.md"), skill.content);
	for (const [file, source] of Object.entries(skill.scripts)) {
		await write(skillFilePath(skill.name, file), source);
	}
	await setSkillMeta(skill.name, {
		source: "user",
		enabled: skill.enabled,
		createdAt: skill.createdAt,
		updatedAt: skill.updatedAt,
	});
}

export async function deleteUserSkill(name: string): Promise<void> {
	await dir(skillDir(name)).remove();
	await deleteSkillMeta(name);
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
	await setMetaEnabled(name, enabled);
}

/** All skills (builtin + user), builtin first. */
export async function listSkills(): Promise<Skill[]> {
	const [builtin, user] = await Promise.all([listBuiltinSkills(), listUserSkills()]);
	const byName = new Map(user.map((s) => [s.name, s]));
	return [...builtin.filter((b) => !byName.has(b.name)), ...user];
}

/** Enabled skills, used to build the `<available_skills>` prompt block. */
export async function listEnabledSkills(): Promise<Skill[]> {
	return (await listSkills()).filter((s) => s.enabled);
}

export async function getSkill(name: string): Promise<Skill | undefined> {
	const user = await getUserSkill(name);
	if (user) return user;
	return (await listBuiltinSkills()).find((s) => s.name === name);
}

/**
 * Build the `<available_skills>` block appended to the system prompt, listing
 * each enabled skill's name and description. Load the full SKILL.md content via
 * the `use_skill` tool when needed.
 */
export function buildAvailableSkillsBlock(skills: Skill[]): string {
	if (skills.length === 0) return "";
	const entries = skills.map((s) => `  <skill name="${escapeXml(s.name)}">${escapeXml(s.description)}</skill>`).join("\n");
	return `\n<available_skills>\n${entries}\n</available_skills>`;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { parseSkillMarkdown };

/** Parse a skill folder's SKILL.md content into a user-installable Skill. */
export function buildUserSkill(content: string, scripts: Record<string, string>): Skill {
	const parsed = parseSkillMarkdown(content);
	const now = Date.now();
	return {
		id: `user:${parsed.name}`,
		name: parsed.name,
		description: parsed.description,
		content,
		scripts,
		source: "user",
		enabled: true,
		createdAt: now,
		updatedAt: now,
	};
}
