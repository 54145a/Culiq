import type { Session } from "./sessions";

/**
 * Raw conversation export. `session` is the stored record verbatim — nothing is
 * transformed, dropped, or truncated — wrapped in a small self-describing
 * envelope so the file can be recognised and validated later.
 */
export interface SessionExport {
	format: "culiq.session";
	version: 1;
	exportedAt: string;
	session: Session;
}

export function buildSessionExport(session: Session, now: Date = new Date()): SessionExport {
	return {
		format: "culiq.session",
		version: 1,
		exportedAt: now.toISOString(),
		session,
	};
}

export function sessionExportJson(session: Session, now: Date = new Date()): string {
	return `${JSON.stringify(buildSessionExport(session, now), null, 2)}\n`;
}

export function sessionExportFilename(session: Session, now: Date = new Date()): string {
	return `culiq-${slugifyTitle(session.title, session.id)}-${stamp(now)}.json`;
}

const MAX_SLUG = 48;

/** Filesystem-safe, lowercase slug; falls back to the session id when the title has no usable characters. */
function slugifyTitle(title: string, sessionId: string): string {
	const slug = title
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG)
		.replace(/-+$/g, "")
		.toLowerCase();
	if (slug) return slug;
	const idPart = sessionId.replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 8).toLowerCase();
	return idPart ? `session-${idPart}` : "session";
}

function stamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
