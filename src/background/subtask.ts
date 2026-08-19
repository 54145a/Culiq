import { loadSettings } from "@shared/config";
import { getSystemPrompt } from "@shared/agent/system-prompt";
import { runAgentLoop } from "@shared/agent";
import type { AgentContext, AgentTool } from "@shared/agent/types";
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

		const settings = await loadSettings();
		const defaultProvider = settings.providers.find((p) => p.id === settings.defaultProviderId);
		const raw = settings.subAgentModel.trim();

		let providerId: string;
		let modelId: string;

		if (raw.includes(":")) {
			// Explicit "provider:model" format
			[providerId, modelId] = raw.split(":", 2);
		} else if (raw) {
			// Bare model name — search all providers; prefer default if it has the model
			const candidate = defaultProvider?.models.includes(raw) ? defaultProvider : settings.providers.find((p) => p.models.includes(raw));
			if (!candidate) {
				return { content: [{ type: "text", text: `Model "${raw}" not found in any provider's Available models. Add it in Settings → Providers.` }], isError: true };
			}
			providerId = candidate.id;
			modelId = raw;
		} else {
			// Empty — fall back to default provider's default model
			providerId = defaultProvider?.id ?? "";
			modelId = defaultProvider?.defaultModel ?? "";
		}

		if (!providerId || !modelId) {
			return { content: [{ type: "text", text: "No sub-agent model configured. Set Sub-agent model in Settings → Providers." }], isError: true };
		}

		const context: AgentContext = {
			systemPrompt: getSystemPrompt(),
			messages: [{ role: "user" as const, content: task }],
			tools: getTools(),
		};

		await runAgentLoop(
			context,
			{
				model: { id: modelId, provider: providerId },
				maxTurns,
			},
			() => {},
			signal,
		);

		const assistantMsgs = context.messages.filter((m) => m.role === "assistant");
		const lastMsg = assistantMsgs[assistantMsgs.length - 1];
		const text =
			lastMsg?.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n") ?? "(sub-agent produced no text output)";

		return { content: [{ type: "text", text }] };
	},
};
