import { sliceByTokens } from "tokenx";
import { getSkill, listSkills } from "@shared/skills";
import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "../../types";

const INDEX_TOKEN_CAP = 8000;
const DEFAULT_FILE_MAX_CHARS = 8_000;

export const useSkillTool: AgentTool = {
	name: "use_skill",
	description: CAPABILITY_INFO.use_skill.description,
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "Skill name to access." },
			file: {
				type: "string",
				description: "Optional file within the skill (e.g. 'SKILL.md' or 'scripts/hook.js'). Omit to get the skill index.",
			},
			maxChars: {
				type: "number",
				description: `Truncate file content to this many chars. Default ${DEFAULT_FILE_MAX_CHARS}.`,
			},
		},
		required: ["name"],
		additionalProperties: false,
	},
	async execute(args) {
		const name = String(args.name);
		const skill = await getSkill(name);
		if (!skill) {
			const names = (await listSkills()).map((s) => s.name).join(", ");
			return {
				content: [
					{
						type: "text",
						text: `Skill not found: ${name}${names ? `\nAvailable skills: ${names}` : "\nNo skills installed."}`,
					},
				],
				isError: true,
			};
		}

		const maxChars = typeof args.maxChars === "number" ? Math.max(100, Math.floor(args.maxChars)) : DEFAULT_FILE_MAX_CHARS;
		const file = args.file !== undefined ? String(args.file) : undefined;

		if (file !== undefined) {
			const source = file === "SKILL.md" ? skill.content : skill.scripts[file];
			if (source === undefined) {
				const files = ["SKILL.md", ...Object.keys(skill.scripts)].join(", ");
				return {
					content: [{ type: "text", text: `File not found: ${skill.name}/${file}\nFiles: ${files}` }],
					isError: true,
				};
			}
			let text = source;
			const truncated = text.length > maxChars;
			if (truncated) text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} more chars]`;
			return {
				content: [{ type: "text", text: `# ${skill.name}/${file} (${source.length} chars${truncated ? ", truncated" : ""})\n\n${text}` }],
			};
		}

		const body = sliceByTokens(skill.content, 0, INDEX_TOKEN_CAP);
		const bodyTruncated = body.length < skill.content.length;
		const files = ["SKILL.md", ...Object.keys(skill.scripts)];
		const listing = files
			.map((f) => {
				const size = f === "SKILL.md" ? skill.content.length : (skill.scripts[f] ?? "").length;
				return `- ${f} (${size} chars)`;
			})
			.join("\n");

		return {
			content: [
				{
					type: "text",
					text:
						`# Skill: ${skill.name}\n${skill.description}\n\n${body}` +
						(bodyTruncated ? "\n\n[SKILL.md truncated; read it fully with file=\"SKILL.md\"]" : "") +
						`\n\nFiles:\n${listing}\n\nRead any file with file="<name>".`,
				},
			],
		};
	},
};
