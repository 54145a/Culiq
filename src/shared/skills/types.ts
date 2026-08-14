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
