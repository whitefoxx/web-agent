/**
 * Regression guard for adapter-hot-plug §10.18: the runtime func-execution
 * scope must inject the REAL opencli utils, REAL error classes, and a real
 * `log` — not the identity/empty stubs the runtime scope used to carry.
 *
 * These assertions run an adapter source through the same eval path the
 * extension uses in-page (evalAdapterKeepingFuncs), so a future refactor that
 * reintroduces stubs fails here instead of silently shipping wrong output.
 */
import { describe, expect, it } from 'vitest';
import { evalAdapterKeepingFuncs } from '../src/userscript/run-in-page';
import { AuthRequiredError, EmptyResultError } from '@base/runtime/errors.js';
import { buildAdapterScope } from '../src/runtime/adapter-scope';

/** Build a minimal adapter source string that imports a name and uses it in
 * its func, so we exercise strip-and-inject the same way a real adapter does. */
function adapterSrc(body: string, imports: string): string {
  return `
import { cli, Strategy } from '@jackwener/opencli/registry';
${imports}
cli({
  site: 'test',
  name: 'probe',
  access: 'read',
  func: async (page, kwargs) => {
    ${body}
  },
});
`;
}

async function runFunc(src: string, kwargs: Record<string, unknown> = {}): Promise<unknown> {
  const defs = evalAdapterKeepingFuncs(src);
  const def = defs.find((d) => d.site === 'test' && d.name === 'probe');
  const func = def?.func as (p: unknown, k: unknown) => Promise<unknown>;
  return func({}, kwargs);
}

describe('adapter runtime scope (§10.18)', () => {
  it('htmlToMarkdown actually converts HTML (not identity stub)', async () => {
    const out = (await runFunc(
      adapterSrc(
        `return htmlToMarkdown('<h1>Title</h1><p>hello <strong>world</strong></p>');`,
        `import { htmlToMarkdown } from '@jackwener/opencli/utils';`,
      ),
    )) as string;
    // Real turndown output: ATX heading + bold markers. The old stub returned
    // the raw HTML verbatim, which would still contain '<h1>'.
    expect(out).toContain('# Title');
    expect(out).toContain('**world**');
    expect(out).not.toContain('<h1>');
  });

  it('mapConcurrent actually maps (not empty-array stub)', async () => {
    const out = (await runFunc(
      adapterSrc(
        `return await mapConcurrent([1, 2, 3], 2, async (n) => n * 10);`,
        `import { mapConcurrent } from '@jackwener/opencli/utils';`,
      ),
    )) as number[];
    expect(out).toEqual([10, 20, 30]);
  });

  it('thrown AuthRequiredError is instanceof the real dispatcher-recognized class', async () => {
    const p = runFunc(
      adapterSrc(
        `throw new AuthRequiredError('example.com', 'please log in');`,
        `import { AuthRequiredError } from '@jackwener/opencli/errors';`,
      ),
    );
    await expect(p).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('thrown EmptyResultError is the real class (dispatcher maps via instanceof)', async () => {
    const p = runFunc(
      adapterSrc(
        `throw new EmptyResultError('test probe', 'nothing here');`,
        `import { EmptyResultError } from '@jackwener/opencli/errors';`,
      ),
    );
    await expect(p).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('log is injected with .info/.warn/.error (not undefined)', async () => {
    const out = (await runFunc(
      adapterSrc(
        `log.info('probe ran'); log.warn('careful'); return typeof log.error;`,
        `import { log } from '@jackwener/opencli/logger';`,
      ),
    )) as string;
    expect(out).toBe('function');
  });

  it('createMarkdownConverter is present in the runtime scope', async () => {
    const out = (await runFunc(
      adapterSrc(
        `const td = createMarkdownConverter(); return typeof td.turndown;`,
        `import { createMarkdownConverter } from '@jackwener/opencli/utils';`,
      ),
    )) as string;
    expect(out).toBe('function');
  });

  it('buildAdapterScope exposes the full injected name set', () => {
    const scope = buildAdapterScope(() => {});
    for (const name of [
      'cli',
      'Strategy',
      'htmlToMarkdown',
      'createMarkdownConverter',
      'mapConcurrent',
      'throwIfLoginWall',
      'parseJsonOrThrowLoginWall',
      'log',
      'AuthRequiredError',
      'EmptyResultError',
      'RateLimitedError',
      'CommandExecutionError',
      'ArgumentError',
      '__nodeShim',
    ]) {
      expect(scope[name], `missing ${name}`).toBeDefined();
    }
  });
});
