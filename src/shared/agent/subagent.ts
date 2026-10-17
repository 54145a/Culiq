import { firstEnabledModel, loadSettings, resolveModelId } from "@shared/config";
import { runAgentLoop } from "./agent-loop";
import type { AgentContext, AgentEventSink, AgentTool } from "./types";

/**
 * Run a self-contained sub-agent and return its final text answer. The sub-agent
 * builds a fresh context from just `task` (no main-conversation history), so it is
 * token-efficient for quick, single-purpose goals. Lives outside background/ so
 * both the native `subtask` tool and the sandbox bridge can use it without
 * dragging tool-registry into an import cycle (tools are passed in).
 * `turnModelId` is the model the main conversation is running with — used when
 * no explicit sub-agent model is configured.
 */
export async function runSubagent(
	task: string,
	tools: AgentTool[],
	systemPrompt: string,
	signal?: AbortSignal,
	maxTurns = 5,
	subtaskId?: string,
	emit?: AgentEventSink,
	turnModelId?: string,
): Promise<string> {
	const settings = await loadSettings();
	const raw = settings.subAgentModel.trim();

	let providerId: string;
	let modelId: string;

	if (raw) {
		const resolved = resolveModelId(raw, settings);
		if (!resolved) {
			throw new Error(`Model "${raw}" not found or disabled. Fix it in Settings → Models.`);
		}
		providerId = resolved.provider.id;
		modelId = resolved.model.name;
	} else {
		const resolved = turnModelId ? resolveModelId(turnModelId, settings) : null;
		if (resolved) {
			providerId = resolved.provider.id;
			modelId = resolved.model.name;
		} else {
			const model = firstEnabledModel(settings);
			const provider = model && settings.providers.find((p) => p.id === model.providerId);
			if (!model || !provider) {
				throw new Error("No enabled model to run the sub-agent with. Enable one in Settings → Models.");
			}
			providerId = provider.id;
			modelId = model.name;
		}
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
