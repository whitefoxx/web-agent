import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  referencedEnvNames,
  scopeAllows,
  resolveEnvForSource,
  substitutePlaceholders,
  redactSecrets,
  toSecretInfos,
  isValidSecretName,
  saveSecret,
  loadSecrets,
  renameSecret,
  invalidateSecretsCache,
  type SecretMap,
} from '../src/config/secret-store';

const KEY = 'wrk-EXAMPLE-0123456789';
const map: SecretMap = {
  WEREAD_API_KEY: { value: KEY, updatedAt: 1 },
  SCOPED_TOKEN: { value: 'scoped-secret-value', scope: ['weread*'], updatedAt: 2 },
};

describe('isValidSecretName', () => {
  it('accepts env-style identifiers, rejects junk', () => {
    expect(isValidSecretName('WEREAD_API_KEY')).toBe(true);
    expect(isValidSecretName('$x')).toBe(true);
    expect(isValidSecretName('1ABC')).toBe(false);
    expect(isValidSecretName('has-dash')).toBe(false);
    expect(isValidSecretName('')).toBe(false);
  });
});

describe('referencedEnvNames', () => {
  it('finds dot and bracket forms, dedups', () => {
    const src = `
      const k = process.env.WEREAD_API_KEY;
      const j = process.env['OTHER_TOKEN'];
      const again = process.env.WEREAD_API_KEY;
      const d = process.env["DQ_NAME"];
    `;
    expect(referencedEnvNames(src).sort()).toEqual(
      ['DQ_NAME', 'OTHER_TOKEN', 'WEREAD_API_KEY'].sort(),
    );
  });
  it('does NOT match destructuring (least-privilege)', () => {
    expect(referencedEnvNames('const { WEREAD_API_KEY } = process.env;')).toEqual([]);
  });
  it('returns empty for source with no env reads', () => {
    expect(referencedEnvNames('const x = 1 + 2;')).toEqual([]);
  });
});

describe('scopeAllows', () => {
  it('no scope → any site', () => {
    expect(scopeAllows({ value: 'v', updatedAt: 0 }, 'anything')).toBe(true);
  });
  it('exact and glob match; otherwise deny', () => {
    expect(
      scopeAllows({ value: 'v', scope: ['weread-official'], updatedAt: 0 }, 'weread-official'),
    ).toBe(true);
    expect(scopeAllows({ value: 'v', scope: ['weread*'], updatedAt: 0 }, 'weread-official')).toBe(
      true,
    );
    expect(scopeAllows({ value: 'v', scope: ['weread*'], updatedAt: 0 }, 'douyin')).toBe(false);
    expect(scopeAllows({ value: 'v', scope: ['notebooklm'], updatedAt: 0 }, 'weread')).toBe(false);
  });
});

describe('resolveEnvForSource', () => {
  it('injects only referenced names whose scope allows the site', () => {
    const src = 'const k = process.env.WEREAD_API_KEY; const s = process.env.SCOPED_TOKEN;';
    // weread-official: WEREAD_API_KEY (no scope) + SCOPED_TOKEN (weread* allows it)
    expect(resolveEnvForSource(src, 'weread-official', map)).toEqual({
      WEREAD_API_KEY: KEY,
      SCOPED_TOKEN: 'scoped-secret-value',
    });
    // douyin: SCOPED_TOKEN scope denies it → only WEREAD_API_KEY
    expect(resolveEnvForSource(src, 'douyin', map)).toEqual({ WEREAD_API_KEY: KEY });
  });
  it('does not inject a referenced name that has no secret', () => {
    expect(resolveEnvForSource('process.env.UNSET_THING', 'x', map)).toEqual({});
  });
  it('does not inject a secret the source never references', () => {
    expect(resolveEnvForSource('const x = 1;', 'weread-official', map)).toEqual({});
  });
});

describe('substitutePlaceholders', () => {
  it('replaces whole-string and embedded tokens, deep', () => {
    const { value, used, missing } = substitutePlaceholders(
      {
        auth: '{{secret:WEREAD_API_KEY}}',
        header: 'Bearer {{secret:WEREAD_API_KEY}}',
        nested: { arr: ['{{ secret:SCOPED_TOKEN }}', 'plain'] },
        n: 42,
      },
      map,
    );
    expect(value).toEqual({
      auth: KEY,
      header: `Bearer ${KEY}`,
      nested: { arr: ['scoped-secret-value', 'plain'] },
      n: 42,
    });
    expect(used.sort()).toEqual(['SCOPED_TOKEN', 'WEREAD_API_KEY']);
    expect(missing).toEqual([]);
  });
  it('leaves unknown names verbatim and reports them missing', () => {
    const { value, used, missing } = substitutePlaceholders({ x: '{{secret:NOPE}}' }, map);
    expect(value).toEqual({ x: '{{secret:NOPE}}' });
    expect(used).toEqual([]);
    expect(missing).toEqual(['NOPE']);
  });
  it('is a no-op for strings without a token', () => {
    expect(substitutePlaceholders({ a: 'hello', b: 1 }, map).value).toEqual({ a: 'hello', b: 1 });
  });
});

describe('redactSecrets', () => {
  it('scrubs known values deep, including embedded', () => {
    const out = redactSecrets(
      {
        msg: `invalid key ${KEY} supplied`,
        list: [{ deep: KEY }, 'scoped-secret-value'],
        safe: 'nothing here',
      },
      map,
    );
    expect(out).toEqual({
      msg: 'invalid key «WEREAD_API_KEY» supplied',
      list: [{ deep: '«WEREAD_API_KEY»' }, '«SCOPED_TOKEN»'],
      safe: 'nothing here',
    });
  });
  it('skips trivially-short values to avoid soup', () => {
    const tiny: SecretMap = { A: { value: 'ab', updatedAt: 0 } };
    expect(redactSecrets('ab cab dab', tiny)).toBe('ab cab dab');
  });
  it('returns input unchanged when no secrets', () => {
    expect(redactSecrets('plain', {})).toBe('plain');
  });
});

describe('stateful store ops (mocked chrome.storage)', () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          async get(k: string) {
            return k in store ? { [k]: store[k] } : {};
          },
          async set(obj: Record<string, unknown>) {
            Object.assign(store, obj);
          },
        },
        onChanged: { addListener() {} },
      },
    };
    invalidateSecretsCache();
  });
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    invalidateSecretsCache();
  });

  it('save → load round-trips under one storage key', async () => {
    await saveSecret('WEREAD_API_KEY', { value: 'wrk-abc-123456' });
    expect(Object.keys(store)).toEqual(['web:secrets']);
    const m = await loadSecrets();
    expect(m.WEREAD_API_KEY?.value).toBe('wrk-abc-123456');
  });

  it('renameSecret carries the value over and drops the old key', async () => {
    await saveSecret('WEREAD_APITOKEN', { value: 'wrk-xyz-7890', note: 'weread' });
    await renameSecret('WEREAD_APITOKEN', 'WEREAD_API_KEY', { note: 'weread' });
    const m = await loadSecrets();
    expect(m.WEREAD_APITOKEN).toBeUndefined();
    expect(m.WEREAD_API_KEY?.value).toBe('wrk-xyz-7890'); // value carried, never re-entered
    expect(m.WEREAD_API_KEY?.note).toBe('weread');
  });

  it('renameSecret rejects a collision without clobbering', async () => {
    await saveSecret('A_KEY', { value: 'aaa-111111' });
    await saveSecret('B_KEY', { value: 'bbb-222222' });
    await expect(renameSecret('A_KEY', 'B_KEY', {})).rejects.toThrow(/already exists/);
    const m = await loadSecrets();
    expect(m.A_KEY?.value).toBe('aaa-111111');
    expect(m.B_KEY?.value).toBe('bbb-222222');
  });

  it('renameSecret to the same name just updates meta', async () => {
    await saveSecret('X_KEY', { value: 'xxx-333333', note: 'old' });
    await renameSecret('X_KEY', 'X_KEY', { note: 'new' });
    const m = await loadSecrets();
    expect(m.X_KEY?.value).toBe('xxx-333333');
    expect(m.X_KEY?.note).toBe('new');
  });
});

describe('toSecretInfos', () => {
  it('strips the value, keeps metadata, sorted by name', () => {
    const infos = toSecretInfos(map);
    expect(infos.map((i) => i.name)).toEqual(['SCOPED_TOKEN', 'WEREAD_API_KEY']);
    expect(infos[0]).toEqual({
      name: 'SCOPED_TOKEN',
      scope: ['weread*'],
      note: undefined,
      updatedAt: 2,
      hasValue: true,
    });
    // critically: no `value` field anywhere
    expect(JSON.stringify(infos)).not.toContain(KEY);
    expect(JSON.stringify(infos)).not.toContain('scoped-secret-value');
  });
});
