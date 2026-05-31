/**
 * llm-config — multi-profile storage + migration from legacy shapes.
 *
 * Two surfaces:
 *  - `loadLlmConfig` / `saveLlmConfig` — legacy single-config API consumed by
 *    api-engine. Resolves the active profile (or treats as "update active /
 *    create first" on save).
 *  - `loadProfiles` / `upsertProfile` / `deleteProfile` / `setActiveProfile` —
 *    new multi-profile manager API consumed by the SidePanel UI.
 *
 * Pre-history: this file used to verify a dual-branch storage hack so a
 * removed connector-mode save didn't clobber the api branch. The legacy
 * migrations (dual-branch + discriminated-union shapes) still need to roll
 * forward so upgrading users don't lose their saved API credentials.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLlmConfig,
  saveLlmConfig,
  loadProfiles,
  upsertProfile,
  deleteProfile,
  setActiveProfile,
  newProfileId,
  autoLabel,
  DEFAULT_CONFIG,
  type LlmProfile,
} from '../src/config/llm-config';

const STORAGE_KEY = 'webchat_llm_config';

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

/* ───────── legacy single-config surface (consumed by api-engine) ───────── */

describe('loadLlmConfig (active-profile resolver)', () => {
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

  it('save creates the first profile when the store is empty', async () => {
    await saveLlmConfig({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-1',
      model: 'deepseek-chat',
    });
    const store = await loadProfiles();
    expect(store.profiles).toHaveLength(1);
    expect(store.activeId).toBe(store.profiles[0]!.id);
  });

  it('save mutates the active profile in place (no duplicate entries)', async () => {
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
    expect(store.profiles[0]!.provider).toBe('deepseek');
  });
});

/* ───────── legacy migration paths ───────── */

describe('legacy-shape migration on read', () => {
  it('migrates discriminated-union api shape (mode:"api", ...)', async () => {
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
    expect(store.profiles[0]!.apiKey).toBe('sk-old');
  });

  it('migrates dual-branch transitional shape (adopts the api branch)', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        mode: 'connector',
        connector: { chatbot: 'deepseek' },
        api: {
          provider: 'kimi',
          baseUrl: 'https://api.moonshot.cn/v1',
          apiKey: 'sk-from-dual',
          model: 'kimi-k2',
        },
      },
    });
    const c = await loadLlmConfig();
    expect(c.apiKey).toBe('sk-from-dual');
    expect(c.provider).toBe('kimi');
    expect(c.model).toBe('kimi-k2');
  });

  it('migrates pre-multi-profile single shape (just {provider, baseUrl, apiKey, model})', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        provider: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'sk-glm',
        model: 'glm-4-plus',
      },
    });
    const c = await loadLlmConfig();
    expect(c.apiKey).toBe('sk-glm');
    expect(c.provider).toBe('glm');
    const store = await loadProfiles();
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]!.label).toContain('GLM');
  });

  it('legacy connector-only shape falls back to empty store (no api creds to recover)', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { mode: 'connector', chatbot: 'deepseek' },
    });
    expect(await loadLlmConfig()).toEqual(DEFAULT_CONFIG);
    const store = await loadProfiles();
    expect(store.profiles).toHaveLength(0);
    expect(store.activeId).toBe('');
  });

  it('save overwrites previously-stored legacy shape with the current shape', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        mode: 'api',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-legacy',
        model: 'gpt-4o',
      },
    });
    await saveLlmConfig({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-new',
      model: 'deepseek-chat',
    });
    expect(await loadLlmConfig()).toEqual({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-new',
      model: 'deepseek-chat',
    });
  });
});

/* ───────── multi-profile manager surface ───────── */

function makeProfile(overrides: Partial<LlmProfile> = {}): LlmProfile {
  const cfg = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-1',
    model: 'deepseek-chat',
  };
  return {
    id: newProfileId(),
    label: autoLabel(cfg),
    ...cfg,
    ...overrides,
  };
}

describe('upsertProfile', () => {
  it('inserts a new profile and activates it when store is empty', async () => {
    const p = makeProfile();
    const store = await upsertProfile(p);
    expect(store.profiles).toEqual([p]);
    expect(store.activeId).toBe(p.id);
  });

  it('adds a second profile WITHOUT switching active by default', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ provider: 'openai', apiKey: 'sk-b' });
    await upsertProfile(p1);
    const store = await upsertProfile(p2);
    expect(store.profiles).toHaveLength(2);
    expect(store.activeId).toBe(p1.id);
  });

  it('promotes the upserted profile to active when activate:true', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ provider: 'openai', apiKey: 'sk-b' });
    await upsertProfile(p1);
    const store = await upsertProfile(p2, { activate: true });
    expect(store.activeId).toBe(p2.id);
  });

  it('updates an existing profile in place when ids match', async () => {
    const p = makeProfile({ apiKey: 'sk-old', label: 'My Key' });
    await upsertProfile(p);
    const updated = { ...p, apiKey: 'sk-new', label: 'My Key (rotated)' };
    const store = await upsertProfile(updated);
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0]!.apiKey).toBe('sk-new');
    expect(store.profiles[0]!.label).toBe('My Key (rotated)');
  });
});

describe('deleteProfile', () => {
  it('removes the profile; picks the first remaining as active if the deleted one was active', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(p1);
    await upsertProfile(p2);
    await setActiveProfile(p2.id);
    const store = await deleteProfile(p2.id);
    expect(store.profiles.map((p) => p.id)).toEqual([p1.id]);
    expect(store.activeId).toBe(p1.id);
  });

  it('clears activeId when the last profile is deleted', async () => {
    const p = makeProfile();
    await upsertProfile(p);
    const store = await deleteProfile(p.id);
    expect(store.profiles).toHaveLength(0);
    expect(store.activeId).toBe('');
  });

  it('leaves activeId alone when an inactive profile is deleted', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(p1);
    await upsertProfile(p2);
    // p1 stays active by default; delete p2.
    const store = await deleteProfile(p2.id);
    expect(store.activeId).toBe(p1.id);
    expect(store.profiles).toHaveLength(1);
  });
});

describe('setActiveProfile', () => {
  it('switches activeId to a known profile', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a' });
    const p2 = makeProfile({ apiKey: 'sk-b' });
    await upsertProfile(p1);
    await upsertProfile(p2);
    const store = await setActiveProfile(p2.id);
    expect(store.activeId).toBe(p2.id);
  });

  it('ignores unknown ids', async () => {
    const p = makeProfile();
    await upsertProfile(p);
    const store = await setActiveProfile('bogus');
    expect(store.activeId).toBe(p.id);
  });
});

describe('autoLabel', () => {
  it('uses the provider preset label when available', () => {
    expect(
      autoLabel({
        provider: 'deepseek',
        baseUrl: 'x',
        apiKey: 'x',
        model: 'deepseek-chat',
      }),
    ).toBe('DeepSeek · deepseek-chat');
  });

  it('falls back to provider id for custom presets and omits model when absent', () => {
    expect(
      autoLabel({
        provider: 'my-provider',
        baseUrl: 'x',
        apiKey: 'x',
        model: '',
      }),
    ).toBe('my-provider');
  });
});

describe('multi-profile shape round-trips', () => {
  it('preserves activeId and all profiles across save+load', async () => {
    const p1 = makeProfile({ apiKey: 'sk-a', label: 'work' });
    const p2 = makeProfile({ provider: 'openai', apiKey: 'sk-b', label: 'personal' });
    await upsertProfile(p1);
    await upsertProfile(p2, { activate: true });
    const store = await loadProfiles();
    expect(store.activeId).toBe(p2.id);
    expect(store.profiles).toHaveLength(2);
    expect(store.profiles.find((p) => p.id === p1.id)!.label).toBe('work');
  });

  it('drops the activeId pointer if the referenced profile is missing on load', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        activeId: 'ghost',
        profiles: [
          {
            id: 'real',
            label: 'Real',
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-real',
            model: 'deepseek-chat',
          },
        ],
      },
    });
    const store = await loadProfiles();
    expect(store.activeId).toBe('real');
  });
});
