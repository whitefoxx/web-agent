/**
 * llm-config — multi-profile storage + capability slots + migration.
 *
 * Surfaces:
 *  - `loadLlmConfig` — primary (orchestrator) profile, consumed by api-engine.
 *  - `resolveSlots` — every capability slot resolved to a profile.
 *  - `loadProfiles` / `upsertProfile` / `deleteProfile` / `setSlot` — manager API.
 *
 * Legacy migrations roll forward so upgrading users keep their credentials:
 * old `{ activeId, profiles }` → `slots.primary`; a profile's old `vision:true`
 * flag → the `vision` slot.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLlmConfig,
  saveLlmConfig,
  loadProfiles,
  resolveSlots,
  upsertProfile,
  deleteProfile,
  setSlot,
  setActiveProfile,
  newProfileId,
  autoLabel,
  DEFAULT_CONFIG,
  type LlmProfile,
} from '../src/config/llm-config';

const STORAGE_KEY = 'web_llm_config';

function makeStorageStub(): { install: () => void; reset: () => void } {
  let data: Record<string, unknown> = {};
  const storage = {
    local: {
      async get(key: string | string[] | null) {
        if (key === null) return { ...data };
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) if (k in data) out[k] = data[k];
          return out;
        }
        return key in data ? { [key]: data[key] } : {};
      },
      async set(items: Record<string, unknown>) {
        Object.assign(data, items);
      },
    },
  };
  return {
    install() {
      (globalThis as unknown as { chrome: unknown }).chrome = { storage };
    },
    reset() {
      data = {};
    },
  };
}

const stub = makeStorageStub();
stub.install();

beforeEach(() => {
  stub.reset();
});

/* ───────── primary resolver (consumed by api-engine) ───────── */

describe('loadLlmConfig (primary resolver)', () => {
  it('returns the empty defaults when nothing is stored', async () => {
    const c = await loadLlmConfig();
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(c.apiKey).toBe('');
  });

  it('round-trips a config saved through saveLlmConfig', async () => {
    const cfg = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    };
    await saveLlmConfig(cfg);
    expect(await loadLlmConfig()).toEqual(cfg);
  });

  it('save creates the first profile and makes it primary when the store is empty', async () => {
    await saveLlmConfig({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-1',
      model: 'deepseek-chat',
    });
    const store = await loadProfiles();
    expect(store.profiles).toHaveLength(1);
    expect(store.slots.primary).toBe(store.profiles[0]!.id);
  });

  it('save mutates the primary profile in place (no duplicate entries)', async () => {
    await saveLlmConfig({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-old',
      model: 'gpt-4o',
    });
    await saveLlmConfig({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-new',
      model: 'deepseek-chat',
    });
    const store = await loadProfiles();
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]!.apiKey).toBe('sk-new');
  });
});

/* ───────── capability slots ───────── */

function makeProfile(overrides: Partial<LlmProfile> = {}): LlmProfile {
  const cfg = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-1',
    model: 'deepseek-chat',
  };
  return { id: newProfileId(), label: autoLabel(cfg), ...cfg, ...overrides };
}

describe('capability slots', () => {
  it('first profile auto-fills the primary slot; resolveSlots returns it', async () => {
    const p = makeProfile();
    await upsertProfile(p);
    const slots = await resolveSlots();
    expect(slots.primary?.id).toBe(p.id);
    expect(slots.vision).toBeNull();
    expect(slots.image).toBeNull();
  });

  it('assigns vision / image slots independently; one profile can fill several', async () => {
    const main = makeProfile({ apiKey: 'sk-main', model: 'glm-5' });
    const vis = makeProfile({ apiKey: 'sk-vis', model: 'glm-4.6v' });
    await upsertProfile(main);
    await upsertProfile(vis);
    await setSlot('vision', vis.id);
    await setSlot('image', main.id); // same profile can also serve image
    const slots = await resolveSlots();
    expect(slots.primary?.id).toBe(main.id);
    expect(slots.vision?.id).toBe(vis.id);
    expect(slots.image?.id).toBe(main.id);
  });

  it('setSlot(null) clears a slot', async () => {
    const p = makeProfile();
    await upsertProfile(p);
    await setSlot('vision', p.id);
    expect((await resolveSlots()).vision?.id).toBe(p.id);
    await setSlot('vision', null);
    expect((await resolveSlots()).vision).toBeNull();
  });

  it('setSlot ignores an unknown profile id', async () => {
    const p = makeProfile();
    await upsertProfile(p);
    await setSlot('vision', 'bogus');
    expect((await resolveSlots()).vision).toBeNull();
  });

  it('a dangling slot id (profile gone) resolves to null', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        profiles: [{ ...makeProfile({ id: 'real' }) }],
        slots: { primary: 'real', vision: 'ghost' },
      },
    });
    const slots = await resolveSlots();
    expect(slots.primary?.id).toBe('real');
    expect(slots.vision).toBeNull();
  });
});

describe('upsertProfile', () => {
  it('makes the FIRST profile primary; a second does not steal primary', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(p1);
    const store = await upsertProfile(p2);
    expect(store.profiles).toHaveLength(2);
    expect(store.slots.primary).toBe(p1.id);
  });

  it('asPrimary:true promotes the upserted profile to primary', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(p1);
    const store = await upsertProfile(p2, { asPrimary: true });
    expect(store.slots.primary).toBe(p2.id);
  });

  it('updates an existing profile in place when ids match', async () => {
    const p = makeProfile({ apiKey: 'sk-old', label: 'My Key' });
    await upsertProfile(p);
    const store = await upsertProfile({ ...p, apiKey: 'sk-new', label: 'My Key (rotated)' });
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]!.apiKey).toBe('sk-new');
  });
});

describe('deleteProfile', () => {
  it('removes the profile and clears it from every slot it filled', async () => {
    const main = makeProfile({ apiKey: 'sk-a' });
    const vis = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(main);
    await upsertProfile(vis);
    await setSlot('vision', vis.id);
    const store = await deleteProfile(vis.id);
    expect(store.profiles.map((p) => p.id)).toEqual([main.id]);
    expect(store.slots.vision).toBeUndefined();
    expect(store.slots.primary).toBe(main.id);
  });

  it('a remaining profile takes over primary when the primary is deleted', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(p1); // p1 primary
    await upsertProfile(p2);
    const store = await deleteProfile(p1.id);
    expect(store.slots.primary).toBe(p2.id);
  });

  it('clears primary when the last profile is deleted', async () => {
    const p = makeProfile();
    await upsertProfile(p);
    const store = await deleteProfile(p.id);
    expect(store.profiles).toHaveLength(0);
    expect(store.slots.primary).toBeUndefined();
  });
});

describe('setActiveProfile (alias for primary slot)', () => {
  it('sets the primary slot', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(p1);
    await upsertProfile(p2);
    const store = await setActiveProfile(p2.id);
    expect(store.slots.primary).toBe(p2.id);
  });
});

/* ───────── legacy migration ───────── */

describe('legacy-shape migration on read', () => {
  it('migrates activeId → slots.primary', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        activeId: 'real',
        profiles: [{ ...makeProfile({ id: 'real', apiKey: 'sk-real' }) }],
      },
    });
    const store = await loadProfiles();
    expect(store.slots.primary).toBe('real');
    expect((await loadLlmConfig()).apiKey).toBe('sk-real');
  });

  it('DROPS the old per-profile vision:true flag (does NOT auto-assign the vision slot)', async () => {
    // The old flag meant "this model is multimodal" (a capability), not "use it
    // for vision" (an assignment) — auto-assigning surprised users splitting
    // vision onto a dedicated model. The vision slot is assigned explicitly.
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        activeId: 'a',
        profiles: [
          { ...makeProfile({ id: 'a', apiKey: 'sk-a' }), vision: true },
          { ...makeProfile({ id: 'b', apiKey: 'sk-b' }) },
        ],
      },
    });
    const store = await loadProfiles();
    expect(store.slots.primary).toBe('a');
    expect(store.slots.vision).toBeUndefined();
  });

  it('migrates discriminated-union api shape (mode:"api", ...) into a primary profile', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        mode: 'api',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-old',
        model: 'deepseek-chat',
      },
    });
    expect(await loadLlmConfig()).toEqual({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-old',
      model: 'deepseek-chat',
    });
    const store = await loadProfiles();
    expect(store.profiles).toHaveLength(1);
    expect(store.slots.primary).toBe(store.profiles[0]!.id);
  });

  it('legacy connector-only shape falls back to empty store', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { mode: 'connector', chatbot: 'deepseek' },
    });
    expect(await loadLlmConfig()).toEqual(DEFAULT_CONFIG);
    const store = await loadProfiles();
    expect(store.profiles).toHaveLength(0);
    expect(store.slots.primary).toBeUndefined();
  });

  it('preserves an explicit slots map across save+load', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a', label: 'work' });
    const p2 = makeProfile({ provider: 'openai', apiKey: 'sk-b', label: 'vis' });
    await upsertProfile(p1);
    await upsertProfile(p2);
    await setSlot('vision', p2.id);
    const store = await loadProfiles();
    expect(store.slots.primary).toBe(p1.id);
    expect(store.slots.vision).toBe(p2.id);
    expect(store.profiles).toHaveLength(2);
  });
});

describe('autoLabel', () => {
  it('uses the provider preset label when available', () => {
    expect(
      autoLabel({ provider: 'deepseek', baseUrl: 'x', apiKey: 'x', model: 'deepseek-chat' }),
    ).toBe('DeepSeek · deepseek-chat');
  });

  it('falls back to provider id for custom presets and omits model when absent', () => {
    expect(autoLabel({ provider: 'my-provider', baseUrl: 'x', apiKey: 'x', model: '' })).toBe(
      'my-provider',
    );
  });
});
