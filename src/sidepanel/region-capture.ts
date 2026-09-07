/**
 * Monica-style region screenshot WITH on-page annotation. We inject an overlay
 * into the user's active page: drag a crosshair rectangle, then a toolbar appears
 * under the selection (rect / ellipse / arrow / pen / text / mosaic + color +
 * size + undo + download). Annotations can be selected, moved, deleted, and (for
 * text) re-edited. ✓ confirms, ⬇ downloads, ✕/Esc cancels. The page returns the
 * rectangle (CSS px + devicePixelRatio) and the annotation as a transparent PNG;
 * the SidePanel captures the visible tab, crops to the rect, and composites the
 * annotation on top. No new permission (scripting + the <all_urls> host access).
 *
 * The injected function is serialized via toString — it must be self-contained
 * (no outer references) and must NEVER use CSS custom properties (var(--x)),
 * which would inherit the host page's values.
 */

import { selectAndAnnotateInPage, type CaptureResult } from '@base/capture/region-select';

/** Capture the visible tab, crop to the rect, composite the annotation PNG. */
function compositeRegion(full: string, r: CaptureResult): Promise<string | null> {
  return new Promise((resolve) => {
    const cw = Math.max(1, Math.round(r.w * r.dpr));
    const ch = Math.max(1, Math.round(r.h * r.dpr));
    const page = new Image();
    page.onload = () => {
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.drawImage(page, r.x * r.dpr, r.y * r.dpr, cw, ch, 0, 0, cw, ch);
      if (!r.annotation) return resolve(c.toDataURL('image/png'));
      const ann = new Image();
      ann.onload = () => {
        ctx.drawImage(ann, 0, 0, cw, ch);
        resolve(c.toDataURL('image/png'));
      };
      ann.onerror = () => resolve(c.toDataURL('image/png'));
      ann.src = r.annotation;
    };
    page.onerror = () => resolve(null);
    page.src = full;
  });
}

export async function captureRegion(): Promise<string | null> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return null;
  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: selectAndAnnotateInPage,
  });
  const r = res[0]?.result as CaptureResult | null | undefined;
  if (!r) return null; // cancelled
  const full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const url = await compositeRegion(full, r);
  if (r.download && url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `screenshot-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return null; // downloaded — nothing to attach to the composer
  }
  return url;
}
