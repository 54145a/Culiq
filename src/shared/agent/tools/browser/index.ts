import type { AgentTool } from "../../types";
import { domTools } from "./dom";
import { evalJsTool } from "./eval-js";
import { fetchUrlTool } from "./fetch-url";
import { navigateTool } from "./navigate";
import { screenshotTool } from "./screenshot";
import { tabsTools } from "./tabs";

export { queryTool, clickTool, typeTool, readDomTool } from "./dom";
export { listTabsTool, switchTabTool, reloadTabTool } from "./tabs";

export const browserTools: AgentTool[] = [
	navigateTool,
	...domTools,
	screenshotTool,
	evalJsTool,
	...tabsTools,
	fetchUrlTool,
];
