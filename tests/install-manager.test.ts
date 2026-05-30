/**
 * install-manager core logic. IndexedDB no-ops in node (best-effort store), so
 * these exercise the classification + registry-registration paths, which is
 * where the real logic lives. Persistence is covered structurally by reusing
 * the session-store-proven IDB pattern.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyKind,
  isRunnableNow,
  installFromCaptured,
  uninstall,
} from '../src/adapters/install-manager';
import { findAdapter, unregister } from '../src/runtime/registry.js';
import type { CapturedDef } from '../src/adapters/installed-store';

const pipelineDef = (site: string, name: string): CapturedDef => ({
  site,
  name,
  access: 'read',
  description: 'p',
  kind: 'pipeline',
  hasFunc: false,
  pipeline: [{ fetch: { url: 'https://x/y.json' } }, { map: { v: '${{ item }}' } }],
});

const funcDef = (site: string, name: string): CapturedDef => ({
  site,
  name,
  access: 'read',
  description: 'f',
  kind: 'func',
  hasFunc: true,
});

describe('classifyKind', () => {
  it('single-kind sources', () => {
    expect(classifyKind([pipelineDef('a', 'x')])).toBe('pipeline');
    expect(classifyKind([funcDef('a', 'x')])).toBe('func');
    expect(classifyKind([])).toBe('unknown');
  });
  it('mixed pipeline+func', () => {
    expect(classifyKind([pipelineDef('a', 'x'), funcDef('a', 'y')])).toBe('mixed');
  });
});

describe('isRunnableNow', () => {
  it('valid pipeline def is runnable', () => {
    expect(isRunnableNow(pipelineDef('a', 'x'))).toBe(true);
  });
  it('func def is NOT runnable in Phase A', () => {
    expect(isRunnableNow(funcDef('a', 'x'))).toBe(false);
  });
  it('pipeline-kind but empty/invalid pipeline is not runnable', () => {
    expect(isRunnableNow({ ...pipelineDef('a', 'x'), pipeline: [] })).toBe(false);
    expect(isRunnableNow({ ...pipelineDef('a', 'x'), pipeline: [{ frobnicate: {} }] })).toBe(false);
  });
});

describe('installFromCaptured → registry wiring', () => {
  beforeEach(() => {
    // clean any leftovers from prior runs
    for (const s of ['inst', 'instmix']) {
      unregister(s, 'one');
      unregister(s, 'two');
    }
  });

  it('registers a pipeline def so the dispatcher can find it', async () => {
    const r = await installFromCaptured(
      { source: 'src', defs: [pipelineDef('inst', 'one')], origin: { type: 'manual' } },
      1_000,
    );
    expect(r.ok).toBe(true);
    expect(r.id).toBe('inst/one');
    expect(r.registered).toBe(1);
    expect(r.deferredFunc).toBe(0);
    expect(r.deferredUnsupported).toBe(0);
    const found = findAdapter('inst', 'one');
    expect(found).toBeTruthy();
    expect((found as { _installed?: boolean })._installed).toBe(true);
  });

  it('a mixed source registers pipeline defs and defers func defs (deferredFunc)', async () => {
    const r = await installFromCaptured(
      {
        source: 'src',
        defs: [pipelineDef('instmix', 'one'), funcDef('instmix', 'two')],
        origin: { type: 'manual' },
      },
      2_000,
    );
    expect(r.ok).toBe(true);
    expect(r.registered).toBe(1); // only the pipeline one
    expect(r.deferredFunc).toBe(1); // the func one
    expect(r.deferredUnsupported).toBe(0);
    expect(findAdapter('instmix', 'one')).toBeTruthy();
    expect(findAdapter('instmix', 'two')).toBeUndefined(); // func not registered in Phase A
  });

  it('counts a pipeline using an unsupported step as deferredUnsupported (not deferredFunc)', async () => {
    // `click` is a real opencli step type but we don't implement it yet.
    // Should be reported distinctly from func/Phase B so the user knows it's
    // a missing engine feature, not pending the func runner.
    const unsupported: CapturedDef = {
      site: 'instu',
      name: 'one',
      access: 'read',
      description: 'p',
      kind: 'pipeline',
      hasFunc: false,
      pipeline: [{ fetch: { url: 'x' } }, { click: '#btn' } as unknown as Record<string, unknown>],
    };
    const r = await installFromCaptured(
      { source: 'src', defs: [unsupported], origin: { type: 'manual' } },
      2_500,
    );
    expect(r.ok).toBe(true);
    expect(r.registered).toBe(0);
    expect(r.deferredUnsupported).toBe(1);
    expect(r.deferredFunc).toBe(0);
    expect(findAdapter('instu', 'one')).toBeUndefined();
  });

  it('rejects an empty capture', async () => {
    const r = await installFromCaptured({ source: '', defs: [], origin: { type: 'manual' } }, 3_000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no adapter/);
  });

  it('uninstall unregisters the def', async () => {
    await installFromCaptured(
      { source: 'src', defs: [pipelineDef('inst', 'one')], origin: { type: 'manual' } },
      4_000,
    );
    expect(findAdapter('inst', 'one')).toBeTruthy();
    await uninstall('inst/one');
    expect(findAdapter('inst', 'one')).toBeUndefined();
  });
});
