import type { AgentTool } from "../../types";
import { domTools } from "./dom";
import { evalJsTool } from "./eval-js";
import { fetchUrlTool } from "./fetch-url";
import { screenshotTool } from "./screenshot";
import { tabsTools } from "./tabs";

export { clickTool, typeTool, readDomTool } from "./dom";

export const browserTools: AgentTool[] = [
	...domTools,
	screenshotTool,
	evalJsTool,
	...tabsTools,
	fetchUrlTool,
];
