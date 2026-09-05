import type { AgentTool, AgentToolResult } from "../agent/types";
import { evaluate, type SandboxOutcome } from "../agent/tools/sandbox";
import type { CustomToolMeta } from "./types";
import { prepareModuleSource } from "./parse";

/**
 * Wrap a custom-tool artifact (a default-exported module with
 * `execute(sandbox, input)`) as an `AgentTool`. The full module source
 * is sent to the sandbox, preserving the scope chain (outer variables,
 * helper functions, etc.).
 */
export function buildCustomToolAgentTool(meta: CustomToolMeta, artifact: string): AgentTool {
	const toResult = (value: string, isError = false): AgentToolResult => ({
		content: [{ type: "text", text: value }],
		isError,
	});

	// Prepare module source: replace `export default` with variable assignment.
	// The full source (including outer scope) is sent to the sandbox.
	const moduleSource = prepareModuleSource(artifact);

	return {
		name: meta.name,
		description: meta.description,
		parameters: meta.parameters,
		custom: true,
		executionMode: meta.executionMode,
		async execute(args, signal) {
			if (!signal) return toResult("custom tool requires an AbortSignal.", true);
			const code = `${moduleSource}\nreturn await __culiq_default.execute(sandbox, ${JSON.stringify(args)});`;
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
