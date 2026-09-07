/**
 * Selection-toolbar content script — the floating text-selection toolbar
 * (Highlight / Translate / Explain / Summarize… / Ask), declared in the manifest for every
 * http(s) page but INERT unless the feature is enabled and the host isn't
 * blacklisted (user model: blacklist, not allowlist — see selection/settings).
 *
 * Runs in the isolated content-script world (chrome.runtime available), top
 * frame only. UI lives in a shadow root so page CSS can't touch it; the only
 * page-level footprint is one <style> for the <mark> highlights and the marks
 * themselves. LLM actions are ONE completion round-trip in the SW
 * (SELECTION_LLM) — no agent loop; Ask hands off to the SidePanel
 * (SELECTION_ASK → sidePanel.open + storage.session, see selection-actions).
 *
 * Live-reconfigures via storage.onChanged: flipping the switch or editing the
 * blacklist applies to already-open tabs without a reload.
 */

import {
  loadSelSettings,
  watchSelSettings,
  isHostBlacklisted,
  visibleSelActions,
  type SelToolbarSettings,
  type SelAction,
} from '@base/selection/settings';
import {
  buildTextIndex,
  describeRange,
  findQuote,
  segmentsFromSpan,
  wrapSegments,
  unwrapById,
  hlSelector,
  HL_CLASS,
  HL_ATTR,
} from '@base/selection/anchor';
import {
  pageKey,
  loadHighlights,
  addHighlight,
  removeHighlight,
  makeHighlightId,
} from '@base/selection/highlights-store';

/** LLM input cap — a selection larger than this is truncated (one completion,
 * not a compaction pipeline). */
const MAX_LLM_CHARS = 6000;
/** Highlight cap — wrapping a giant selection would splinter half the DOM. */
const MAX_HL_CHARS = 4000;

(() => {
  if (window.top !== window) return; // top frame only (v1)
  const w = window as unknown as { __webagentSelToolbar?: boolean };
  if (w.__webagentSelToolbar) return;
  w.__webagentSelToolbar = true;

  let settings: SelToolbarSettings | null = null;
  let active = false;

  /* ── shadow UI shell ─────────────────────────────────────────────── */

  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let bar: HTMLDivElement | null = null;
  /** Result popovers. A panel can be PINNED (📌 or just drag it): pinned ones
   * survive outside-click/scroll/Esc (close via their own ✕), so you can keep
   * a translation open while reading on — and compare several. */
  let panels: HTMLDivElement[] = [];
  /** Selection captured when the bar was shown (clicking the bar clears the
   * live selection — act on the snapshot). */
  let captured: { text: string; rect: DOMRect } | null = null;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .bar {
      position: absolute; z-index: 2147483646; display: flex; align-items: center; gap: 2px;
      background: #23272e; color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; padding: 3px; box-shadow: 0 4px 18px rgba(0,0,0,.28);
      user-select: none; white-space: nowrap;
    }
    .bar button {
      all: unset; cursor: pointer; font-size: 12.5px; line-height: 1; color: #e8eaed;
      padding: 6px 9px; border-radius: 7px;
    }
    .bar button:hover { background: rgba(255,255,255,.12); }
    .bar .hl-dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: #ffd54f; margin-right: 5px; vertical-align: -1px; }
    .bar .sep { width: 1px; height: 16px; background: rgba(255,255,255,.12); margin: 0 2px; }
    .panel {
      position: absolute; z-index: 2147483646; width: 380px; max-width: calc(100vw - 24px);
      background: #23272e; color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.35); overflow: hidden;
    }
    .panel .head {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-bottom: 1px solid rgba(255,255,255,.08); font-size: 12px; color: #9aa0a6;
      cursor: move;
    }
    .panel .head .title { flex: 1; color: #e8eaed; font-weight: 600; }
    .panel .head button {
      all: unset; cursor: pointer; padding: 4px; border-radius: 6px; color: #9aa0a6;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .panel .head button:hover { background: rgba(255,255,255,.12); color: #e8eaed; }
    .panel .head button.pin.on { color: #ffd54f; }
    .panel .head button svg { display: block; }
    .panel .body {
      padding: 10px 12px; font-size: 13px; line-height: 1.65; max-height: 42vh; overflow: auto;
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .panel .body.loading { color: #9aa0a6; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid rgba(255,255,255,.25);
      border-top-color: #e8eaed; border-radius: 50%; animation: spin .8s linear infinite; margin-right: 7px; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  /* Inline lucide-style SVGs — the shadow world has no icon module. */
  const SVG = (path: string): string =>
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const ICON_PIN = SVG(
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
  );
  const ICON_COPY = SVG(
    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  );
  const ICON_CHECK = SVG('<path d="M20 6 9 17l-5-5"/>');
  const ICON_X = SVG('<path d="M18 6 6 18M6 6l12 12"/>');

  function ensureShell(): ShadowRoot {
    if (shadow) return shadow;
    host = document.createElement('div');
    host.setAttribute('data-webagent-seltoolbar', '');
    host.style.position = 'absolute';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return shadow;
  }

  function hideBar(): void {
    bar?.remove();
    bar = null;
  }
  function isPinned(p: HTMLDivElement): boolean {
    return p.dataset.pinned === '1';
  }
  function closePanel(p: HTMLDivElement): void {
    p.remove();
    panels = panels.filter((x) => x !== p);
  }
  /** Dismissal (outside click / scroll / Esc) only touches UNPINNED panels. */
  function closeUnpinnedPanels(): void {
    for (const p of [...panels]) if (!isPinned(p)) closePanel(p);
  }

  /** Place an absolutely-positioned el near a viewport rect (above preferred,
   * below as fallback), clamped to the viewport horizontally. */
  function placeNear(el: HTMLElement, rect: DOMRect): void {
    const sx = window.scrollX;
    const sy = window.scrollY;
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    // Measure after insert.
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    let left = sx + rect.left + rect.width / 2 - bw / 2;
    left = Math.max(sx + 8, Math.min(left, sx + window.innerWidth - bw - 8));
    let top = sy + rect.top - bh - 8;
    if (rect.top - bh - 8 < 4) top = sy + rect.bottom + 8;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = 'visible';
  }

  /* ── highlight styling in the PAGE (marks live outside the shadow) ── */

  function ensureMarkStyle(): void {
    if (document.getElementById('webagent-hl-style')) return;
    const s = document.createElement('style');
    s.id = 'webagent-hl-style';
    s.textContent = `mark.${HL_CLASS}{background:rgba(255,213,79,.55);color:inherit;padding:0;border-radius:2px;cursor:pointer;}`;
    document.documentElement.appendChild(s);
  }

  /* ── toolbar ─────────────────────────────────────────────────────── */

  function showBar(rect: DOMRect, text: string): void {
    const sh = ensureShell();
    hideBar();
    captured = { text, rect };
    bar = document.createElement('div');
    bar.className = 'bar';
    // Keep the page selection while interacting with the bar.
    bar.addEventListener('mousedown', (e) => e.preventDefault());

    const addBtn = (label: string, title: string, fn: () => void, html?: string): void => {
      const b = document.createElement('button');
      if (html) b.innerHTML = html;
      else b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      bar!.appendChild(b);
    };

    addBtn('Highlight', 'Highlight the selected text (persists across reloads)', onHighlight, `<span class="hl-dot"></span>Highlight`);
    const sep1 = document.createElement('div');
    sep1.className = 'sep';
    bar.appendChild(sep1);
    // minChars gate: e.g. Summarize only appears once the selection is long enough.
    for (const a of visibleSelActions(settings?.actions ?? [], text.length)) {
      addBtn(a.label, a.prompt, () => void runLlmAction(a));
    }
    const sep2 = document.createElement('div');
    sep2.className = 'sep';
    bar.appendChild(sep2);
    addBtn('Ask', 'Take this text to the side panel and keep asking', onAsk);

    sh.appendChild(bar);
    placeNear(bar, rect);
  }

  /** Mini bar shown when clicking an EXISTING highlight: remove / copy. */
  function showMarkBar(mark: HTMLElement): void {
    const id = mark.getAttribute(HL_ATTR);
    if (!id) return;
    const sh = ensureShell();
    hideBar();
    const rect = mark.getBoundingClientRect();
    bar = document.createElement('div');
    bar.className = 'bar';
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    const mk = (label: string, fn: () => void): void => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      bar!.appendChild(b);
    };
    mk('Remove highlight', () => {
      unwrapById(document.body, id);
      void removeHighlight(pageKey(location.href), id);
      hideBar();
    });
    mk('Copy', () => {
      copyText(textOfHighlight(id));
      hideBar();
    });
    sh.appendChild(bar);
    placeNear(bar, rect);
  }

  function textOfHighlight(id: string): string {
    return [...document.querySelectorAll(hlSelector(id))]
      .map((m) => m.textContent ?? '')
      .join('');
  }

  function copyText(t: string): void {
    void navigator.clipboard?.writeText(t).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      ta.remove();
    });
  }

  /* ── actions ─────────────────────────────────────────────────────── */

  function onHighlight(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideBar();
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (text.length > MAX_HL_CHARS) {
      showPanel('Highlight', null, `Selection too long (${text.length} chars); highlight limit is ${MAX_HL_CHARS} chars.`);
      return hideBar();
    }
    ensureMarkStyle();
    const idx = buildTextIndex(document.body);
    const desc = describeRange(idx, range);
    if (!desc) return hideBar();
    const span = findQuote(idx, desc.exact, desc.prefix, desc.suffix);
    if (!span) return hideBar();
    const id = makeHighlightId();
    wrapSegments(segmentsFromSpan(idx, span.start, span.end), id);
    void addHighlight(pageKey(location.href), {
      id,
      ...desc,
      ts: Date.now(),
      title: document.title,
    });
    sel.removeAllRanges();
    hideBar();
  }

  async function runLlmAction(a: SelAction): Promise<void> {
    const snap = captured;
    hideBar();
    if (!snap) return;
    const text =
      snap.text.length > MAX_LLM_CHARS ? snap.text.slice(0, MAX_LLM_CHARS) + '…' : snap.text;
    const p = showPanel(a.label, snap.rect, null); // loading state
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'SELECTION_LLM',
        label: a.label,
        prompt: a.prompt,
        text,
        title: document.title,
        url: location.href,
      })) as { ok?: boolean; result?: string; error?: string } | undefined;
      if (r?.ok && typeof r.result === 'string') setPanelBody(p, r.result, false);
      else setPanelBody(p, `Failed: ${r?.error ?? 'no result returned'}`, false);
    } catch (e) {
      setPanelBody(
        p,
        `Can't reach the extension (${e instanceof Error ? e.message : String(e)}). It may have just been updated — reload this page and try again.`,
        false,
      );
    }
  }

  function onAsk(): void {
    const snap = captured;
    hideBar();
    if (!snap) return;
    void chrome.runtime
      .sendMessage({
        type: 'SELECTION_ASK',
        text: snap.text.slice(0, MAX_LLM_CHARS),
        title: document.title,
        url: location.href,
      })
      .catch(() => {});
    window.getSelection()?.removeAllRanges();
  }

  /* ── result popover ──────────────────────────────────────────────── */

  function showPanel(title: string, rect: DOMRect | null, text: string | null): HTMLDivElement {
    const sh = ensureShell();
    closeUnpinnedPanels(); // a pinned panel stays; the fresh one opens beside it
    const p = document.createElement('div');
    p.className = 'panel';
    p.addEventListener('mousedown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'head';
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = title;
    const pinB = document.createElement('button');
    pinB.className = 'pin';
    pinB.innerHTML = ICON_PIN;
    pinB.title = 'Pin: clicking the page / scrolling / Esc no longer closes it (dragging also auto-pins)';
    pinB.setAttribute('aria-label', 'Pin');
    const setPinned = (on: boolean): void => {
      p.dataset.pinned = on ? '1' : '';
      pinB.classList.toggle('on', on);
      pinB.title = on
        ? 'Pinned — click to unpin (once unpinned, clicking the page / scrolling closes it)'
        : 'Pin: clicking the page / scrolling / Esc no longer closes it (dragging also auto-pins)';
    };
    pinB.addEventListener('click', () => setPinned(!isPinned(p)));
    const copyB = document.createElement('button');
    copyB.innerHTML = ICON_COPY;
    copyB.title = 'Copy result';
    copyB.setAttribute('aria-label', 'Copy result');
    copyB.addEventListener('click', () => {
      const body = p.querySelector('.body');
      if (!body || body.classList.contains('loading')) return;
      copyText(body.textContent ?? '');
      copyB.innerHTML = ICON_CHECK; // brief ✓ feedback
      setTimeout(() => {
        copyB.innerHTML = ICON_COPY;
      }, 1000);
    });
    const closeB = document.createElement('button');
    closeB.innerHTML = ICON_X;
    closeB.title = 'Close';
    closeB.setAttribute('aria-label', 'Close');
    closeB.addEventListener('click', () => closePanel(p));
    head.appendChild(t);
    head.appendChild(pinB);
    head.appendChild(copyB);
    head.appendChild(closeB);

    // Drag by the header (buttons excluded). Dragging = "I want to keep this
    // where I put it" → auto-pin.
    head.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      setPinned(true);
      const startX = e.clientX;
      const startY = e.clientY;
      const origL = parseFloat(p.style.left) || 0;
      const origT = parseFloat(p.style.top) || 0;
      const move = (ev: MouseEvent): void => {
        p.style.left = `${Math.max(0, origL + ev.clientX - startX)}px`;
        p.style.top = `${Math.max(0, origT + ev.clientY - startY)}px`;
      };
      const up = (): void => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });

    const body = document.createElement('div');
    body.className = 'body' + (text === null ? ' loading' : '');
    if (text === null) body.innerHTML = '<span class="spin"></span>Thinking…';
    else body.textContent = text;
    p.appendChild(head);
    p.appendChild(body);
    sh.appendChild(p);
    panels.push(p);
    placeNear(p, rect ?? captured?.rect ?? new DOMRect(8, 8, 0, 0));
    return p;
  }

  function setPanelBody(p: HTMLDivElement, text: string, loading: boolean): void {
    const body = p.querySelector('.body') as HTMLElement | null;
    if (!body) return;
    body.classList.toggle('loading', loading);
    body.textContent = text;
  }

  /* ── highlight restore (persistence) ─────────────────────────────── */

  let restoredKey = '';

  async function restoreHighlights(): Promise<void> {
    const key = pageKey(location.href);
    const entries = await loadHighlights(key);
    if (!entries.length) {
      restoredKey = key;
      return;
    }
    ensureMarkStyle();
    const idx = buildTextIndex(document.body);
    for (const e of entries) {
      if (document.querySelector(hlSelector(e.id))) continue; // already there
      const span = findQuote(idx, e.exact, e.prefix, e.suffix);
      if (span) wrapSegments(segmentsFromSpan(idx, span.start, span.end), e.id);
    }
    restoredKey = key;
  }

  /* ── event wiring ────────────────────────────────────────────────── */

  function isEditableTarget(): boolean {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = ae.tagName;
    return (
      tag === 'INPUT' || tag === 'TEXTAREA' || (ae as HTMLElement).isContentEditable === true
    );
  }

  function onMouseUp(e: MouseEvent): void {
    if (host && e.composedPath().includes(host)) return; // clicks on our own UI
    // Let the selection settle (double-click word selection etc.).
    setTimeout(() => {
      if (!active || !settings) return;
      if (settings.trigger === 'alt' && !e.altKey) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? '';
      if (!sel || sel.isCollapsed || !text.trim()) return;
      if (isEditableTarget()) return; // reading mode only (edit-mode actions deferred)
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      showBar(rect, text);
    }, 0);
  }

  function onDocMouseDown(e: MouseEvent): void {
    if (host && e.composedPath().includes(host)) return;
    hideBar();
    closeUnpinnedPanels();
    // Click on an existing highlight → its mini bar (after the hide above).
    const t = e.target as Element | null;
    const mark = t?.closest?.(`mark.${HL_CLASS}`) as HTMLElement | null;
    if (mark) {
      // Defer so this mousedown's own hide doesn't race the new bar.
      setTimeout(() => showMarkBar(mark), 0);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      hideBar();
      closeUnpinnedPanels();
    }
  }

  function onScroll(): void {
    hideBar();
    closeUnpinnedPanels(); // pinned panels sit in doc coords → scroll with the text
  }

  /** The panel's highlight-management can delete entries for THIS page while it's open —
   * mirror those deletions onto the live DOM (marks whose id vanished). */
  function onStorageChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void {
    if (area !== 'local') return;
    const ch = changes[pageKey(location.href)];
    if (!ch) return;
    const kept = new Set(
      (Array.isArray(ch.newValue) ? (ch.newValue as { id?: string }[]) : [])
        .map((e) => e.id)
        .filter((x): x is string => typeof x === 'string'),
    );
    const gone = new Set<string>();
    document.querySelectorAll(`mark[${HL_ATTR}]`).forEach((m) => {
      const id = m.getAttribute(HL_ATTR);
      if (id && !kept.has(id)) gone.add(id);
    });
    for (const id of gone) unwrapById(document.body, id);
  }

  function onSelectionChange(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideBar();
  }

  let urlPoll: ReturnType<typeof setInterval> | null = null;
  let restoreRetry: ReturnType<typeof setTimeout> | null = null;

  function activate(): void {
    if (active) return;
    active = true;
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    chrome.storage.onChanged.addListener(onStorageChanged);
    void restoreHighlights();
    // Late-rendering pages: one retry after content likely settled.
    restoreRetry = setTimeout(() => void restoreHighlights(), 2500);
    // SPA soft navigations: re-restore when the URL (sans hash) changes.
    urlPoll = setInterval(() => {
      if (pageKey(location.href) !== restoredKey) void restoreHighlights();
    }, 2000);
  }

  function deactivate(): void {
    if (!active) return;
    active = false;
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('selectionchange', onSelectionChange);
    window.removeEventListener('scroll', onScroll, { capture: true });
    chrome.storage.onChanged.removeListener(onStorageChanged);
    if (urlPoll) clearInterval(urlPoll);
    if (restoreRetry) clearTimeout(restoreRetry);
    urlPoll = null;
    restoreRetry = null;
    hideBar();
    for (const p of [...panels]) closePanel(p); // pinned included — feature off
    // Existing marks stay until reload (harmless); nothing new is created.
  }

  function applySettings(s: SelToolbarSettings): void {
    settings = s;
    const on = s.enabled && !isHostBlacklisted(location.hostname, s.blacklist);
    if (on) activate();
    else deactivate();
  }

  void loadSelSettings().then(applySettings);
  watchSelSettings(applySettings);
})();
