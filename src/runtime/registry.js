/**
 * Adapter registry — mirrors @jackwener/opencli/registry surface so adapter
 * files copied from opencli can import {cli, Strategy, getRegistry} unchanged
 * (after a path rewrite from `@jackwener/opencli/registry` to here).
 *
 * Each adapter calls cli({...}) at module top-level; importing the adapter
 * file is what registers it.
 */

export const Strategy = Object.freeze({
  COOKIE: 'cookie',
  DIRECT: 'direct',
  AUTO: 'auto',
});

const _registry = [];

export function cli(def) {
  if (!def || typeof def !== 'object') {
    throw new Error('cli() expects a definition object');
  }
  if (!def.site || !def.name || typeof def.func !== 'function') {
    throw new Error(
      `cli() definition missing site/name/func: ${JSON.stringify({ site: def.site, name: def.name })}`,
    );
  }
  _registry.push(def);
}

export function getRegistry() {
  return _registry.slice();
}

export function findAdapter(site, name) {
  return _registry.find((d) => d.site === site && d.name === name);
}
