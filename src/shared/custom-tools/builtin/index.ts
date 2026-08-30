import type { AgentTool } from "../../agent/types";
import { buildCustomToolAgentTool } from "../build";
import * as bingSearch from "./bing_search";
// import * as myOtherTool from "./my_other_tool";

/** Built-in custom tools, shipped with the extension (executed via the sandbox pipeline). */
const builtins = [
	bingSearch,
	// myOtherTool,
];

export function getBuiltinCustomTools(): AgentTool[] {
	return builtins.map((tool) => buildCustomToolAgentTool(tool.meta, tool.artifact));
}
