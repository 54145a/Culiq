import type { AgentTool, AgentToolResult } from "../agent/types";
import { evaluate, type SandboxOutcome } from "../agent/tools/sandbox";
import type { CustomToolMeta } from "./types";
import { prepareModuleSource } from "./parse";

/**
 * Wrap a custom-tool artifact as an `AgentTool`. The full module source
 * is sent to the sandbox, preserving the scope chain.
 * For multi-tool packages (toolIndex >= 0), calls `tools[i].execute(...)`.
 * For single-tool packages (toolIndex < 0), calls `execute(...)` directly.
 */
export function buildCustomToolAgentTool(meta: CustomToolMeta, artifact: string): AgentTool {
	const toResult = (value: string, isError = false): AgentToolResult => ({
		content: [{ type: "text", text: value }],
		isError,
	});

	const moduleSource = prepareModuleSource(artifact);
	const execCall = meta.toolIndex >= 0
		? `__culiq_default.tools[${meta.toolIndex}].execute`
		: `__culiq_default.execute`;

	return {
		name: meta.toolName,
		description: meta.description,
		parameters: meta.parameters,
		custom: true,
		executionMode: meta.executionMode,
		async execute(args, signal) {
			if (!signal) return toResult("custom tool requires an AbortSignal.", true);
			const code = `${moduleSource}\nreturn await ${execCall}(sandbox, ${JSON.stringify(args)});`;
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
