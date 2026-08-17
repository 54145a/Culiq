import type { AgentTool } from "../../types";
import { domTools } from "./dom";
import { evalJsTool } from "./eval-js";
import { fetchUrlTool } from "./fetch-url";
import { navigateTool } from "./navigate";
import { screenshotTool } from "./screenshot";
import { searchTool } from "./search";
import { tabsTools } from "./tabs";

export { queryTool, clickTool, typeTool, readDomTool } from "./dom";
export { listTabsTool, switchTabTool, reloadTabTool } from "./tabs";

// TODO: a composite `search` wrapper is now implemented — extend SEARCH_ENGINES
// in search.ts as more engines are configured.

export const browserTools: AgentTool[] = [
	navigateTool,
	...domTools,
	screenshotTool,
	evalJsTool,
	...tabsTools,
	fetchUrlTool,
	searchTool,
];
