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
			{!canSwitch && <p className="rounded-[6px] border border-running/35 bg-running/[12%] px-[10px] py-[8px] m-0 text-[0.82rem] text-running">Generation in progress. Switching is disabled until it finishes.</p>}
			{loaded && sessions.length === 0 && <p className="m-0 px-[10px] py-[16px] text-center text-[0.88rem] text-current/50">Send a message in Chat to start your first session.</p>}
			{sessions.length > 0 && (
				<ul className="m-0 flex list-none flex-col gap-[6px] p-0">
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
		<li
				className={`flex items-stretch gap-[4px] overflow-hidden rounded-[8px] border transition-[border-color,box-shadow] duration-150 ${session.id === currentId ? "border-primary shadow-[inset_0_0_0_1px_#4a90e2]" : "border-current/[15%] hover:border-current/30"}`}
				data-active={String(session.id === currentId)}
			>
			<button
				type="button"
				className="m-0 min-w-0 flex-1 cursor-pointer flex-col items-start gap-[4px] rounded-none border-none bg-transparent px-[12px] py-[10px] text-left [font:inherit] text-inherit hover:bg-current/[6%]"
				disabled={!canSwitch}
				onClick={() => {
					if (canSwitch) void options.onSwitch(session.id);
				}}
			>
				<div className="w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.92rem] font-medium">{session.title}</div>
				<div className="text-[0.74rem] text-current/55">
					{`${session.messages.length} msg${session.messages.length === 1 ? "" : "s"}  ·  ${formatRelativeTime(session.updatedAt)}`}
				</div>
			</button>
			<button
				type="button"
				className="w-[36px] rounded-none border-none bg-transparent p-0 text-[1rem] leading-none text-current/45 hover:bg-danger/[18%] hover:text-danger"
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
