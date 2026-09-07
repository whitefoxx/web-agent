/**
 * Skills store — single-file markdown "skills" (Claude-Code style). A skill is a
 * reusable operating guide the AGENT loads on demand: its name+description are
 * advertised in the system prompt (progressive disclosure), and `use_skill`
 * pulls in the full body when relevant. Unlike workflows (user-triggered prompt
 * recipes inserted into the composer), skills are model-invoked — though they're
 * ALSO offered in the `/` palette for manual insertion.
 *
 * body is markdown and may embed ⟦tool:..⟧ / ⟦cmd:..⟧ tokens (generic tools /
 * site adapters / workflows), authored via the shared CommandEditor `/` palette.
 * Persisted in chrome.storage.local (key `skills`), same pattern as shortcuts.
 *
 * The pure `renderSkillsBlock` is unit-tested; the chrome.storage I/O is not
 * (no chrome in the node test env).
 */

export interface Skill {
  id: string;
  /** Short, identifiable name — used in the `/` palette, use_skill, and dedupe. */
  name: string;
  /** One-line "when to use / what it does" — advertised to the agent. */
  description: string;
  /** The skill body (markdown, may embed ⟦tool:..⟧ tokens). */
  body: string;
}

const KEY = 'skills';

function hasStorage(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local;
  } catch {
    return false;
  }
}

export function makeSkillId(): string {
  return `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function listSkills(): Promise<Skill[]> {
  if (!hasStorage()) return [];
  const got = await chrome.storage.local.get(KEY);
  const arr = got[KEY];
  return Array.isArray(arr) ? (arr as Skill[]) : [];
}

export async function getSkill(id: string): Promise<Skill | null> {
  return (await listSkills()).find((s) => s.id === id) ?? null;
}

/** Case-insensitive name lookup (used by use_skill). */
export async function getSkillByName(name: string): Promise<Skill | null> {
  const n = name.trim().toLowerCase();
  const all = await listSkills();
  return all.find((s) => s.name.toLowerCase() === n) ?? null;
}

/** Upsert by id (matches on id; otherwise appends). Returns the saved list. */
export async function saveSkill(s: Skill): Promise<Skill[]> {
  const list = await listSkills();
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = s;
  else list.push(s);
  if (hasStorage()) await chrome.storage.local.set({ [KEY]: list });
  return list;
}

/** Upsert by NAME (agent `create_skill`): same name modifies in place. Returns
 * the saved skill. */
export async function saveSkillByName(input: {
  name: string;
  description: string;
  body: string;
}): Promise<Skill> {
  const list = await listSkills();
  const existing = list.find((s) => s.name.toLowerCase() === input.name.trim().toLowerCase());
  const skill: Skill = {
    id: existing?.id ?? makeSkillId(),
    name: input.name.trim(),
    description: input.description.trim(),
    body: input.body,
  };
  await saveSkill(skill);
  return skill;
}

export async function deleteSkill(id: string): Promise<Skill[]> {
  const list = (await listSkills()).filter((s) => s.id !== id);
  if (hasStorage()) await chrome.storage.local.set({ [KEY]: list });
  return list;
}

/** Pure: advertise the available skills (name + description ONLY — bodies are
 * loaded on demand via use_skill) as a system-prompt block. Empty when none. */
export function renderSkillsBlock(skills: Skill[]): string {
  const usable = skills.filter((s) => s.name.trim() && s.body.trim());
  if (!usable.length) return '';
  const lines = usable.map((s) => `- ${s.name}: ${s.description.trim() || '(no description)'}`);
  return (
    '\n\n## Available skills\nThese skills are reusable operating guides; when one is relevant to the current task, call `use_skill` (arg `name`) ' +
    'to load its full instructions and follow them (progressive disclosure — no need to read everything up front):\n' +
    lines.join('\n')
  );
}
