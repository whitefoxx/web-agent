import { cli } from '@base/runtime/registry.js';
import { loadEphemeralAdapter } from '../../background/ephemeral-adapter';

/**
 * Adapter loading for the AGENT — the ONLY way to use a marketplace adapter now
 * that installing was removed (2026-07-09). Loads the adapter into the registry
 * for THIS session (SW restart clears it), so the agent just re-runs
 * find_adapters → load_adapter each task instead of persisting anything. Source
 * is sha256-verified and evaluated in the offscreen sandbox; a WRITE adapter
 * still confirms when it runs. (T7 direction 1; adapter-hot-plug §10.38.)
 */
cli({
  site: 'generic',
  name: 'load_adapter',
  access: 'read',
  description:
    'Load a marketplace site adapter; once loaded you can call it directly this session (e.g. `zhihu__question`) — loaded on demand, not persisted, and lost after the extension restarts (next task just find_adapters + load_adapter again, no install needed). Pair with find_adapters to get the site+name. Returns the tool\'s argument spec — call it directly per that spec.',
  args: [
    { name: 'site', type: 'string', required: true, help: 'The adapter\'s site, e.g. zhihu' },
    { name: 'name', type: 'string', required: true, help: 'The adapter\'s name, e.g. question' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const r = await loadEphemeralAdapter(String(kwargs.site ?? ''), String(kwargs.name ?? ''));
    if (!r.ok) throw new Error(r.error ?? 'load_adapter failed');
    return r;
  },
});
