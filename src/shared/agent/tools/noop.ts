import type { AgentTool } from "../types";

export const noopTool: AgentTool = {
	name: "noop",
	description:
		"Echoes the provided message back. Use this to test that tool calling works end to end. Returns the same text wrapped with an Echo: prefix.",
	parameters: {
		type: "object",
		properties: {
			message: {
				type: "string",
				description: "Text to echo back.",
			},
		},
		required: ["message"],
		additionalProperties: false,
	},
	async execute(args) {
		const message = typeof args.message === "string" ? args.message : JSON.stringify(args.message);
		return {
			content: [{ type: "text", text: `Echo: ${message}` }],
		};
	},
};
