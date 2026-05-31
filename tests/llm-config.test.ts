/**
 * llm-config — single-branch storage + migration from legacy shapes.
 *
 * Pre-history: this file used to lock in a dual-branch storage hack so a
 * connector-mode save didn't clobber the api branch. The connector mode is
 * gone, so the only thing left to verify is the legacy-shape migration path
 * (so existing installs don't lose their saved API credentials when they
 * upgrade to the api-only build).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadLlmConfig, saveLlmConfig, DEFAULT_CONFIG } from '../src/config/llm-config';

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

describe('loadLlmConfig', () => {
  it('returns the empty defaults when nothing is stored', async () => {
    const c = await loadLlmConfig();
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(c.apiKey).toBe(''); // explicit: not a working default
  });

  it('round-trips a saved api config', async () => {
    const cfg = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    };
    await saveLlmConfig(cfg);
    expect(await loadLlmConfig()).toEqual(cfg);
  });

  it('migrates the legacy discriminated-union api shape', async () => {
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
  });

  it('migrates the dual-branch transitional shape (adopts the api branch)', async () => {
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

  it('legacy connector-only shape falls back to defaults (no api creds to recover)', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { mode: 'connector', chatbot: 'deepseek' },
    });
    expect(await loadLlmConfig()).toEqual(DEFAULT_CONFIG);
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
    // Second load goes through the current-shape branch directly.
    expect(await loadLlmConfig()).toEqual({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-new',
      model: 'deepseek-chat',
    });
  });
});
