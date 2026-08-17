import type { AgentTool } from "../../types";
import { domTools } from "./dom";
import { evalJsTool } from "./eval-js";
import { fetchUrlTool } from "./fetch-url";
import { navigateTool } from "./navigate";
import { screenshotTool } from "./screenshot";
import { tabsTools } from "./tabs";

export { queryTool, clickTool, typeTool, readDomTool } from "./dom";
export { listTabsTool, switchTabTool, reloadTabTool } from "./tabs";

// TODO: add a `search` tool — a composite wrapper chaining existing tools (like
// fetchUrlTool): open a search-engine results URL in a foreground tab, read_dom
// the results, and close the tab. Keep it a thin orchestration of current tools.
export const browserTools: AgentTool[] = [
	navigateTool,
	...domTools,
	screenshotTool,
	evalJsTool,
	...tabsTools,
	fetchUrlTool,
];
