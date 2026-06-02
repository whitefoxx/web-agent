/**
 * Inline SVG icons — Lucide-flavored: 1.75 stroke, round caps/joins, 24×24 viewBox.
 *
 * Why inline + per-icon component, not an icon library: this is a Chrome MV3
 * sidepanel — every dependency bytes against startup time and bundle size.
 * Hand-rolled SVGs cost ~0.3KB each, zero runtime dep, and we only ship the
 * dozen we actually use. Keep the set lean; add new ones here rather than
 * pulling in `lucide-preact` for one more shape.
 *
 * `currentColor` everywhere so CSS controls color; `size` defaults to 18px
 * which lines up with body text at 13px (matches our base font).
 */

import type { JSX } from 'preact';

type IconProps = {
  size?: number;
  class?: string;
  style?: string;
  'stroke-width'?: number;
};

const DEFAULT_STROKE = 1.75;

function stroke(d: string, p: IconProps): JSX.Element {
  const s = p.size ?? 18;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={p['stroke-width'] ?? DEFAULT_STROKE}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={p.class}
      style={p.style}
    >
      <path d={d} />
    </svg>
  );
}

/** WebChat brand mark — chat bubble inside a soft tinted rounded square.
 * Renders in `currentColor`; tint backdrop is 12% alpha of that. */
export function IconBrand(p: IconProps): JSX.Element {
  const s = p.size ?? 24;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none" class={p.class} style={p.style}>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="currentColor" opacity="0.12" />
      <path
        d="M9 11.5C9 10.119 10.119 9 11.5 9h9c1.381 0 2.5 1.119 2.5 2.5v5c0 1.381-1.119 2.5-2.5 2.5h-4l-3.2 2.4c-.33.247-.8.011-.8-.4V19h-.5C9.45 19 9 18.55 9 18z"
        fill="currentColor"
      />
    </svg>
  );
}

export const IconPlus = (p: IconProps): JSX.Element => stroke('M12 5v14M5 12h14', p);

export const IconMenu = (p: IconProps): JSX.Element => stroke('M4 6h16M4 12h16M4 18h16', p);

export const IconX = (p: IconProps): JSX.Element => stroke('M18 6L6 18M6 6l12 12', p);

export const IconArrowUp = (p: IconProps): JSX.Element => stroke('M12 19V5M5 12l7-7 7 7', p);

/** Filled rounded square — visually heavier than a stroke icon for the stop CTA. */
export function IconStop(p: IconProps): JSX.Element {
  const s = p.size ?? 14;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="currentColor"
      class={p.class}
      style={p.style}
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export const IconChevronLeft = (p: IconProps): JSX.Element => stroke('M15 18l-6-6 6-6', p);

export const IconRefresh = (p: IconProps): JSX.Element =>
  stroke('M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5', p);

export function IconCog(p: IconProps): JSX.Element {
  const s = p.size ?? 18;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={p['stroke-width'] ?? DEFAULT_STROKE}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={p.class}
      style={p.style}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconPuzzle(p: IconProps): JSX.Element {
  const s = p.size ?? 18;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={p['stroke-width'] ?? DEFAULT_STROKE}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={p.class}
      style={p.style}
    >
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.47 1.229 0 1.698l-2.748 2.748A.625.625 0 0 1 17.5 14.5h-1.502c-.121 0-.221-.099-.221-.221V14c0-1.105-.895-2-2-2s-2 .895-2 2v.278c0 .121-.099.221-.221.221H10c-.345 0-.625-.28-.625-.625V12.5c0-.345-.28-.625-.625-.625H8c-1.105 0-2-.895-2-2s.895-2 2-2h.75c.345 0 .625-.28.625-.625V6.625c0-.345.28-.625.625-.625h1.555c.122 0 .222-.099.222-.221V5c0-1.105.895-2 2-2s2 .895 2 2v.778c0 .122.099.221.221.221h1.501a.625.625 0 0 1 .442.183l2.748 2.748c.23.23.337.555.288.878z" />
    </svg>
  );
}

export function IconClock(p: IconProps): JSX.Element {
  const s = p.size ?? 18;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={p['stroke-width'] ?? DEFAULT_STROKE}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={p.class}
      style={p.style}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export const IconTerminal = (p: IconProps): JSX.Element => stroke('M4 17l6-6-6-6M12 19h8', p);

/* ── Activity-timeline icons (Claude-for-Chrome-style) ── */
export const IconFlag = (p: IconProps): JSX.Element =>
  stroke('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7', p);
export const IconEye = (p: IconProps): JSX.Element =>
  stroke('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 15a3 3 0 100-6 3 3 0 000 6z', p);
export const IconSearch = (p: IconProps): JSX.Element =>
  stroke('M11 18a7 7 0 100-14 7 7 0 000 14z M21 21l-4.5-4.5', p);
export const IconCamera = (p: IconProps): JSX.Element =>
  stroke(
    'M14.5 4h-5L7 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-3zM12 17.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
    p,
  );
export const IconPointer = (p: IconProps): JSX.Element => stroke('M4 4l6 16 2-6 6-2z', p);
export const IconType = (p: IconProps): JSX.Element => stroke('M4 7V4h16v3M9 20h6M12 4v16', p);
export const IconScroll = (p: IconProps): JSX.Element => stroke('M7 6l5 5 5-5M7 13l5 5 5-5', p);
export const IconList = (p: IconProps): JSX.Element =>
  stroke('M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01', p);
export const IconBranch = (p: IconProps): JSX.Element =>
  stroke(
    'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM15 6a9 9 0 01-9 9',
    p,
  );
export const IconSave = (p: IconProps): JSX.Element =>
  stroke('M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2zM17 21v-8H7v8M7 3v5h8', p);
export const IconImage = (p: IconProps): JSX.Element =>
  stroke(
    'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21',
    p,
  );
export const IconGlobe = (p: IconProps): JSX.Element =>
  stroke(
    'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 014 10 15 15 0 01-4 10 15 15 0 01-4-10 15 15 0 014-10z',
    p,
  );
export const IconCheckCircle = (p: IconProps): JSX.Element =>
  stroke('M9 12l2 2 4.5-4.5M12 21a9 9 0 100-18 9 9 0 000 18z', p);
export const IconChevronDown = (p: IconProps): JSX.Element => stroke('M6 9l6 6 6-6', p);

export function IconDot(p: IconProps): JSX.Element {
  const s = p.size ?? 8;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" class={p.class} style={p.style}>
      <circle cx="12" cy="12" r="6" fill="currentColor" />
    </svg>
  );
}

export const IconHand = (p: IconProps): JSX.Element =>
  stroke(
    'M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v2M10 10.5V6a2 2 0 00-4 0v8M18 8a2 2 0 014 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 012.83-2.82L7 15',
    p,
  );
export const IconFastForward = (p: IconProps): JSX.Element =>
  stroke('M13 19l9-7-9-7v14zM2 19l9-7-9-7v14z', p);
export const IconCheck = (p: IconProps): JSX.Element => stroke('M20 6L9 17l-5-5', p);

export const IconCopy = (p: IconProps): JSX.Element =>
  stroke(
    'M8 8h11a1 1 0 011 1v11a1 1 0 01-1 1H8a1 1 0 01-1-1V9a1 1 0 011-1zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
    p,
  );

/** 8-ray asterisk/sparkle — the active "ongoing" indicator (spins via CSS). */
export const IconSparkle = (p: IconProps): JSX.Element =>
  stroke('M12 2v20M2 12h20M5 5l14 14M19 5L5 19', p);
