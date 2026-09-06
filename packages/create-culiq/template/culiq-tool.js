// @ts-check
/** @type {import("@culiq/sandbox").ToolDefinition} */
export default {
	name: "my_tool",
	description: "Echo back the input text.",
	parameters: {
		type: "object",
		properties: {
			input: { type: "string", description: "Input text." },
		},
		required: ["input"],
		additionalProperties: false,
	},
	execute: async (_sandbox, input) => {
		const text = String(input.input ?? "");
		return `echo: ${text}`;
	},
};
