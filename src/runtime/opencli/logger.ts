/**
 * Browser-safe shim of @jackwener/opencli/logger.
 *
 * opencli's logger.ts depends on `picocolors` (terminal colors, node-only)
 * and writes to process.stderr. In the extension we route through our own
 * structured logger (runtime/log) so adapter log output shows up in the
 * SidePanel debug log alongside everything else.
 *
 * Resolved via the Vite alias `@jackwener/opencli/logger` → this file.
 * Surface matches opencli's `log` object: { error, warn, info, debug, success }.
 */

import { log as runtimeLog, warn as runtimeWarn, error as runtimeError } from '../log';

const SCOPE = 'adapter';

function join(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : (() => {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })()))
    .join(' ');
}

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export const log = {
  error: (...args: unknown[]) => runtimeError(SCOPE, join(args)),
  warn: (...args: unknown[]) => runtimeWarn(SCOPE, join(args)),
  info: (...args: unknown[]) => runtimeLog(SCOPE, join(args)),
  debug: (...args: unknown[]) => runtimeLog(SCOPE, join(args)),
  success: (...args: unknown[]) => runtimeLog(SCOPE, join(args)),
};
