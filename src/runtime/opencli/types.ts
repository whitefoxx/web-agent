/**
 * Type-only shim of @jackwener/opencli/types.
 *
 * Adapters do `import type { IPage } from '@jackwener/opencli/types'` (and
 * occasionally the option types). These imports are erased at build time, so
 * this file only needs to satisfy the type checker. `IPage` is declared as the
 * structural surface opencli adapters rely on — kept loose (methods optional,
 * permissive returns) so a real adapter type-checks against our PageShim even
 * where our implementation only covers part of the surface.
 *
 * Resolved via the Vite alias `@jackwener/opencli/types` → this file (and the
 * matching tsconfig `paths` entry for `tsc --noEmit`).
 */

export interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
  raw?: boolean;
  viewportExpand?: number;
  maxTextLength?: number;
  source?: 'dom' | 'ax';
}

export interface WaitOptions {
  text?: string;
  selector?: string;
  time?: number;
  timeout?: number;
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  annotate?: boolean;
  width?: number;
  height?: number;
  path?: string;
}

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export type BrowserEvaluateFunction<Args extends unknown[], T> = (...args: Args) => T;

/**
 * The host-provided page object passed to a browser adapter's `func`. Declared
 * permissively (everything optional, `any`-friendly returns) so unmodified
 * opencli adapters type-check against it. The concrete implementation is
 * `PageShim` in runtime/page.ts; methods it doesn't implement throw at runtime
 * with a clear message rather than failing to compile.
 */
export interface IPage {
  readonly tabId?: number;
  goto(url: string, options?: { waitUntil?: string; settleMs?: number }): Promise<void>;
  // Permissive single signature: accepts either a JS string (our PageShim) or
  // a function + args (opencli's typed form). Kept as one overload to avoid
  // overload/implementation mismatches across the two host implementations.
  evaluate<T = any>(js: string | BrowserEvaluateFunction<any[], T>, ...args: unknown[]): Promise<T>;
  evaluateWithArgs?(js: string, args: Record<string, unknown>): Promise<any>;
  fetchJson?(url: string, opts?: FetchJsonOptions): Promise<unknown>;
  getCookies(opts?: { domain?: string; url?: string }): Promise<any>;
  snapshot?(opts?: SnapshotOptions): Promise<any>;
  networkRequests?(includeStatic?: boolean): Promise<any>;
  consoleMessages?(level?: string): Promise<any>;
  click?(ref: string, opts?: Record<string, unknown>): Promise<any>;
  dblClick?(ref: string, opts?: Record<string, unknown>): Promise<any>;
  hover?(ref: string, opts?: Record<string, unknown>): Promise<any>;
  focus?(ref: string, opts?: Record<string, unknown>): Promise<any>;
  setChecked?(ref: string, checked: boolean, opts?: Record<string, unknown>): Promise<any>;
  uploadFiles?(ref: string, files: string[], opts?: Record<string, unknown>): Promise<any>;
  drag?(source: string, target: string, opts?: Record<string, unknown>): Promise<any>;
  typeText?(ref: string, text: string, opts?: Record<string, unknown>): Promise<any>;
  fillText?(ref: string, text: string, opts?: Record<string, unknown>): Promise<any>;
  type?(ref: string, text: string, opts?: Record<string, unknown>): Promise<any>;
  pressKey(key: string): Promise<void>;
  scrollTo?(ref: string, opts?: Record<string, unknown>): Promise<any>;
  scroll?(direction?: string, amount?: number): Promise<void>;
  autoScroll(options?: { times?: number; delayMs?: number }): Promise<void>;
  wait(options: number | WaitOptions): Promise<void>;
  waitForTimeout?(ms: number): Promise<void>;
  waitForDownload?(pattern?: string, timeoutMs?: number): Promise<any>;
  installInterceptor(pattern: string): Promise<void>;
  getInterceptedRequests(): Promise<any[]>;
  startNetworkCapture?(pattern?: string): Promise<boolean>;
  readNetworkCapture?(): Promise<unknown[]>;
  waitForCapture?(timeout?: number): Promise<void>;
  tabs?(): Promise<any>;
  closeTab?(target?: number | string): Promise<void>;
  newTab?(url?: string): Promise<string | undefined>;
  selectTab?(target: number | string): Promise<void>;
  closeWindow?(): Promise<void>;
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  handleJavaScriptDialog?(accept: boolean, promptText?: string): Promise<void>;
  frames?(): Promise<any>;
  evaluateInFrame?(js: string, frameIndex: number): Promise<unknown>;
  nativeClick?(x: number, y: number): Promise<void>;
  nativeType?(text: string): Promise<void>;
  nativeKeyPress?(key: string, modifiers?: string[]): Promise<void>;
  setFileInput?(files: string[], selector?: string): Promise<void>;
  insertText?(text: string, opts?: { mode?: 'batch' | 'char' }): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<string>;
  annotatedScreenshot?(options?: ScreenshotOptions): Promise<string>;
  getCurrentUrl?(): Promise<string | null>;
  find?(query: string, opts?: Record<string, unknown>): Promise<any>;
  downloadFile?(opts: { url: string; filename: string; conflictAction?: string }): Promise<any>;
  getAttachments?(): File[];
  detach?(): Promise<void>;
}
