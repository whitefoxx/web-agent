/**
 * llm-config dual-branch storage — locks in the "API key survives a
 * connector-mode save then a mode toggle" bug fix (see issue surfaced
 * 2026-05-31). Pre-fix, saving connector clobbered the API branch in
 * storage; now both branches are always persisted, with `mode` selecting
 * which one is active.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLlmConfig,
  loadLlmConfigForm,
  saveLlmConfig,
  persistLlmConfigDraft,
} from '../src/config/llm-config';

const STORAGE_KEY = 'webchat_llm_config';

/** Inline chrome.storage.local stub — enough surface for llm-config's calls.
 * Reset between tests via the `_reset()` helper. */
function makeStorageStub(): {
  install: () => void;
  reset: () => void;
  inspect: () => Record<string, unknown>;
} {
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
    inspect() {
      return data;
    },
  };
}

const stub = makeStorageStub();
stub.install();

beforeEach(() => {
  stub.reset();
});

describe('loadLlmConfig (active branch projection)', () => {
  it('returns connector default when nothing is stored', async () => {
    const c = await loadLlmConfig();
    expect(c).toEqual({ mode: 'connector', chatbot: 'deepseek' });
  });

  it('returns the active branch from the new dual-storage shape', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        mode: 'api',
        connector: { chatbot: 'deepseek' },
        api: {
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4o',
        },
      },
    });
    const c = await loadLlmConfig();
    expect(c).toEqual({
      mode: 'api',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });
  });

  it('migrates the legacy connector-only shape', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { mode: 'connector', chatbot: 'deepseek' },
    });
    const c = await loadLlmConfig();
    expect(c).toEqual({ mode: 'connector', chatbot: 'deepseek' });
  });

  it('migrates the legacy api-only shape', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        mode: 'api',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-old',
        model: 'deepseek-chat',
      },
    });
    const c = await loadLlmConfig();
    expect(c).toMatchObject({ mode: 'api', apiKey: 'sk-old', model: 'deepseek-chat' });
  });
});

describe('saveLlmConfig — preserves the inactive branch on disk', () => {
  it('saving connector keeps the previously-saved API credentials', async () => {
    // 1. User saves API config first.
    await saveLlmConfig({
      mode: 'api',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-keep-me',
      model: 'gpt-4o',
    });
    // 2. User switches to connector mode and saves.
    await saveLlmConfig({ mode: 'connector', chatbot: 'deepseek' });

    // Active config is now connector.
    expect(await loadLlmConfig()).toEqual({ mode: 'connector', chatbot: 'deepseek' });

    // But the form view still sees the saved API key — that's the whole
    // point of dual-branch storage.
    const form = await loadLlmConfigForm();
    expect(form.mode).toBe('connector');
    expect(form.api.apiKey).toBe('sk-keep-me');
    expect(form.api.model).toBe('gpt-4o');
    expect(form.api.provider).toBe('openai');
  });

  it('saving api keeps a previously-saved chatbot pick', async () => {
    await saveLlmConfig({ mode: 'connector', chatbot: 'chatgpt' });
    await saveLlmConfig({
      mode: 'api',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-new',
      model: 'deepseek-chat',
    });

    const form = await loadLlmConfigForm();
    expect(form.mode).toBe('api');
    expect(form.connector.chatbot).toBe('chatgpt');
    expect(form.api.apiKey).toBe('sk-new');
  });

  it('round-trip the same active branch twice → no data loss', async () => {
    const apiCfg = {
      mode: 'api' as const,
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'sk-k',
      model: 'kimi-k2',
    };
    await saveLlmConfig(apiCfg);
    await saveLlmConfig(apiCfg);
    expect(await loadLlmConfig()).toEqual(apiCfg);
  });
});

describe('loadLlmConfigForm — seeds defaults for any branch the user never touched', () => {
  it('cold-start: both branches have placeholder defaults', async () => {
    const form = await loadLlmConfigForm();
    expect(form.mode).toBe('connector');
    expect(form.connector.chatbot).toBe('deepseek');
    expect(form.api.provider).toBe('deepseek');
    expect(form.api.apiKey).toBe('');
    expect(form.api.baseUrl).toMatch(/api\.deepseek\.com/);
  });

  it('legacy api-only storage → connector branch gets default', async () => {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        mode: 'api',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-legacy',
        model: 'gpt-4o',
      },
    });
    const form = await loadLlmConfigForm();
    expect(form.connector.chatbot).toBe('deepseek');
    expect(form.api.apiKey).toBe('sk-legacy');
  });
});

describe('persistLlmConfigDraft — flushes mid-edit values without changing active mode', () => {
  it('persists an api draft without flipping the active mode', async () => {
    await saveLlmConfig({ mode: 'connector', chatbot: 'deepseek' });
    await persistLlmConfigDraft({
      api: {
        provider: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'sk-draft',
        model: 'glm-4-plus',
      },
    });
    // Active still connector.
    expect(await loadLlmConfig()).toEqual({ mode: 'connector', chatbot: 'deepseek' });
    // But the api draft is on disk.
    const form = await loadLlmConfigForm();
    expect(form.api.apiKey).toBe('sk-draft');
    expect(form.api.provider).toBe('glm');
  });
});
