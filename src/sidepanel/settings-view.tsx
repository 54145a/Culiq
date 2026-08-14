import { useEffect, useState } from "preact/hooks";
import { SYSTEM_PROMPT_PARTS } from "@shared/agent/system-prompt";
import {
	loadSettings,
	PROVIDER_DEFAULTS,
	type Capability,
	type CurioSettings,
	type ProviderId,
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

const PROVIDERS: ProviderId[] = ["openai", "anthropic"];

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

function ProviderCard({
	id,
	settings,
	activate,
	dirty,
}: {
	id: ProviderId;
	settings: CurioSettings;
	activate: () => void;
	dirty: () => void;
}) {
	const config = settings.providers[id];
	const def = PROVIDER_DEFAULTS[id];
	const isActive = settings.activeProvider === id;

	const setField = (field: "apiKey" | "baseUrl" | "model", value: string) => {
		if (field === "apiKey") config.apiKey = value;
		else config[field] = value || def[field];
		dirty();
	};

	return (
		<div
			className="provider-card"
			data-active={String(isActive)}
			role="button"
			tabIndex={0}
			aria-pressed={isActive}
			onClick={(e) => {
				if ((e.target as HTMLElement).closest("label, input, button")) return;
				activate();
			}}
			onKeyDown={(e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				if ((e.target as HTMLElement).closest("input, button")) return;
				e.preventDefault();
				activate();
			}}
		>
			<header>
				<h3>{def.label}</h3>
				<span className="active-badge">{isActive ? "active" : "click to activate"}</span>
			</header>
			<Field
				label="API key"
				type="password"
				value={config.apiKey}
				placeholder={id === "anthropic" ? "sk-ant-..." : "sk-..."}
				onInput={(v) => setField("apiKey", v)}
			/>
			<Field label="Base URL" type="text" value={config.baseUrl} placeholder={def.baseUrl} onInput={(v) => setField("baseUrl", v)} />
			<Field label="Model" type="text" value={config.model} placeholder={def.model} onInput={(v) => setField("model", v)} />
		</div>
	);
}

function ProvidersGroup({ settings, dirty }: { settings: CurioSettings; dirty: () => void }) {
	const activate = (id: ProviderId) => {
		if (settings.activeProvider === id) return;
		settings.activeProvider = id;
		dirty();
	};

	return (
		<details className="settings-group">
			<summary className="settings-header">
				Providers
				<span className="summary-badge">{PROVIDER_DEFAULTS[settings.activeProvider].label}</span>
			</summary>
			<p className="settings-hint">Click a provider to make it active.</p>
			{PROVIDERS.map((id) => (
				<ProviderCard key={id} id={id} settings={settings} activate={() => activate(id)} dirty={dirty} />
			))}
		</details>
	);
}

function CapabilitiesGroup({ settings, dirty }: { settings: CurioSettings; dirty: () => void }) {
	const toggle = (key: Capability, checked: boolean) => {
		if (checked) {
			if (!settings.capabilities.includes(key)) settings.capabilities.push(key);
		} else {
			settings.capabilities = settings.capabilities.filter((c) => c !== key);
		}
		dirty();
	};

	return (
		<details className="settings-group">
			<summary className="settings-header">Capabilities</summary>
			<p className="settings-hint">Tools the agent is allowed to use.</p>
			<div className="capability-list">
				{Object.entries(SYSTEM_PROMPT_PARTS.capabilities).map(([key, description]) => (
					<label className="capability" key={key}>
						<input
							type="checkbox"
							checked={settings.capabilities.includes(key as Capability)}
							onChange={(e) => toggle(key as Capability, (e.target as HTMLInputElement).checked)}
						/>
						<code>{key}</code>
						<span className="capability-desc">{description}</span>
					</label>
				))}
			</div>
		</details>
	);
}

function ContextGroup({ settings, dirty }: { settings: CurioSettings; dirty: () => void }) {
	const cm = settings.contextManagement;

	return (
		<details className="settings-group">
			<summary className="settings-header">Context management</summary>
			<p className="settings-hint">
				Summarize old turns when the conversation nears the model's context window. Fill in the context window size below; if
				left empty a conservative default is used.
			</p>
			<label className="capability">
				<input
					type="checkbox"
					checked={cm.enabled}
					onChange={(e) => {
						cm.enabled = (e.target as HTMLInputElement).checked;
						dirty();
					}}
				/>
				<code>Auto-compress context</code>
			</label>
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
			<Field
				label="Context window (tokens)"
				type="number"
				value={cm.windowOverride !== undefined ? String(cm.windowOverride) : ""}
				placeholder="e.g. 200000"
				onInput={(v) => {
					const n = Number(v);
					cm.windowOverride = v.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
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
					<p className="settings-hint">No skills installed yet.</p>
				) : (
					skills.map((skill) => (
						<label className="capability" key={skill.name}>
							<input
								type="checkbox"
								checked={skill.enabled}
								disabled={skill.source === "builtin"}
								onChange={(e) => void onToggle(skill.name, (e.target as HTMLInputElement).checked)}
							/>
							<code>{skill.name}</code>
							<span className="capability-desc">{skill.source === "builtin" ? "builtin" : "user"}</span>
							<span className="capability-desc">{skill.description}</span>
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
						</label>
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
					<p className="settings-hint">No MCP servers configured yet.</p>
				) : (
					servers.map((server) => (
						<label className="capability" key={server.name}>
							<input
								type="checkbox"
								checked={server.enabled}
								onChange={(e) => void onToggle(server, (e.target as HTMLInputElement).checked)}
							/>
							<code>{server.name}</code>
							<span className="capability-desc">{server.transport}</span>
							<span className="capability-desc">{server.url}</span>
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
						</label>
					))
				)}
			</div>
		</details>
	);
}

export function SettingsView() {
	const [settings, setSettings] = useState<CurioSettings | null>(null);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "ok" | "err">("idle");
	const [saveMsg, setSaveMsg] = useState("");

	useEffect(() => {
		void loadSettings().then(setSettings);
	}, []);

	if (!settings) return null;

	const dirty = () => setSettings({ ...settings });

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
			<CapabilitiesGroup settings={settings} dirty={dirty} />
			<ContextGroup settings={settings} dirty={dirty} />
			<SkillsGroup />
			<McpServersGroup />
			<div className="settings-actions">
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
