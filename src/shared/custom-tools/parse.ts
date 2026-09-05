/**
 * Parse and evaluate custom tool artifacts.
 *
 * Metadata extraction uses acorn (no eval needed).
 * Module source preparation is for sandbox execution (which has unsafe-eval).
 */

import { parse } from "acorn";

interface ToolMeta {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	executionMode?: "parallel" | "sequential";
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Extract tool metadata by parsing the module with acorn.
 * No eval needed — safe for CSP-restricted contexts.
 */
export function extractMetaFromArtifact(source: string): ToolMeta | null {
	try {
		const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
		const decl = ast.body.find((n: any) => n.type === "ExportDefaultDeclaration") as any;
		if (!decl || decl.declaration?.type !== "ObjectExpression") return null;

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
		const descProp = getProp("description");
		const paramsProp = getProp("parameters");
		const execModeProp = getProp("executionMode");

		if (!nameProp || !descProp || !paramsProp) return null;

		const getString = (n: any): string =>
			n?.type === "Literal" && typeof n.value === "string" ? n.value : "";

		const name = getString(nameProp.value);
		const description = getString(descProp.value);
		const parameters = nodeToObject(paramsProp.value);
		const rawMode = execModeProp ? getString(execModeProp.value) : "";
		const executionMode = rawMode === "parallel" || rawMode === "sequential" ? rawMode : undefined;

		if (!name || !description) return null;

		return {
			name,
			description,
			parameters,
			...(executionMode ? { executionMode } : {}),
		};
	} catch {
		return null;
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
		.replace(/^export\s+default\s+/m, "const __culiq_default = ")
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
