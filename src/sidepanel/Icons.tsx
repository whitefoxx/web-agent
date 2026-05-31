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
