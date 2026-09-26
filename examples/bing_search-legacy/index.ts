import type { CustomToolMeta } from "../../types";
import rawArtifact from "./tool.js?raw";
import rawMeta from "./tool.json";

export const artifact: string = rawArtifact;
export const meta: CustomToolMeta = { ...(rawMeta as Omit<CustomToolMeta, "source">), source: "builtin" };
