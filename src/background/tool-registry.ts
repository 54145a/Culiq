import type { AgentTool } from "@shared/agent";
import { browserTools } from "@shared/agent/tools/browser";
import { skillTools } from "@shared/agent/tools/skills";
import { sandboxTools } from "@shared/agent/tools/sandbox";
import { noopTool } from "@shared/agent/tools/noop";
import { subtaskTool } from "./subtask";
import { getCustomTools } from "@shared/custom-tools";

const builtinRegistry: AgentTool[] = [noopTool, subtaskTool, ...browserTools, ...skillTools, ...sandboxTools];

export function getTools(): AgentTool[] {
	return [...builtinRegistry, ...getCustomTools()];
}
