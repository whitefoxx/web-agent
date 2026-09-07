/**
 * Shortcuts store (roadmap T5) — the backing store for workflows (the UI concept,
 * renamed from "shortcuts" 2026-07-09 when the rigid workflow-pipeline was removed). A
 * shortcut is a saved snippet inserted into the composer — a reusable PROMPT
 * recipe (which may embed ⟦tool:..⟧ command tokens) or a legacy TOOL reference.
 * Persisted in chrome.storage.local. (Keyboard binding was dropped — shortcuts
 * just insert text now.)
 */

/** Composer run mode — used by the built-in `/plan` and `/explore` commands.
 * Shortcuts themselves no longer carry a mode; they're pure prompt snippets. */
export type ShortcutMode = 'chat' | 'plan' | 'explore';

export interface Shortcut {
  id: string;
  label: string;
  kind: 'prompt' | 'tool';
  /** prompt: the recipe text inserted into the composer (may embed ⟦tool:..⟧
   * command tokens). */
  text?: string;
  /** tool: dispatcher tool id + preset args. */
  tool?: string;
  args?: Record<string, unknown>;
}

const KEY = 'shortcuts';

function hasStorage(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local;
  } catch {
    return false;
  }
}

export function makeShortcutId(): string {
  return `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function listShortcuts(): Promise<Shortcut[]> {
  if (!hasStorage()) return [];
  const got = await chrome.storage.local.get(KEY);
  const arr = got[KEY];
  return Array.isArray(arr) ? (arr as Shortcut[]) : [];
}

export async function getShortcut(id: string): Promise<Shortcut | null> {
  return (await listShortcuts()).find((s) => s.id === id) ?? null;
}

/** Upsert by id (matches on id; otherwise appends). Returns the saved list. */
export async function saveShortcut(s: Shortcut): Promise<Shortcut[]> {
  const list = await listShortcuts();
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = s;
  else list.push(s);
  if (hasStorage()) await chrome.storage.local.set({ [KEY]: list });
  return list;
}

export async function deleteShortcut(id: string): Promise<Shortcut[]> {
  const list = (await listShortcuts()).filter((s) => s.id !== id);
  if (hasStorage()) await chrome.storage.local.set({ [KEY]: list });
  return list;
}
