/**
 * runExternalTool — the SHARED external-call executor in bridge-client, used by
 * BOTH the WS bridge and the web-app Port bridge (external-mcp). These tests run
 * the REAL module (no mock) to pin the single copy of the gating logic:
 * 允许外部写操作 blocks control-tool writes AND registry write adapters, the
 * per-site deny list blocks writes even with the switch on, reads pass, and
 * unknown tools fail with tool-not-found. external-mcp's own tests mock this
 * module and only cover the plumbing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExternalTool, isExternalTool, setBridgeEnabled } from '../src/background/bridge-client';
import { cli } from '@base/runtime/registry.js';

function chromeStub(): void {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k?: string | string[]) => {
          if (typeof k === 'string') return { [k]: store[k] };
          if (Array.isArray(k)) return Object.fromEntries(k.map((x) => [x, store[x]]));
          return { ...store };
        },
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    runtime: { getManifest: () => ({ version: 'test' }), lastError: undefined },
  });
}

// One registry write adapter to exercise the adapter branch of the gate. cli()
// registration is process-global; a unique site avoids clashing with other suites.
cli({
  site: 'gatetest',
  name: 'poke',
  access: 'write',
  description: 'write adapter for gate tests',
  func: async () => 'wrote',
});

beforeEach(() => {
  vi.useFakeTimers(); // keep scheduleBridgeReap's 10s timer from firing post-teardown
  chromeStub();
});

afterEach(async () => {
  await setBridgeEnabled(false, undefined, true, []); // restore defaults for the next test
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('写开关(允许外部写操作)— 同一份判定服务 WS 桥与 Port 桥', () => {
  it('blocks a synthetic control write tool when writes are disabled', async () => {
    await setBridgeEnabled(false, undefined, false, []);
    const r = await runExternalTool('save_memory', { fact: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('External write operations are disabled');
  });

  it('blocks a registry write adapter when writes are disabled', async () => {
    await setBridgeEnabled(false, undefined, false, []);
    const r = await runExternalTool('gatetest__poke', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('External write operations are disabled');
  });

  it('blocks a deny-listed site even with writes enabled', async () => {
    await setBridgeEnabled(false, undefined, true, ['gatetest']);
    const r = await runExternalTool('gatetest__poke', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gatetest');
    expect(r.error).toContain('blocked');
  });

  it('lets a control write through when writes are enabled', async () => {
    await setBridgeEnabled(false, undefined, true, []);
    const r = await runExternalTool('create_shortcut', { label: 'l', text: 't' });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ saved: 'l' });
  });

  it('read-class control tools work regardless of the write switch', async () => {
    await setBridgeEnabled(false, undefined, false, []);
    const r = await runExternalTool('list_shortcuts', {});
    expect(r.ok).toBe(true);
  });

  it('fails an unknown tool with tool-not-found', async () => {
    const r = await runExternalTool('nope__missing', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('tool not found');
  });
});

describe('isExternalTool', () => {
  it('recognizes control tools and registered adapters, rejects the rest', () => {
    expect(isExternalTool('save_memory')).toBe(true);
    expect(isExternalTool('gatetest__poke')).toBe(true);
    expect(isExternalTool('web_task')).toBe(false); // web_task is external-mcp's own, not the executor's
    expect(isExternalTool('nope__missing')).toBe(false);
  });
});
