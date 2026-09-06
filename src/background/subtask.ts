import { getSystemPrompt } from "@shared/agent/system-prompt";
import { runSubagent } from "@shared/agent/subagent";
import type { AgentTool } from "@shared/agent/types";
import { getTools } from "./tool-registry";

export const subtaskTool: AgentTool = {
	name: "subtask",
	description:
		"Delegate a simple, well-defined task (e.g. 'find the submit button', 'summarize the page', 'extract all links') to a small sub-agent that runs autonomously using the same browser tools. The sub-agent has up to `maxTurns` turns and returns its final answer. Use for single-purpose tasks where one model roundtrip would suffice but the sub-agent handles multi-step tool usage internally.",
	parameters: {
		type: "object",
		properties: {
			task: {
				type: "string",
				description:
					"A self-contained instruction for the sub-agent. Should be specific and include any relevant context (e.g. 'read the page and list all form elements', 'click the login button and report what happens').",
			},
			maxTurns: {
				type: "number",
				description: "Maximum tool-calling turns the sub-agent may execute. Default 5.",
			},
		},
		required: ["task"],
		additionalProperties: false,
	},
	executionMode: "sequential",
	async execute(args, signal) {
		const task = String(args.task);
		const maxTurns = typeof args.maxTurns === "number" ? Math.max(1, Math.floor(args.maxTurns)) : 5;
		const tools = getTools().filter(
			(tool) => !tool.custom && tool.name !== "subtask" && tool.name !== "sandbox_exec",
		);
		const text = await runSubagent(task, tools, getSystemPrompt({ tools }), signal, maxTurns);
		return { content: [{ type: "text", text }] };
	},
};
