import { SYSTEM_PROMPT_PARTS } from "@shared/agent/system-prompt";
import { loadSettings, PROVIDER_DEFAULTS, type Capability, type ProviderId, saveSettings } from "@shared/config";

const PROVIDERS: ProviderId[] = ["openai", "anthropic"];

export async function mountSettings(root: HTMLElement): Promise<void> {
	const settings = await loadSettings();
	const statusEl = document.createElement("span");
	statusEl.className = "status";

	const render = () => {
		root.innerHTML = "";

		const providers = document.createElement("details");
		providers.className = "settings-group";
		providers.open = false;

		const providersSummary = document.createElement("summary");
		providersSummary.className = "settings-header";
		providersSummary.textContent = "Providers";

		const activeLabel = PROVIDER_DEFAULTS[settings.activeProvider].label;
		const badge = document.createElement("span");
		badge.className = "summary-badge";
		badge.textContent = activeLabel;
		providersSummary.appendChild(badge);

		providers.appendChild(providersSummary);

		const hint = document.createElement("p");
		hint.className = "settings-hint";
		hint.textContent = "Click a provider to make it active.";
		providers.appendChild(hint);

		for (const id of PROVIDERS) {
			providers.appendChild(renderCard(id));
		}

		root.appendChild(providers);

		const capabilities = document.createElement("details");
		capabilities.className = "settings-group";
		capabilities.open = false;

		const capHeader = document.createElement("summary");
		capHeader.className = "settings-header";
		capHeader.textContent = "Capabilities";
		capabilities.appendChild(capHeader);

		const capHint = document.createElement("p");
		capHint.className = "settings-hint";
		capHint.textContent = "Tools the agent is allowed to use.";
		capabilities.appendChild(capHint);

		const capList = document.createElement("div");
		capList.className = "capability-list";
		for (const [key, description] of Object.entries(SYSTEM_PROMPT_PARTS.capabilities)) {
			capList.appendChild(renderCapability(key as Capability, description));
		}
		capabilities.appendChild(capList);

		root.appendChild(capabilities);

		const actions = document.createElement("div");
		actions.className = "settings-actions";

		statusEl.textContent = "";
		statusEl.removeAttribute("data-state");
		actions.appendChild(statusEl);

		const saveBtn = document.createElement("button");
		saveBtn.type = "button";
		saveBtn.textContent = "Save";
		saveBtn.addEventListener("click", () => void onSave(saveBtn));
		actions.appendChild(saveBtn);

		root.appendChild(actions);
	};

	const activate = (id: ProviderId) => {
		if (settings.activeProvider === id) return;
		settings.activeProvider = id;
		render();
	};

	const onSave = async (btn: HTMLButtonElement) => {
		btn.disabled = true;
		try {
			await saveSettings(settings);
			statusEl.dataset.state = "ok";
			statusEl.textContent = "saved";
		} catch (e) {
			statusEl.dataset.state = "err";
			statusEl.textContent = e instanceof Error ? e.message : String(e);
		} finally {
			btn.disabled = false;
		}
	};

	function renderCard(id: ProviderId): HTMLElement {
		const config = settings.providers[id];
		const def = PROVIDER_DEFAULTS[id];
		const isActive = settings.activeProvider === id;

		const card = document.createElement("div");
		card.className = "provider-card";
		card.dataset.active = String(isActive);
		card.setAttribute("role", "button");
		card.setAttribute("tabindex", "0");
		card.setAttribute("aria-pressed", String(isActive));

		const head = document.createElement("header");
		const title = document.createElement("h3");
		title.textContent = def.label;
		head.appendChild(title);

		const badge = document.createElement("span");
		badge.className = "active-badge";
		badge.textContent = isActive ? "active" : "click to activate";
		head.appendChild(badge);

		card.appendChild(head);

		card.appendChild(
			field({
				label: "API key",
				type: "password",
				value: config.apiKey,
				placeholder: id === "anthropic" ? "sk-ant-..." : "sk-...",
				onInput: (v) => {
					config.apiKey = v;
				},
			}),
		);
		card.appendChild(
			field({
				label: "Base URL",
				type: "text",
				value: config.baseUrl,
				placeholder: def.baseUrl,
				onInput: (v) => {
					config.baseUrl = v || def.baseUrl;
				},
			}),
		);
		card.appendChild(
			field({
				label: "Model",
				type: "text",
				value: config.model,
				placeholder: def.model,
				onInput: (v) => {
					config.model = v || def.model;
				},
			}),
		);

		card.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest("label, input, button")) return;
			activate(id);
		});
		card.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				const target = e.target as HTMLElement;
				if (target.closest("input, button")) return;
				e.preventDefault();
				activate(id);
			}
		});

		return card;
	}

	function renderCapability(key: Capability, description: string): HTMLLabelElement {
		const label = document.createElement("label");
		label.className = "capability";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = settings.capabilities.includes(key);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) {
				if (!settings.capabilities.includes(key)) settings.capabilities.push(key);
			} else {
				settings.capabilities = settings.capabilities.filter((c) => c !== key);
			}
		});

		const name = document.createElement("code");
		name.textContent = key;

		const desc = document.createElement("span");
		desc.className = "capability-desc";
		desc.textContent = description;

		label.append(checkbox, name, desc);
		return label;
	}

	render();
}

function field(opts: {
	label: string;
	type: "text" | "password";
	value: string;
	placeholder?: string;
	onInput: (value: string) => void;
}): HTMLLabelElement {
	const label = document.createElement("label");
	const span = document.createElement("span");
	span.textContent = opts.label;
	const input = document.createElement("input");
	input.type = opts.type;
	input.value = opts.value;
	if (opts.placeholder) input.placeholder = opts.placeholder;
	input.addEventListener("input", () => opts.onInput(input.value));
	input.addEventListener("click", (e) => e.stopPropagation());
	label.append(span, input);
	return label;
}
