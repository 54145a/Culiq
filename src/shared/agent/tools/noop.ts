import { CAPABILITY_INFO } from "@shared/config";
import type { AgentTool } from "../types";

export const noopTool: AgentTool = {
	name: "noop",
	description: CAPABILITY_INFO.noop.description,
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
