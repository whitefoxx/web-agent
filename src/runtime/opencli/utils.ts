/**
 * Browser-safe shim of @jackwener/opencli/utils.
 *
 * opencli's utils.ts imports node:fs / node:path (for saveBase64ToFile) and
 * `turndown`. In the extension we can't use node builtins, so this shim
 * provides the browser-safe subset that adapters actually import:
 *   htmlToMarkdown, createMarkdownConverter, throwIfLoginWall,
 *   parseJsonOrThrowLoginWall, isRecord, sleep, mapConcurrent,
 *   BROWSER_JSON_SNIFF_FN.
 * `saveBase64ToFile` (node:fs) is intentionally omitted — adapters that need
 * it are the download/* ones, which are node-only anyway.
 *
 * Resolved via the Vite alias `@jackwener/opencli/utils` → this file.
 * Kept verbatim-faithful to opencli/src/utils.ts (v1.8.0) for the included
 * functions so behaviour matches byte-for-byte.
 */

import TurndownService from 'turndown';
import { LoginWallError } from '../errors.js';

/** Type guard: checks if a value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Simple async concurrency limiter. */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Pause for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMarkdownConverter(configure?: (td: TurndownService) => void): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.addRule('linebreak', { filter: 'br', replacement: () => '\n' });
  if (configure) configure(td);
  return td;
}

export function htmlToMarkdown(value: string, configure?: (td: TurndownService) => void): string {
  return createMarkdownConverter(configure)
    .turndown(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export interface LoginWallSignal {
  __loginWall: true;
  status: number;
  url: string;
  contentType: string;
  bodyPreview: string;
}

function isLoginWallSignal(v: unknown): v is LoginWallSignal {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__loginWall === true &&
    typeof (v as Record<string, unknown>).status === 'number'
  );
}

/** Throw a `LoginWallError` if `value` is the sentinel returned by the
 * browser-side sniffer; otherwise return `value` unchanged. */
export function throwIfLoginWall<T>(value: T, opts: { url?: string } = {}): T {
  if (isLoginWallSignal(value)) {
    throw new LoginWallError(
      `Server returned HTML instead of JSON (status=${value.status}). ` +
        `Likely a login wall, rate limit, or WAF challenge.`,
      value.status,
      opts.url || value.url || '',
      value.bodyPreview,
    );
  }
  return value;
}

/** Parse a `Response` body as JSON, throwing `LoginWallError` if the server
 * returned an HTML page (login wall / rate limit / WAF) instead of JSON. */
export async function parseJsonOrThrowLoginWall(
  response: Response,
  opts: { url?: string } = {},
): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  const trimmed = text.trimStart();
  const looksLikeHtml =
    contentType.toLowerCase().includes('text/html') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<HTML');
  if (looksLikeHtml) {
    throw new LoginWallError(
      `Server returned HTML instead of JSON (status=${response.status}). ` +
        `Likely a login wall, rate limit, or WAF challenge.`,
      response.status,
      opts.url || response.url || '',
      trimmed.slice(0, 100),
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `JSON parse failed (status=${response.status}, body[0..50]=${JSON.stringify(trimmed.slice(0, 50))}): ` +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
}

/** Browser-side JS source fragment (as a string) that performs a `fetch` and
 * either returns the parsed JSON body or a `LoginWallSignal` sentinel when the
 * response is HTML. Intended to be embedded inside an adapter's page.evaluate.
 * Copied verbatim from opencli so embedded behaviour is identical. */
export const BROWSER_JSON_SNIFF_FN = `
async function fetchJsonOrLoginWall(input, init) {
  const r = await fetch(input, init);
  const contentType = r.headers.get('content-type') || '';
  const text = await r.text();
  const trimmed = text.replace(/^\\s+/, '');
  const looksLikeHtml =
    contentType.toLowerCase().includes('text/html')
    || trimmed.startsWith('<!DOCTYPE')
    || trimmed.startsWith('<!doctype')
    || trimmed.startsWith('<html')
    || trimmed.startsWith('<HTML');
  if (looksLikeHtml) {
    return {
      __loginWall: true,
      status: r.status,
      url: r.url || (typeof input === 'string' ? input : ''),
      contentType,
      bodyPreview: trimmed.slice(0, 100),
    };
  }
  if (!r.ok) {
    return { error: r.status };
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      'JSON parse failed (status=' + r.status + ', body[0..50]=' + JSON.stringify(trimmed.slice(0, 50)) + '): '
      + (err && err.message ? err.message : String(err))
    );
  }
}
`;
