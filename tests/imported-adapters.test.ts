/**
 * Consistency checks on adapter files imported from opencli via
 * scripts/import-adapter.mjs. These guard against regressions in the
 * import script and accidental hand-edits that re-introduce opencli deps.
 */

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const adapterDir = join(here, '..', 'src', 'tools', 'xiaohongshu');

describe('imported adapter files', () => {
  it('contain no @jackwener/opencli imports', async () => {
    const files = (await readdir(adapterDir)).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = await readFile(join(adapterDir, f), 'utf8');
      expect(text, `${f} still references @jackwener/opencli`).not.toMatch(/@jackwener\/opencli/);
    }
  });

  it('contain no Node-only imports that would break in the browser', async () => {
    const files = (await readdir(adapterDir)).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const text = await readFile(join(adapterDir, f), 'utf8');
      expect(text, `${f} imports node:fs (browser-incompatible)`).not.toMatch(
        /\bfrom\s+['"]node:fs\b/,
      );
      expect(text, `${f} imports node:path`).not.toMatch(/\bfrom\s+['"]node:path\b/);
      expect(text, `${f} imports node:child_process`).not.toMatch(
        /\bfrom\s+['"]node:child_process\b/,
      );
    }
  });
});

describe('_all.ts manifest', () => {
  it('imports every non-helper adapter file', async () => {
    const indexText = await readFile(join(adapterDir, '_all.ts'), 'utf8');
    const adapterFiles = (await readdir(adapterDir))
      .filter((f) => f.endsWith('.js'))
      .filter((f) => !f.includes('-helpers'));
    expect(adapterFiles.length).toBeGreaterThan(0);
    for (const f of adapterFiles) {
      expect(indexText, `${f} not imported in _all.ts`).toContain(`'./${f}'`);
    }
  });

  it('does not import helper files directly (helpers are imported by adapters)', async () => {
    const indexText = await readFile(join(adapterDir, '_all.ts'), 'utf8');
    expect(indexText).not.toContain('helpers');
  });
});
