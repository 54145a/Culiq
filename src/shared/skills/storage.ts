/** Persistence for skills: metadata in chrome.storage.local. */

import type { Skill } from "./index";

export type SkillSource = Skill["source"];

export interface SkillMeta {
	source: SkillSource;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

const META_KEY = "culiq.skills.meta";
type MetaMap = Record<string, SkillMeta>;

async function readMeta(): Promise<MetaMap> {
	const raw = await chrome.storage.local.get(META_KEY);
	return (raw[META_KEY] as MetaMap | undefined) ?? {};
}

async function writeMeta(meta: MetaMap): Promise<void> {
	await chrome.storage.local.set({ [META_KEY]: meta });
}

export async function getSkillMeta(name: string): Promise<SkillMeta | undefined> {
	const meta = await readMeta();
	return meta[name];
}

export async function setSkillMeta(name: string, meta: SkillMeta): Promise<void> {
	const all = await readMeta();
	all[name] = meta;
	await writeMeta(all);
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
	const all = await readMeta();
	const entry = all[name];
	if (!entry) return;
	entry.enabled = enabled;
	entry.updatedAt = Date.now();
	await writeMeta(all);
}

export async function deleteSkillMeta(name: string): Promise<void> {
	const all = await readMeta();
	delete all[name];
	await writeMeta(all);
}
