import { deleteSession, formatRelativeTime, listSessions, type Session } from "@shared/sessions";

export interface SessionsViewOptions {
	currentId: () => string | null;
	canSwitch: () => boolean;
	onSwitch: (id: string) => Promise<void> | void;
	onNew: () => Promise<void> | void;
}

export function mountSessions(root: HTMLElement, options: SessionsViewOptions): { refresh: () => void } {
	let pending: Promise<void> | null = null;

	const render = async () => {
		const sessions = await listSessions();
		const currentId = options.currentId();
		const canSwitch = options.canSwitch();

		root.innerHTML = "";

		const actions = document.createElement("div");
		actions.className = "sessions-actions";
		const stats = document.createElement("span");
		stats.className = "sessions-stats";
		stats.textContent = sessions.length === 0 ? "no saved sessions" : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
		const newBtn = document.createElement("button");
		newBtn.type = "button";
		newBtn.textContent = "+ New session";
		newBtn.disabled = !canSwitch;
		newBtn.title = canSwitch ? "Start a fresh conversation" : "Stop generation first";
		newBtn.addEventListener("click", async () => {
			await options.onNew();
			await render();
		});
		actions.append(stats, newBtn);
		root.appendChild(actions);

		if (!canSwitch) {
			const lock = document.createElement("p");
			lock.className = "sessions-lock";
			lock.textContent = "Generation in progress. Switching is disabled until it finishes.";
			root.appendChild(lock);
		}

		if (sessions.length === 0) {
			const empty = document.createElement("p");
			empty.className = "sessions-empty";
			empty.textContent = "Send a message in Chat to start your first session.";
			root.appendChild(empty);
			return;
		}

		const list = document.createElement("ul");
		list.className = "sessions-list";
		for (const session of sessions) {
			list.appendChild(renderRow(session, currentId, canSwitch));
		}
		root.appendChild(list);
	};

	function renderRow(session: Session, currentId: string | null, canSwitch: boolean): HTMLLIElement {
		const li = document.createElement("li");
		li.className = "session-row";
		li.dataset.active = String(session.id === currentId);

		const main = document.createElement("button");
		main.type = "button";
		main.className = "session-main";
		main.disabled = !canSwitch;

		const title = document.createElement("div");
		title.className = "session-title";
		title.textContent = session.title;

		const meta = document.createElement("div");
		meta.className = "session-meta";
		const count = session.messages.length;
		meta.textContent = `${count} msg${count === 1 ? "" : "s"}  ·  ${formatRelativeTime(session.updatedAt)}`;

		main.append(title, meta);
		main.addEventListener("click", async () => {
			if (!canSwitch) return;
			await options.onSwitch(session.id);
			await render();
		});

		const delBtn = document.createElement("button");
		delBtn.type = "button";
		delBtn.className = "session-delete";
		delBtn.disabled = !canSwitch;
		delBtn.title = "Delete session";
		delBtn.setAttribute("aria-label", `Delete session ${session.title}`);
		delBtn.textContent = "✕";
		delBtn.addEventListener("click", async (e) => {
			e.stopPropagation();
			if (!canSwitch) return;
			const ok = window.confirm(`Delete session "${session.title}"?\n\nThis cannot be undone.`);
			if (!ok) return;
			await deleteSession(session.id);
			if (session.id === currentId) await options.onNew();
			await render();
		});

		li.append(main, delBtn);
		return li;
	}

	const refresh = () => {
		if (pending) return;
		pending = render().finally(() => {
			pending = null;
		});
	};

	refresh();
	return { refresh };
}
