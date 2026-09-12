import { loadSettings, resolveDefaultModel, resolveModelId } from "@shared/config";
import { runAgentLoop } from "./agent-loop";
import type { AgentContext, AgentEventSink, AgentTool } from "./types";

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
	subtaskId?: string,
	emit?: AgentEventSink,
): Promise<string> {
	const settings = await loadSettings();
	const raw = settings.subAgentModel.trim();

	let providerId: string;
	let modelId: string;

	if (raw) {
		const resolved = resolveModelId(raw, settings);
		if (!resolved) {
			throw new Error(`Model "${raw}" not found. Add it in Settings → Providers.`);
		}
		providerId = resolved.provider.id;
		modelId = resolved.model.name;
	} else {
		const defaultModel = resolveDefaultModel(settings);
		if (!defaultModel) {
			throw new Error("No sub-agent model configured. Set Sub-agent model in Settings → Providers.");
		}
		providerId = defaultModel.provider.id;
		modelId = defaultModel.model.name;
	}

	const context: AgentContext = {
		systemPrompt,
		messages: [{ role: "user" as const, content: task }],
		tools,
	};

	const wrappedEmit: AgentEventSink | undefined = emit && subtaskId
		? (event) => emit({ ...event, subtaskId })
		: undefined;

	await runAgentLoop(
		context,
		{
			model: { id: modelId, provider: providerId },
			maxTurns,
		},
		wrappedEmit ?? (() => {}),
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
