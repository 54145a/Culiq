import { useEffect, useState } from "preact/hooks";
import { deleteSession, formatRelativeTime, listSessions, type Session } from "@shared/sessions";

export interface SessionsViewOptions {
	currentId: () => string | null;
	canSwitch: () => boolean;
	onSwitch: (id: string) => Promise<void> | void;
	onNew: () => Promise<void> | void;
}

const notifier = { v: 0, listeners: new Set<() => void>() };

export function refreshSessions(): void {
	notifier.v++;
	for (const cb of notifier.listeners) cb();
}

/** Re-render + reload whenever refreshSessions() bumps the version. */
function useSessionsVersion(): number {
	const [version, setVersion] = useState(notifier.v);
	useEffect(() => {
		const onNotify = () => setVersion(notifier.v);
		notifier.listeners.add(onNotify);
		return () => {
			notifier.listeners.delete(onNotify);
		};
	}, []);
	return version;
}

export function SessionsView({ options }: { options: SessionsViewOptions }) {
	const version = useSessionsVersion();
	const [sessions, setSessions] = useState<Session[]>([]);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		listSessions()
			.then((list) => {
				if (cancelled) return;
				setSessions(list);
				setLoaded(true);
			})
			.catch(() => {
				if (cancelled) return;
				setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [version]);

	const currentId = options.currentId();
	const canSwitch = options.canSwitch();

	return (
		<>
			<div className="sessions-actions">
				<span className="sessions-stats">
					{sessions.length === 0 ? "no saved sessions" : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
				</span>
				<button
					type="button"
					disabled={!canSwitch}
					title={canSwitch ? "Start a fresh conversation" : "Stop generation first"}
					onClick={() => void options.onNew()}
				>
					+ New session
				</button>
			</div>
			{!canSwitch && <p className="sessions-lock">Generation in progress. Switching is disabled until it finishes.</p>}
			{loaded && sessions.length === 0 && <p className="sessions-empty">Send a message in Chat to start your first session.</p>}
			{sessions.length > 0 && (
				<ul className="sessions-list">
					{sessions.map((session) => (
						<SessionsRow key={session.id} session={session} currentId={currentId} canSwitch={canSwitch} options={options} />
					))}
				</ul>
			)}
		</>
	);
}

function SessionsRow({
	session,
	currentId,
	canSwitch,
	options,
}: {
	session: Session;
	currentId: string | null;
	canSwitch: boolean;
	options: SessionsViewOptions;
}) {
	return (
		<li className="session-row" data-active={String(session.id === currentId)}>
			<button
				type="button"
				className="session-main"
				disabled={!canSwitch}
				onClick={() => {
					if (canSwitch) void options.onSwitch(session.id);
				}}
			>
				<div className="session-title">{session.title}</div>
				<div className="session-meta">
					{`${session.messages.length} msg${session.messages.length === 1 ? "" : "s"}  ·  ${formatRelativeTime(session.updatedAt)}`}
				</div>
			</button>
			<button
				type="button"
				className="session-delete"
				disabled={!canSwitch}
				title="Delete session"
				aria-label={`Delete session ${session.title}`}
				onClick={() => {
					if (!canSwitch) return;
					const ok = window.confirm(`Delete session "${session.title}"?\n\nThis cannot be undone.`);
					if (!ok) return;
					void deleteSession(session.id).then(() => {
						if (session.id === currentId) void options.onNew();
						refreshSessions();
					});
				}}
			>
				✕
			</button>
		</li>
	);
}
