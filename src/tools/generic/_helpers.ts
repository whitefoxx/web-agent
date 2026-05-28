/**
 * Shared utilities for site-independent ("generic") adapters. Each generic
 * adapter opens its own tab on demand instead of relying on a pre-bound
 * site tab (xiaohongshu adapters use `page` for that). These helpers
 * keep that boilerplate in one place.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve when `tabId`'s status flips to 'complete', or reject after
 * `timeoutMs`. Tolerates the tab being already-complete at call time. */
export function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    const done = (ok: boolean): void => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error(`tab-load timeout after ${timeoutMs}ms`));
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') done(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') done(true);
      })
      .catch(() => {});
  });
}

export function assertHttpUrl(url: unknown, paramName = 'url'): string {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`${paramName} must start with http:// or https://`);
  }
  return s;
}
