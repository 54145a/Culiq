/**
 * Parse and evaluate custom tool artifacts.
 *
 * Metadata extraction uses acorn (no eval needed).
 * Module source preparation is for sandbox execution (which has unsafe-eval).
 */

import { parse } from "acorn";

interface ToolMeta {
	name: string;
	toolName: string;
	description: string;
	parameters: Record<string, unknown>;
	executionMode?: "parallel" | "sequential";
	toolIndex: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Extract tool metadata by parsing the module with acorn.
 * No eval needed — safe for CSP-restricted contexts.
 * Returns an array: multiple entries for multi-tool packages, one for single-tool.
 */
export function extractMetaFromArtifact(source: string): ToolMeta[] {
	try {
		const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
		const decl = ast.body.find((n: any) => n.type === "ExportDefaultDeclaration") as any;
		if (!decl || decl.declaration?.type !== "ObjectExpression") return [];

		const obj = decl.declaration;
		const getProp = (name: string) =>
			obj.properties.find(
				(p: any) =>
					p.type === "Property" &&
					!p.computed &&
					((p.key.type === "Identifier" && p.key.name === name) ||
						(p.key.type === "Literal" && p.key.value === name)),
			);

		const nameProp = getProp("name");
		const toolsProp = getProp("tools");

		const getString = (n: any): string =>
			n?.type === "Literal" && typeof n.value === "string" ? n.value : "";

		const packageName = nameProp ? getString(nameProp.value) : "";
		if (!packageName) return [];

		// Multi-tool: export default { name, tools: [...] }
		if (toolsProp?.value?.type === "ArrayExpression") {
			const results: ToolMeta[] = [];
			const seen = new Set<string>();
			for (let i = 0; i < toolsProp.value.elements.length; i++) {
				const el = toolsProp.value.elements[i];
				if (el?.type !== "ObjectExpression") continue;
				const toolName = getString(el.properties.find((p: any) => p.key?.name === "toolName")?.value);
				const description = getString(el.properties.find((p: any) => p.key?.name === "description")?.value);
				const paramsProp = el.properties.find((p: any) => p.key?.name === "parameters");
				const execModeProp = el.properties.find((p: any) => p.key?.name === "executionMode");
				if (!toolName || !description || !paramsProp) continue;
				if (seen.has(toolName)) continue;
				seen.add(toolName);
				const parameters = nodeToObject(paramsProp.value);
				const rawMode = execModeProp ? getString(execModeProp.value) : "";
				const executionMode = rawMode === "parallel" || rawMode === "sequential" ? rawMode : undefined;
				results.push({ name: packageName, toolName, description, parameters, toolIndex: i, ...(executionMode ? { executionMode } : {}) });
			}
			return results;
		}

		// Single-tool: export default { name, description, parameters, execute }
		const descProp = getProp("description");
		const paramsProp = getProp("parameters");
		const execModeProp = getProp("executionMode");
		if (!descProp || !paramsProp) return [];
		const description = getString(descProp.value);
		const parameters = nodeToObject(paramsProp.value);
		const rawMode = execModeProp ? getString(execModeProp.value) : "";
		const executionMode = rawMode === "parallel" || rawMode === "sequential" ? rawMode : undefined;
		if (!description) return [];
		return [{ name: packageName, toolName: packageName, description, parameters, toolIndex: -1, ...(executionMode ? { executionMode } : {}) }];
	} catch {
		return [];
	}
}

/**
 * Prepare module source for sandbox execution.
 * Replaces `export default` with a variable assignment so the
 * entire module (with scope chain) can be eval'd in the sandbox.
 * The sandbox has 'unsafe-eval' in its CSP.
 */
export function prepareModuleSource(source: string): string {
	return source
		.replace(/^([ \t]*)export\s+default\s+/m, "$1const __culiq_default = ")
		.replace(/;\s*$/, "");
}

function nodeToObject(node: any): Record<string, unknown> {
	if (node?.type !== "ObjectExpression") return {};
	const result: Record<string, unknown> = {};
	for (const prop of node.properties ?? []) {
		if (prop.type !== "Property" || prop.computed) continue;
		const key =
			prop.key?.type === "Identifier"
				? prop.key.name
				: prop.key?.type === "Literal" && typeof prop.key.value === "string"
					? prop.key.value
					: null;
		if (key === null) continue;
		result[key] = nodeToValue(prop.value);
	}
	return result;
}

function nodeToValue(node: any): unknown {
	if (!node) return undefined;
	switch (node.type) {
		case "Literal":
			return node.value;
		case "ObjectExpression":
			return nodeToObject(node);
		case "ArrayExpression":
			return (node.elements ?? []).map((el: any) => (el ? nodeToValue(el) : null));
		default:
			return undefined;
	}
}

/* eslint-enable @typescript-eslint/no-explicit-any */
