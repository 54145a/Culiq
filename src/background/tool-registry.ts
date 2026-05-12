import type { AgentTool } from "@shared/agent";
import { browserTools } from "@shared/agent/tools/browser";
import { noopTool } from "@shared/agent/tools/noop";

const registry: AgentTool[] = [noopTool, ...browserTools];

export function getTools(): AgentTool[] {
	return registry;
}
