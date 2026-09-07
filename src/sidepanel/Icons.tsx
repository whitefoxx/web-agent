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

/** Web brand mark — chat bubble inside a soft tinted rounded square.
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

/** Product logo — a gradient wire-globe (the web) with a mouse cursor arrow
 * overlapping its lower-right (the agent acting on it). Full-color, viewBox
 * 512×512, self-contained gradients. `size` scales the whole mark; unlike the
 * stroke icons this does NOT use `currentColor` — the gradients are the brand.
 *
 * Note: gradient ids are stable (not per-instance). Multiple IconLogo instances
 * in one document all reference the first identical definition — visually fine. */
export function IconLogo(p: IconProps): JSX.Element {
  const s = p.size ?? 24;
  return (
    <svg width={s} height={s} viewBox="0 0 512 512" fill="none" class={p.class} style={p.style}>
      <defs>
        <linearGradient
          id="wa-logo-globe"
          gradientUnits="userSpaceOnUse"
          x1="91"
          y1="83"
          x2="421"
          y2="413"
        >
          <stop offset="0%" stop-color="#4F6BFF" />
          <stop offset="100%" stop-color="#A44DFF" />
        </linearGradient>
      </defs>
      {/* Uniformly scale the mark 1.43× about its centre (recentred to 256,256)
          so the globe nearly fills the box instead of floating small. */}
      <g transform="translate(256 256) scale(1.43) translate(-256 -248)">
        <g
          transform="translate(256, 248)"
          stroke="url(#wa-logo-globe)"
          stroke-width="22"
          fill="none"
          stroke-linecap="round"
        >
          <circle cx="0" cy="0" r="165" />
          <ellipse cx="0" cy="0" rx="72" ry="165" stroke-opacity="0.75" />
          <line x1="-165" y1="0" x2="165" y2="0" stroke-opacity="0.75" />
        </g>
        {/* Agent cursor: solid amber (brand accent), enlarged 1.35× and nudged
            up-left (centroid 329,341 → lands at 303,315). */}
        <g transform="translate(303 315) scale(1.35) translate(-329 -341)">
          <path d="M 300 272 L 300 384 L 330 354 L 386 354 Z" fill="#F5A623" />
        </g>
      </g>
    </svg>
  );
}

export const IconPlus = (p: IconProps): JSX.Element => stroke('M12 5v14M5 12h14', p);

export const IconMore = (p: IconProps): JSX.Element => stroke('M5 12h.01M12 12h.01M19 12h.01', p);

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

export function IconKey(p: IconProps): JSX.Element {
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
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2" />
      <path d="m16 7 3 3" />
      <path d="m12 11 3 3" />
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
export const IconChat = (p: IconProps): JSX.Element =>
  stroke('M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z', p);
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

/* ── Action-bar icons (run / edit / delete / source / insert / quote) ── */

/** Filled play triangle — the "run" action. Filled (like IconStop) so it
 * reads as a solid CTA next to outlined icons. */
export function IconPlay(p: IconProps): JSX.Element {
  const s = p.size ?? 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" class={p.class} style={p.style}>
      <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.5-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z" />
    </svg>
  );
}

/** Pencil — the "edit" action. */
export const IconPencil = (p: IconProps): JSX.Element =>
  stroke('M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z', p);

/** Trash can — the "delete / uninstall" action. */
export const IconTrash = (p: IconProps): JSX.Element =>
  stroke(
    'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
    p,
  );

/** Angle brackets — "view source". */
export const IconCode = (p: IconProps): JSX.Element => stroke('M16 18l6-6-6-6M8 6l-6 6 6 6', p);

/** Corner-down-left (↵) — "insert into the composer". */
export const IconCornerDownLeft = (p: IconProps): JSX.Element =>
  stroke('M9 10l-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4', p);

/** Corner-up-left (↰) — "quote into the conversation". */
export const IconCornerUpLeft = (p: IconProps): JSX.Element =>
  stroke('M9 14L4 9l5-5M20 20v-7a4 4 0 0 0-4-4H4', p);

/** Tray + down arrow — "import" (data coming in). */
export const IconDownload = (p: IconProps): JSX.Element =>
  stroke('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', p);

/** Tray + up arrow — "export" (data going out). */
export const IconUpload = (p: IconProps): JSX.Element =>
  stroke('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12', p);

/** Box + out-arrow — "open in a new tab". */
export const IconExternalLink = (p: IconProps): JSX.Element =>
  stroke('M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5', p);

/** Corner brackets — "expand / open in a new tab (wider view)". */
export const IconMaximize = (p: IconProps): JSX.Element =>
  stroke(
    'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
    p,
  );

/** Chevron up — "pull up a menu". */
export const IconChevronUp = (p: IconProps): JSX.Element => stroke('M18 15l-6-6-6 6', p);

/** 8-ray asterisk/sparkle — the active "ongoing" indicator (spins via CSS). */
export const IconSparkle = (p: IconProps): JSX.Element =>
  stroke('M12 2v20M2 12h20M5 5l14 14M19 5L5 19', p);

/** Paperclip — "attach a file / image" affordance in the composer. */
export const IconPaperclip = (p: IconProps): JSX.Element =>
  stroke(
    'M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48',
    p,
  );

/** File / document — chip mark for an attached text file. */
export const IconFile = (p: IconProps): JSX.Element =>
  stroke('M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6', p);

/** Wall plug — the "adapter / connector" metaphor (replaces the puzzle piece). */
export const IconPlug = (p: IconProps): JSX.Element =>
  stroke(
    'M12 22v-5M9 8V2M15 8V2M18 8H6a2 2 0 00-2 2v1a5 5 0 005 5h2a5 5 0 005-5v-1a2 2 0 00-2-2z',
    p,
  );

/** Sticky note (folded corner) — the "notes" mark. */
export const IconNote = (p: IconProps): JSX.Element =>
  stroke(
    'M16 3H5a2 2 0 00-2 2v14a2 2 0 002 2h11l5-5V5a2 2 0 00-2-2zM15 21v-5a2 2 0 012-2h5',
    p,
  );

/** Two-lobe brain — the "memory" mark (monochrome, replaces the 🧠 emoji). */
export const IconBrain = (p: IconProps): JSX.Element =>
  stroke(
    'M12 4.5a2.5 2.5 0 00-4.4-1.6A2.5 2.5 0 005 5.5a2.5 2.5 0 00-1.5 4 2.5 2.5 0 000 4A2.5 2.5 0 006 17a2.5 2.5 0 004 .5A2 2 0 0012 19zM12 4.5a2.5 2.5 0 014.4-1.6A2.5 2.5 0 0119 5.5a2.5 2.5 0 011.5 4 2.5 2.5 0 010 4A2.5 2.5 0 0118 17a2.5 2.5 0 01-4 .5A2 2 0 0112 19zM12 4.5V19',
    p,
  );
