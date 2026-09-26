import type { AgentTool } from "@shared/agent";
import { browserTools } from "@shared/agent/tools/browser";
import { skillTools } from "@shared/agent/tools/skills";
import { sandboxTools } from "@shared/agent/tools/sandbox";
import { noopTool } from "@shared/agent/tools/noop";
import { subtaskTool } from "./subtask";
import { getCustomTools } from "@shared/custom-tools";

const builtinRegistry: AgentTool[] = [noopTool, subtaskTool, ...browserTools, ...skillTools, ...sandboxTools];

export function getTools(): AgentTool[] {
	const taken = new Set(builtinRegistry.map((tool) => tool.name));
	const custom = getCustomTools().filter((tool) => {
		if (taken.has(tool.name)) {
			console.warn(`[culiq] custom tool "${tool.name}" skipped: the name is already in use`);
			return false;
		}
		taken.add(tool.name);
		return true;
	});
	return [...builtinRegistry, ...custom];
}
