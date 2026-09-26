import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
	CAPABILITY_INFO,
	loadSettings,
	PROVIDER_DEFAULTS,
	REASONING_LEVELS,
	type CuliqSettings,
	type ProviderConfig,
	saveSettings,
} from "@shared/config";
import { buildUserSkill, deleteUserSkill, listSkills, saveUserSkill, setSkillEnabled, type Skill } from "@shared/skills";
import {
	loadMcpServers,
	saveMcpServers,
	testMcpConnection,
	type McpServerConfig,
	type McpTransport,
} from "@shared/mcp";
import { listUserCustomTools, saveCustomToolPackage, deleteUserCustomTool, extractMetaFromArtifact } from "@shared/custom-tools/storage";
import { syncBuiltinTools } from "@shared/custom-tools";
import type { CustomToolMeta } from "@shared/custom-tools";

function Field({
	label,
	type,
	value,
	placeholder,
	onInput,
}: {
	label: string;
	type: "text" | "password" | "number";
	value: string;
	placeholder?: string;
	onInput: (value: string) => void;
}) {
	return (
		<label>
			<span>{label}</span>
			<input
				type={type}
				value={value}
				placeholder={placeholder}
				onInput={(e) => onInput((e.target as HTMLInputElement).value)}
				onClick={(e) => e.stopPropagation()}
			/>
		</label>
	);
}

// A checkbox row with a <code> name and an optional ": " description. Used for
// every capability / skill / MCP-server list so the code + text spacing and the
// markup stay consistent (DRY). Extra controls (buttons) go in `children`.
function CheckRow({
	code,
	checked,
	onToggle,
	disabled,
	desc,
	children,
}: {
	code: string;
	checked: boolean;
	onToggle?: (v: boolean) => void;
	disabled?: boolean;
	desc?: string;
	children?: ComponentChildren;
}) {
	return (
		<label className="capability">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onToggle?.((e.target as HTMLInputElement).checked)}
			/>
			<code>{code}</code>
			{desc && <span className="capability-desc">: {desc}</span>}
			{children}
		</label>
	);
}

function ProviderCard({
	provider,
	remove,
	dirty,
}: {
	provider: ProviderConfig;
	remove: () => void;
	dirty: () => void;
}) {
	const def = PROVIDER_DEFAULTS.find((d) => d.id === provider.id);

	return (
		<div className="provider-card">
			<header>
				<h3>{provider.name || provider.id}</h3>
			</header>
			<Field label="Name" type="text" value={provider.name} placeholder={provider.id} onInput={(v) => { provider.name = v; dirty(); }} />
			<label>
				<span>Type</span>
				<select
					value={provider.type}
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => { provider.type = (e.target as HTMLSelectElement).value as "openai" | "anthropic"; dirty(); }}
				>
					<option value="openai">OpenAI-compatible</option>
					<option value="anthropic">Anthropic</option>
				</select>
			</label>
			<Field label="API key" type="password" value={provider.apiKey} placeholder="sk-..." onInput={(v) => { provider.apiKey = v; dirty(); }} />
			<Field label="Base URL" type="text" value={provider.baseUrl} placeholder={def?.baseUrl ?? ""} onInput={(v) => { provider.baseUrl = v; dirty(); }} />
			<button type="button" className="provider-delete" onClick={(e) => { e.stopPropagation(); remove(); }}>Delete</button>
		</div>
	);
}

function ProvidersGroup({ settings, dirty }: { settings: CuliqSettings; dirty: () => void }) {
	const removeProvider = (id: string) => {
		settings.providers = settings.providers.filter((p) => p.id !== id);
		settings.models = settings.models.filter((m) => m.providerId !== id);
		if (settings.models.length > 0 && !settings.models.find((m) => m.id === settings.defaultModelId)) {
			settings.defaultModelId = settings.models[0].id;
		}
		dirty();
	};
	const addProvider = () => {
		const id = `provider-${Date.now()}`;
		settings.providers.push({ id, name: id, type: "openai", apiKey: "", baseUrl: "" });
		dirty();
	};

	return (
		<details className="settings-group" open>
			<summary className="settings-header">Providers</summary>
			<p className="settings-hint">
				Configure API credentials. Each provider holds a name, type, key, and base URL.
			</p>
			<div className="capability-list">
				{settings.providers.map((p) => (
					<ProviderCard key={p.id} provider={p} remove={() => removeProvider(p.id)} dirty={dirty} />
				))}
			</div>
			<div className="settings-actions">
				<button type="button" onClick={addProvider}>Add provider</button>
			</div>
		</details>
	);
}

function ModelsGroup({ settings, dirty }: { settings: CuliqSettings; dirty: () => void }) {
	const [newModelName, setNewModelName] = useState("");
	const [newModelProvider, setNewModelProvider] = useState(settings.providers[0]?.id ?? "");

	const onAdd = () => {
		const name = newModelName.trim();
		if (!name || !newModelProvider) return;
		const id = `${newModelProvider}:${name}`;
		if (settings.models.some((m) => m.id === id)) return;
		settings.models.push({ id, providerId: newModelProvider, name });
		if (!settings.defaultModelId) settings.defaultModelId = id;
		setNewModelName("");
		dirty();
	};

	const onDelete = (id: string) => {
		settings.models = settings.models.filter((m) => m.id !== id);
		if (settings.defaultModelId === id && settings.models.length > 0) {
			settings.defaultModelId = settings.models[0].id;
		}
		dirty();
	};

	return (
		<details className="settings-group">
			<summary className="settings-header">Models</summary>
			<p className="settings-hint">
				All available models across providers. Toggle screenshot capability per model
				(useful for text-only models). Set the context window size for context compression.
			</p>
			<label className="settings-default-model">
				<span>Default model</span>
				<select
					value={settings.defaultModelId}
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => { settings.defaultModelId = (e.target as HTMLSelectElement).value; dirty(); }}
				>
					{settings.models.map((m) => (
						<option key={m.id} value={m.id}>{m.name} ({settings.providers.find((p) => p.id === m.providerId)?.name ?? m.providerId})</option>
					))}
				</select>
			</label>
			<div className="capability-list">
				{settings.models.map((m) => {
					const capKey = m.id;
					const disabled = settings.modelCapabilities[capKey]?.disabledCapabilities ?? [];
					const screenshotOn = !disabled.includes("screenshot");
					const setScreenshot = (on: boolean) => {
						const entry = settings.modelCapabilities[capKey] ?? { disabledCapabilities: [] };
						entry.disabledCapabilities = on
							? entry.disabledCapabilities.filter((c) => c !== "screenshot")
							: entry.disabledCapabilities.includes("screenshot")
								? entry.disabledCapabilities
								: [...entry.disabledCapabilities, "screenshot"];
						if (entry.disabledCapabilities.length === 0) delete settings.modelCapabilities[capKey];
						else settings.modelCapabilities[capKey] = entry;
						dirty();
					};
					return (
						<div className="model-row" key={m.id}>
							<div className="model-row-header">
								<code>{m.name}</code>
								<span className="capability-desc">{settings.providers.find((p) => p.id === m.providerId)?.name ?? m.providerId}</span>
								{settings.defaultModelId === m.id && <span className="active-badge">default</span>}
								<button
									type="button"
									className="skill-delete"
									title="Delete model"
									onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(m.id); }}
								>
									delete
								</button>
							</div>
							<div className="model-row-controls">
								<CheckRow
									code="screenshot"
									checked={screenshotOn}
									onToggle={setScreenshot}
									desc={CAPABILITY_INFO.screenshot.description}
								/>
								<Field
									label="Context window"
									type="number"
									value={String(m.contextWindow ?? "")}
									placeholder="Default: 64000"
									onInput={(v) => { m.contextWindow = v ? Number(v) : undefined; dirty(); }}
								/>
								<label>
									<span>Thinking</span>
									<select
										value={m.reasoning ?? ""}
										onClick={(e) => e.stopPropagation()}
										onChange={(e) => { m.reasoning = (e.target as HTMLSelectElement).value as any || undefined; dirty(); }}
									>
										{REASONING_LEVELS.map((l) => (
											<option key={l.value} value={l.value}>{l.label}</option>
										))}
									</select>
								</label>
							</div>
						</div>
					);
				})}
			</div>
			<div className="settings-actions add-model-row">
				<div className="add-model-fields">
					<label>
						<span>Add model</span>
						<input
							type="text"
							value={newModelName}
							placeholder="model-name"
							onInput={(e) => setNewModelName((e.target as HTMLInputElement).value)}
							onClick={(e) => e.stopPropagation()}
						/>
					</label>
					<label>
						<span>Provider</span>
						<select
							value={newModelProvider}
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => setNewModelProvider((e.target as HTMLSelectElement).value)}
						>
							{settings.providers.map((p) => (
								<option key={p.id} value={p.id}>{p.name || p.id}</option>
							))}
						</select>
					</label>
				</div>
				<button type="button" onClick={onAdd}>Add model</button>
			</div>
		</details>
	);
}

function ContextGroup({ settings, dirty }: { settings: CuliqSettings; dirty: () => void }) {
	const cm = settings.contextManagement;

	return (
		<details className="settings-group">
			<summary className="settings-header">Context management</summary>
			<p className="settings-hint">
				Summarize old turns when the conversation nears the model's context window. The context window size is set per-model in the Models section.
			</p>
			<CheckRow
				code="Auto-compress context"
				checked={cm.enabled}
				onToggle={(v) => {
					cm.enabled = v;
					dirty();
				}}
			/>
			<Field
				label="Trigger at (% of context window)"
				type="number"
				value={String(Math.round(cm.thresholdRatio * 100))}
				onInput={(v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n > 0) cm.thresholdRatio = Math.min(n / 100, 1);
					dirty();
				}}
			/>
			<Field
				label="Keep recent turns verbatim"
				type="number"
				value={String(cm.keepTurns)}
				onInput={(v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 1) cm.keepTurns = Math.floor(n);
					dirty();
				}}
			/>
		</details>
	);
}

function SkillsGroup() {
	const [skills, setSkills] = useState<Skill[] | null>(null);
	const [status, setStatus] = useState<{ state: "ok" | "err"; text: string } | null>(null);

	const refresh = async () => {
		try {
			setSkills(await listSkills());
		} catch (err) {
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const onImport = async () => {
		const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
		if (!picker) {
			setStatus({ state: "err", text: "Directory picker is not supported in this browser." });
			return;
		}
		try {
			const dir = await picker();
			let skillMd: File | undefined;
			const scripts: Record<string, string> = {};
			const entries = (dir as unknown as { values: () => AsyncIterableIterator<{ kind: string; name: string; getFile: () => Promise<File> }> }).values();
			for await (const entry of entries) {
				if (entry.kind !== "file") continue;
				if (entry.name === "SKILL.md") {
					skillMd = await entry.getFile();
				} else if (!entry.name.startsWith(".")) {
					const file = await entry.getFile();
					scripts[entry.name] = await file.text();
				}
			}
			if (!skillMd) throw new Error("The selected folder has no SKILL.md.");
			const skill = buildUserSkill(await skillMd.text(), scripts);
			await saveUserSkill(skill);
			setStatus({ state: "ok", text: `imported ${skill.name}` });
			await refresh();
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
		}
	};

	const onClawhub = async () => {
		if (!chrome.downloads?.download) {
			setStatus({ state: "err", text: "Downloads API is not available." });
			return;
		}
		let tabUrl: string | undefined;
		try {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			tabUrl = tab?.url;
		} catch (err) {
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
			return;
		}
		if (!tabUrl) {
			setStatus({ state: "err", text: "Could not read the active tab URL." });
			return;
		}
		const slug = parseClawHubSlug(tabUrl);
		if (!slug) {
			setStatus({ state: "err", text: "Not a ClawHub skill page (expected clawhub.ai/<owner>/skills/<slug>)." });
			return;
		}
		try {
			const downloadId = await chrome.downloads.download({
				url: `https://clawhub.ai/api/v1/download?slug=${encodeURIComponent(slug)}`,
				filename: `${slug}.zip`,
				conflictAction: "uniquify",
			});
			setStatus({ state: "ok", text: `downloading ${slug}.zip (#${downloadId})` });
		} catch (err) {
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
		}
	};

	const onToggle = async (name: string, enabled: boolean) => {
		await setSkillEnabled(name, enabled);
		await refresh();
	};

	const onDelete = async (name: string) => {
		await deleteUserSkill(name);
		await refresh();
	};

	return (
		<details className="settings-group">
			<summary className="settings-header">Skills</summary>
			<p className="settings-hint">
				Skills bundle reusable instructions and optional script files (AgentSkills format: a folder with SKILL.md whose
				frontmatter has `name` and `description`). Scripts may be in any language and are imported for reference only — they
				are not executed. Import a folder, or download a skill's zip from a ClawHub skill page (then unzip and import it).
				Treat third-party skills as untrusted code.
			</p>
			<p className="settings-note">
				Skills are reference-only. For executable, typed, distributable capabilities, use <strong>Custom tools</strong> (built
				with <code>@culiq/sandbox</code>, installed from npm or a folder) — see the Custom tools section above.
			</p>
			<div className="settings-actions">
				<span className="status" data-state={status?.state}>
					{status?.text ?? ""}
				</span>
				<button type="button" onClick={() => void onImport()}>
					Import skill folder…
				</button>
				<button
					type="button"
					title="If the active tab is a ClawHub skill page (clawhub.ai/<owner>/skills/<slug>), download the skill's zip archive."
					onClick={() => void onClawhub()}
				>
					Download skill from current tab
				</button>
			</div>
			<div className="capability-list">
				{skills === null ? null : skills.length === 0 ? (
					<p>No skills installed yet.</p>
				) : (
					skills.map((skill) => (
						<CheckRow
							key={skill.name}
							code={skill.name}
							checked={skill.enabled}
							disabled={skill.source === "builtin"}
							onToggle={(v) => void onToggle(skill.name, v)}
						>
							<span className="capability-desc">: {skill.source === "builtin" ? "builtin" : "user"}</span>
							<span className="capability-desc"> {skill.description}</span>
							{skill.source === "user" && (
								<button
									type="button"
									className="skill-delete"
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										void onDelete(skill.name);
									}}
								>
									delete
								</button>
							)}
						</CheckRow>
					))
				)}
			</div>
		</details>
	);
}

/** Parse the skill slug from a ClawHub skill page URL (`clawhub.ai/<owner>/skills/<slug>`). */
function parseClawHubSlug(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!/^clawhub\.ai$/i.test(parsed.hostname)) return null;
	const match = /\/skills\/([^/?#]+)\/?$/.exec(parsed.pathname);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

function McpServersGroup() {
	const [servers, setServers] = useState<McpServerConfig[] | null>(null);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [transport, setTransport] = useState<McpTransport>("http");
	const [status, setStatus] = useState<{ state: "ok" | "err"; text: string } | null>(null);

	const refresh = async () => {
		try {
			setServers(await loadMcpServers());
		} catch (err) {
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const persist = async (next: McpServerConfig[]) => {
		await saveMcpServers(next);
		setServers(next);
	};

	const onAdd = async () => {
		const trimmedName = name.trim();
		const trimmedUrl = url.trim();
		if (!trimmedName || !trimmedUrl) {
			setStatus({ state: "err", text: "Enter a name and URL." });
			return;
		}
		if (servers?.some((s) => s.name === trimmedName)) {
			setStatus({ state: "err", text: `A server named "${trimmedName}" already exists.` });
			return;
		}
		await persist([...(servers ?? []), { name: trimmedName, url: trimmedUrl, enabled: false, transport }]);
		setName("");
		setUrl("");
		setStatus({ state: "ok", text: `added ${trimmedName}` });
	};

	const onToggle = async (server: McpServerConfig, enabled: boolean) => {
		if (!servers) return;
		await persist(servers.map((s) => (s.name === server.name ? { ...s, enabled } : s)));
	};

	const onDelete = async (server: McpServerConfig) => {
		if (!servers) return;
		await persist(servers.filter((s) => s.name !== server.name));
	};

	const onTest = async (server: McpServerConfig) => {
		setStatus({ state: "ok", text: `testing ${server.name}…` });
		const result = await testMcpConnection(server.url, server.transport);
		if (result.ok) {
			setStatus({ state: "ok", text: `${server.name}: connected (${result.serverName}), ${result.toolCount} tools` });
		} else {
			setStatus({ state: "err", text: `${server.name}: ${result.error}` });
		}
	};

	return (
		<details className="settings-group">
			<summary className="settings-header">MCP servers</summary>
			<p className="settings-hint">
				Connect to Model Context Protocol servers. Their tools are exposed to the agent as <code>server-tool</code> and toggle
				per server. Streamable HTTP is the modern transport; SSE is legacy. The URL must include the server's endpoint path
				(e.g. <code>…/mcp</code> for streamable HTTP, <code>…/sse</code> for SSE) — a bare hostname won't work. Treat MCP
				servers as untrusted third-party code with external side effects; only enable servers you trust.
			</p>
			<div className="settings-actions">
				<span className="status" data-state={status?.state}>
					{status?.text ?? ""}
				</span>
			</div>
			<Field label="Name" type="text" value={name} placeholder="github" onInput={setName} />
			<Field label="URL" type="text" value={url} placeholder="https://localhost:3001/mcp" onInput={setUrl} />
			<label>
				<span>Transport</span>
				<select
					value={transport}
					onChange={(e) => setTransport((e.target as HTMLSelectElement).value as McpTransport)}
					onClick={(e) => e.stopPropagation()}
				>
					<option value="http">Streamable HTTP</option>
					<option value="sse">SSE (legacy)</option>
				</select>
			</label>
			<div className="settings-actions">
				<button type="button" onClick={() => void onAdd()}>
					Add server
				</button>
			</div>
			<div className="capability-list">
				{servers === null ? null : servers.length === 0 ? (
					<p>No MCP servers configured yet.</p>
				) : (
					servers.map((server) => (
						<CheckRow
							key={server.name}
							code={server.name}
							checked={server.enabled}
							onToggle={(v) => void onToggle(server, v)}
						>
							<span className="capability-desc">: {server.transport}</span>
							<span className="capability-desc"> {server.url}</span>
							<button
								type="button"
								className="skill-delete"
								title="Test connection"
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									void onTest(server);
								}}
							>
								test
							</button>
							<button
								type="button"
								className="skill-delete"
								title="Delete server"
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									void onDelete(server);
								}}
							>
								delete
							</button>
						</CheckRow>
					))
				)}
			</div>
		</details>
	);
}

function LocalToolsGroup({ settings, dirty }: { settings: CuliqSettings; dirty: () => void }) {
	const [tools, setTools] = useState<CustomToolMeta[] | null>(null);
	const [status, setStatus] = useState<{ state: "ok" | "err"; text: string } | null>(null);

	const refresh = async () => {
		try {
			await syncBuiltinTools();
			setTools(await listUserCustomTools());
		} catch (err) {
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const onNpmPage = async () => {
		try {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			const url = tab?.url;
			if (!url) throw new Error("No active tab URL.");
			const m = /npmjs\.com\/package\/([^/?#]+)(?:\/v\/([^/?#]+))?/.exec(url);
			if (!m) throw new Error("Open an npm package page (npmjs.com/package/<name>) first.");
			const pkg = decodeURIComponent(m[1]);
			const version = m[2] ? `@${m[2]}` : "";
			const base = `https://cdn.jsdelivr.net/npm/${pkg}${version}`;
			const sres = await fetch(`${base}/culiq-tool.js`);
			if (!sres.ok) throw new Error(`culiq-tool.js not found in ${pkg} (is this a Culiq tool package?)`);
			const artifact = await sres.text();
			const metas = extractMetaFromArtifact(artifact);
			if (metas.length === 0) throw new Error(`Failed to extract metadata from ${pkg}/culiq-tool.js`);
			const pkgName = metas[0].name;
			const tools = metas.map((m) => ({
				toolName: m.toolName,
				description: m.description,
				parameters: m.parameters,
				toolIndex: m.toolIndex,
				...(m.executionMode ? { executionMode: m.executionMode } : {}),
			}));
			await saveCustomToolPackage(pkgName, artifact, tools);
			chrome.runtime.sendMessage({ type: "reload_custom_tools" }).catch(() => {});
			const count = metas.length;
			setStatus({ state: "ok", text: `imported ${pkgName} (${count} tool${count > 1 ? "s" : ""})` });
			await refresh();
		} catch (err) {
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
		}
	};

	const onImport = async () => {
		const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
		if (!picker) {
			setStatus({ state: "err", text: "Directory picker is not supported in this browser." });
			return;
		}
		try {
			const dir = await picker();
			let js: string | undefined;
			const entries = (dir as unknown as { values: () => AsyncIterableIterator<{ kind: string; name: string; getFile: () => Promise<File> }> }).values();
			for await (const entry of entries) {
				if (entry.kind === "file" && entry.name === "culiq-tool.js") {
					js = await (await entry.getFile()).text();
					break;
				}
			}
			if (!js) throw new Error("Folder must contain culiq-tool.js.");
			const metas = extractMetaFromArtifact(js);
			if (metas.length === 0) throw new Error("Failed to extract metadata from culiq-tool.js.");
			const pkgName = metas[0].name;
			const tools = metas.map((m) => ({
				toolName: m.toolName,
				description: m.description,
				parameters: m.parameters,
				toolIndex: m.toolIndex,
				...(m.executionMode ? { executionMode: m.executionMode } : {}),
			}));
			await saveCustomToolPackage(pkgName, js, tools);
			chrome.runtime.sendMessage({ type: "reload_custom_tools" }).catch(() => {});
			const count = metas.length;
			setStatus({ state: "ok", text: `imported ${pkgName} (${count} tool${count > 1 ? "s" : ""})` });
			await refresh();
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			setStatus({ state: "err", text: err instanceof Error ? err.message : String(err) });
		}
	};

	const onDelete = async (name: string) => {
		await deleteUserCustomTool(name);
		chrome.runtime.sendMessage({ type: "reload_custom_tools" }).catch(() => {});
		await refresh();
	};

	return (
		<details className="settings-group">
			<summary className="settings-header">Custom tools</summary>
			<p className="settings-hint">
				Executable, typed tools built with <code>@culiq/sandbox</code>. On an npm package page, click
				"Load from npm page" to install it; or import a folder containing <code>culiq-tool.js</code>.
				These settings control the default state. Use the "Tools" button in the chat input to toggle tools per message (does not change these settings).
			</p>
			<div className="settings-actions">
				<span className="status" data-state={status?.state}>
					{status?.text ?? ""}
				</span>
				<button type="button" onClick={() => void onNpmPage()}>
					Load from npm page (current tab)
				</button>
				<button type="button" onClick={() => void onImport()}>
					Import folder…
				</button>
			</div>
			<div className="capability-list">
				{tools === null ? null : tools.length === 0 ? (
					<p>No custom tools installed yet.</p>
				) : (
				tools.map((t) => (
						<div className="capability" key={t.toolName}>
							<code>{t.toolName}</code>
							{t.name !== t.toolName && <span className="capability-desc"> ({t.name})</span>}
							<span className="capability-desc"> {t.description}</span>
							<div className="capability-actions">
								<button
									type="button"
									className="skill-delete"
									onClick={(e) => {
										e.preventDefault();
										const disabled = settings.disabledTools;
										settings.disabledTools = disabled.includes(t.toolName)
											? disabled.filter((n) => n !== t.toolName)
											: [...disabled, t.toolName];
										dirty();
									}}
								>
									{settings.disabledTools.includes(t.toolName) ? "enable" : "disable"}
								</button>
								{t.source === "user" ? (
									<button
										type="button"
										className="skill-delete"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											void onDelete(t.name);
										}}
									>
										delete
									</button>
								) : (
									<span className="capability-desc">(builtin)</span>
								)}
							</div>
						</div>
					))
				)}
			</div>
		</details>
	);
}

function SearchAndSubAgentGroup({ settings, dirty }: { settings: CuliqSettings; dirty: () => void }) {
	return (
		<details className="settings-group">
			<summary className="settings-header">Sub-agent</summary>
			<p className="settings-hint">
				Optional model for the `subtask` sub-agent. Leave empty to use the main model.
			</p>
			<label>
				<span>Sub-agent model</span>
				<select
					value={settings.subAgentModel}
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => { settings.subAgentModel = (e.target as HTMLSelectElement).value; dirty(); }}
				>
					<option value="">Use main model</option>
					{settings.models.map((m) => (
						<option key={m.id} value={m.id}>
							{settings.providers.find((p) => p.id === m.providerId)?.name ?? m.providerId}: {m.name}
						</option>
					))}
				</select>
			</label>
		</details>
	);
}

export function SettingsView() {
	const [settings, setSettings] = useState<CuliqSettings | null>(null);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "ok" | "err">("idle");
	const [saveMsg, setSaveMsg] = useState("");

	useEffect(() => {
		void loadSettings().then(setSettings);
	}, []);

	if (!settings) return null;

	const dirty = () => setSettings({
		...settings,
		providers: settings.providers.map((p) => ({ ...p })),
		models: settings.models.map((m) => ({ ...m })),
	});

	const onSave = async () => {
		setSaveState("saving");
		try {
			await saveSettings(settings);
			setSaveState("ok");
			setSaveMsg("saved");
		} catch (err) {
			setSaveState("err");
			setSaveMsg(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<>
		<ProvidersGroup settings={settings} dirty={dirty} />
		<ModelsGroup settings={settings} dirty={dirty} />
		<ContextGroup settings={settings} dirty={dirty} />
			<SearchAndSubAgentGroup settings={settings} dirty={dirty} />
			<LocalToolsGroup settings={settings} dirty={dirty} />
			<SkillsGroup />
			<McpServersGroup />
			<div className="settings-actions settings-save-bar">
				<span className="status" data-state={saveState === "ok" ? "ok" : saveState === "err" ? "err" : undefined}>
					{saveMsg}
				</span>
				<button type="button" disabled={saveState === "saving"} onClick={() => void onSave()}>
					Save
				</button>
			</div>
		</>
	);
}
