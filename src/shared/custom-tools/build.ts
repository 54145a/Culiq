import type { AgentTool, AgentToolResult } from "../agent/types";
import { evaluate, type SandboxOutcome } from "../agent/tools/sandbox";
import type { CustomToolMeta } from "./types";

/**
 * Wrap a custom-tool artifact (a single `(sandbox) => ToolDefinition` function
 * expression) as an `AgentTool`. Its execution relays into the sandbox iframe,
 * where the function is evaluated with the live `sandbox` object and its
 * `execute` is invoked with the agent-supplied args.
 */
export function buildCustomToolAgentTool(meta: CustomToolMeta, artifact: string): AgentTool {
	const toResult = (value: string, isError = false): AgentToolResult => ({
		content: [{ type: "text", text: value }],
		isError,
	});

	return {
		name: meta.name,
		description: meta.description,
		parameters: meta.parameters,
		custom: true,
		executionMode: meta.executionMode,
		async execute(args, signal) {
			if (!signal) return toResult("custom tool requires an AbortSignal.", true);
			const code = `const __f = (${artifact});\nconst __d = __f(sandbox);\nreturn await __d.execute(${JSON.stringify(args)});`;
			let outcome: SandboxOutcome;
			try {
				outcome = await evaluate(signal, code);
			} catch (err) {
				return toResult(`error:\n${err instanceof Error ? err.message : String(err)}`, true);
			}
			if (!outcome.ok) return toResult(`error:\n${outcome.error}`, true);
			return toResult(outcome.value);
		},
	};
}
