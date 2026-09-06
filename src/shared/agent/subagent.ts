import { loadSettings } from "@shared/config";
import { runAgentLoop } from "./agent-loop";
import type { AgentContext, AgentTool } from "./types";

/**
 * Run a self-contained sub-agent and return its final text answer. The sub-agent
 * builds a fresh context from just `task` (no main-conversation history), so it is
 * token-efficient for quick, single-purpose goals. Lives outside background/ so
 * both the native `subtask` tool and the sandbox bridge can use it without
 * dragging tool-registry into an import cycle (tools are passed in).
 */
export async function runSubagent(
	task: string,
	tools: AgentTool[],
	systemPrompt: string,
	signal?: AbortSignal,
	maxTurns = 5,
): Promise<string> {
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
			throw new Error(`Model "${raw}" not found in any provider's Available models. Add it in Settings → Providers.`);
		}
		providerId = candidate.id;
		modelId = raw;
	} else {
		// Empty — fall back to default provider's default model
		providerId = defaultProvider?.id ?? "";
		modelId = defaultProvider?.defaultModel ?? "";
	}

	if (!providerId || !modelId) {
		throw new Error("No sub-agent model configured. Set Sub-agent model in Settings → Providers.");
	}

	const context: AgentContext = {
		systemPrompt,
		messages: [{ role: "user" as const, content: task }],
		tools,
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
	return (
		lastMsg?.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") ?? "(sub-agent produced no text output)"
	);
}
