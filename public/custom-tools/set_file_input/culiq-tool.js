// @ts-check
/** @type {import("@culiq/sandbox").ToolDefinition} */
export default {
	name: "set_file_input",
	description:
		"Set a website's <input type=file> from a file stored in OPFS. Reads the file as a data URL, fetches it inside the page's isolated world, builds a File, assigns it to the input via DataTransfer, and dispatches change. Use this to upload a file you saved to OPFS (writeBytes, or a fetched download) into a site's upload field. Works on native file inputs; for custom upload UIs, target the hidden <input type=file> if one exists.",
	parameters: {
		type: "object",
		properties: {
			selector: { type: "string", description: "CSS selector for the <input type=file> element." },
			path: { type: "string", description: "OPFS path of the file to upload." },
			name: { type: "string", description: "File name to report. Default: basename of path." },
			type: { type: "string", description: "MIME type of the file. Default: application/octet-stream." },
		},
		required: ["selector", "path"],
		additionalProperties: false,
	},
	executionMode: "sequential",
	execute: async (sandbox, input) => {
		const selector = String(input.selector ?? "");
		const path = String(input.path ?? "");
		if (!selector) throw new Error("set_file_input: selector is required");
		if (!path) throw new Error("set_file_input: path is required");
		const name = String(input.name ?? path.split("/").pop() ?? "file");
		const type = String(input.type ?? "application/octet-stream");

		const dataUrl = await sandbox.dataUrl(path, type);
		if (dataUrl == null) throw new Error(`set_file_input: file not found in OPFS: ${path}`);

		const tabs = await sandbox.chrome.tabs.query({ active: true, currentWindow: true });
		const tab = Array.isArray(tabs) ? tabs[0] : null;
		if (!tab || typeof tab.id !== "number") throw new Error("set_file_input: no active tab");

		const code = [
			`const resp = await fetch(${JSON.stringify(dataUrl)});`,
			`const blob = await resp.blob();`,
			`const file = new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });`,
			`const el = document.querySelector(${JSON.stringify(selector)});`,
			`if (!el) throw new Error("set_file_input: no element for selector " + ${JSON.stringify(selector)});`,
			`const dt = new DataTransfer();`,
			`dt.items.add(file);`,
			`el.files = dt.files;`,
			`el.dispatchEvent(new Event("change", { bubbles: true }));`,
			`return "set " + ${JSON.stringify(selector)} + " -> " + file.name + " (" + file.size + " bytes)";`,
		].join("\n");
		return await sandbox.evalInTab({ tabId: tab.id, code });
	},
};
