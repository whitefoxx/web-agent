// Web Agent Chrome Web Store promo-asset generator.
// Pure string templating → SVG (works in Node AND browser). Node writes the SVG
// files + a self-contained promo.html; raster.mjs turns them into store-ready
// JPEGs at the exact required sizes.
//
//   node store/web-agent/render.mjs    # svg/ + promo.html (pure Node, no deps)
//   node store/web-agent/raster.mjs    # images/*.jpg  (needs sharp)
//
// NO SITE NAMES anywhere in here. Images are store metadata and a sibling
// extension's first submission was rejected for keyword spam over exactly that.
// Describe capability by category; never enumerate third-party brands.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ---------- design tokens ---------- */
const C = {
  bg0: '#0B1020',
  bg1: '#1A1236',
  panel: 'rgba(255,255,255,0.045)',
  panelStroke: 'rgba(255,255,255,0.09)',
  fg: '#F5F7FF',
  sec: '#AEB7D4',
  muted: '#727C9C',
  blue: '#4F6BFF',
  purple: '#A44DFF',
  amber: '#F5A623',
  chipFg: '#C7D0FF',
};

const FONT = "-apple-system,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- primitives ---------- */
function defs() {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/>
    </linearGradient>
    <linearGradient id="brand" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="118" y2="118">
      <stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.purple}"/>
    </linearGradient>
    <!-- Same ramp in objectBoundingBox units, for UI drawn anywhere on the
         canvas. The gradient above is pinned to the logo 128 box, so reusing
         it on a 1280-wide card clamps to the end colour. -->
    <linearGradient id="brandUI" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.purple}"/>
    </linearGradient>
    <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.blue}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${C.blue}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowP" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.purple}" stop-opacity="0.4"/>
      <stop offset="1" stop-color="${C.purple}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

function background(w, h, glows = []) {
  const g = glows
    .map(([cx, cy, r, id]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"/>`)
    .join('');
  return `<rect width="${w}" height="${h}" fill="url(#bg)"/>${g}`;
}

// The product mark — MUST stay in step with public/icons/logo.svg (the source of
// truth for the shipped PNGs). Spark first, cursor second: this is the only one
// of the three shells with an agent of its own.
function logo(x, y, size) {
  const s = size / 128;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect width="128" height="128" rx="28" fill="url(#brand)"/>
    <path d="M0 -1 C0.12 -0.34 0.34 -0.12 1 0 C0.34 0.12 0.12 0.34 0 1 C-0.12 0.34 -0.34 0.12 -1 0 C-0.34 -0.12 -0.12 -0.34 0 -1 Z"
          transform="translate(58 56) scale(40)" fill="#fff"/>
    <path d="M0 0 L0 16 L3.7 12.4 L6.2 18.5 L8.6 17.5 L6.1 11.5 L11 11.5 Z"
          transform="translate(80 74) rotate(-20) scale(2.7)" fill="${C.amber}"/>
  </g>`;
}

function text(x, y, str, o = {}) {
  const {
    size = 24, weight = 400, fill = C.fg, anchor = 'start',
    font = FONT, spacing = 0, opacity = 1,
  } = o;
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${spacing}" opacity="${opacity}">${esc(str)}</text>`;
}

function lines(x, y, arr, lh, o = {}) {
  return arr.map((s, i) => text(x, y + i * lh, s, o)).join('');
}

function chip(x, y, label, o = {}) {
  const {
    size = 20, padX = 15, h = 38,
    fill = 'rgba(79,107,255,0.13)', stroke = 'rgba(124,146,255,0.28)', fg = C.chipFg,
  } = o;
  const w = Math.round(label.length * size * 0.6 + padX * 2);
  const svg = `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}"/>
    ${text(x + w / 2, y + h / 2 + size * 0.34, label, { size, font: MONO, fill: fg, anchor: 'middle' })}
  </g>`;
  return { svg, width: w };
}

function chipFlow(x, y, maxW, labels, o = {}) {
  const gap = o.gap ?? 12;
  const rowH = (o.h ?? 38) + (o.rowGap ?? 12);
  let cx = x, cy = y, out = '';
  for (const l of labels) {
    const c = chip(cx, cy, l, o);
    if (cx + c.width > x + maxW && cx > x) {
      cx = x; cy += rowH;
      const c2 = chip(cx, cy, l, o);
      out += c2.svg; cx += c2.width + gap;
    } else {
      out += c.svg; cx += c.width + gap;
    }
  }
  return { svg: out, endY: cy + (o.h ?? 38) };
}

function rowWidth(labels, size = 20, padX = 15, gap = 12) {
  return labels.reduce((a, l) => a + Math.round(l.length * size * 0.6 + padX * 2), 0)
    + gap * (labels.length - 1);
}

function panel(x, y, w, h, r = 18) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${C.panel}" stroke="${C.panelStroke}"/>`;
}

function svgDoc(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs()}${inner}</svg>`;
}

function brandRow(x, y) {
  return `${logo(x, y, 46)}${text(x + 60, y + 33, 'Web Agent', { size: 30, weight: 700, spacing: 0.5 })}`;
}

/* ---------- cards ---------- */
const cards = [];
const W = 1280, H = 800;

const HERO_CHIPS = ['50+ browser tools', 'your logged-in Chrome', 'bring your own key'];

// S1 — HERO
cards.push({
  id: 'screenshot-1-hero', w: W, h: H, label: 'Screenshot 1 · Hero',
  render() {
    let s = background(W, H, [[300, 200, 620, 'glowB'], [1000, 640, 620, 'glowP']]);
    s += logo(W / 2 - 64, 96, 128);
    s += text(W / 2, 320, 'Web Agent', { size: 78, weight: 700, anchor: 'middle' });
    s += lines(W / 2, 392, [
      'An AI agent in your side panel that uses your browser —',
      'it reads, clicks and fills in the pages you are already signed into.',
    ], 44, { size: 27, fill: C.sec, anchor: 'middle' });
    const f = chipFlow(0, 500, W, HERO_CHIPS, { size: 22, h: 46, fill: 'rgba(88,166,255,0.12)', stroke: 'rgba(88,166,255,0.32)' });
    s += `<g transform="translate(${(W - rowWidth(HERO_CHIPS, 22, 15, 12)) / 2} 0)">${f.svg}</g>`;
    // Said early, because it is the thing people are angry to discover late.
    s += text(W / 2, 648, 'You bring the model: any OpenAI-compatible endpoint, your own key.', {
      size: 24, fill: C.muted, anchor: 'middle',
    });
    s += text(W / 2, 692, 'Nothing is sent to a server of ours. There is no server of ours.', {
      size: 22, fill: C.muted, anchor: 'middle',
    });
    return svgDoc(W, H, s);
  },
});

// S2 — HOW IT WORKS
cards.push({
  id: 'screenshot-2-how', w: W, h: H, label: 'Screenshot 2 · How it works',
  render() {
    let s = background(W, H, [[640, 720, 700, 'glowP']]);
    s += brandRow(72, 58);
    s += text(72, 196, 'You ask. It works the page.', { size: 48, weight: 700 });
    s += text(72, 244, 'In the browser you already use, with the accounts you are already in.', { size: 26, fill: C.sec });

    const steps = [
      ['1', 'You ask', 'In plain language, in the side panel.'],
      ['2', 'It plans', 'Your model picks the tools. You bring the model.'],
      ['3', 'It acts', 'Opens tabs, reads, clicks, types — in your Chrome.'],
      ['4', 'You confirm', 'Anything that writes stops and shows you what it will do.'],
    ];
    const y0 = 310, gap = 112;
    steps.forEach(([n, title, sub], i) => {
      const y = y0 + i * gap;
      s += panel(72, y - 42, W - 144, 92, 16);
      s += `<circle cx="126" cy="${y + 4}" r="26" fill="url(#brandUI)"/>`;
      s += text(126, y + 14, n, { size: 26, weight: 700, anchor: 'middle' });
      s += text(178, y - 2, title, { size: 28, weight: 700 });
      s += text(178, y + 32, sub, { size: 22, fill: C.sec });
    });
    s += text(72, 742, 'No credentials are stored — it reuses the session you already have.', {
      size: 23, fill: C.muted,
    });
    return svgDoc(W, H, s);
  },
});

// S3 — THE TOOLBELT
const TOOLS = [
  'open_url', 'get_page_text', 'fetch_url', 'get_html', 'screenshot', 'scroll_page',
  'web_search', 'list_links', 'click', 'type_into', 'fill_form', 'press_key',
  'select_option', 'hover', 'drag_and_drop', 'file_upload', 'handle_dialog',
  'get_interactives', 'get_dom_outline', 'query_dom', 'find_in_page', 'find_in_dom',
  'wait_for_selector', 'find_structured_data', 'get_a11y_tree', 'capture_network',
  'eval_js', 'create_site_script', 'list_site_scripts', 'get_site_script',
  'list_tabs', 'get_active_tab', 'manage_tabs', 'close_tab',
];
cards.push({
  id: 'screenshot-3-tools', w: W, h: H, label: 'Screenshot 3 · The toolbelt',
  render() {
    let s = background(W, H, [[1050, 180, 620, 'glowB']]);
    s += brandRow(72, 58);
    s += text(72, 196, '50+ browser tools', { size: 48, weight: 700 });
    s += text(72, 244, 'The primitives an agent actually needs — not a wrapper around one API.', { size: 26, fill: C.sec });
    const f = chipFlow(72, 300, W - 144, TOOLS, { size: 20, h: 42, rowGap: 14 });
    s += f.svg;
    s += text(72, f.endY + 68, 'Reading is free. Posting, sending and deleting are not:', { size: 24, fill: C.sec });
    s += text(72, f.endY + 106, 'a write always stops for your confirmation first.', { size: 24, fill: C.amber, weight: 700 });
    return svgDoc(W, H, s);
  },
});

// S4 — LEARNING A SITE
cards.push({
  id: 'screenshot-4-learn', w: W, h: H, label: 'Screenshot 4 · Learning a site',
  render() {
    let s = background(W, H, [[260, 640, 640, 'glowP'], [1040, 200, 560, 'glowB']]);
    s += brandRow(72, 58);
    s += text(72, 196, 'It can learn a site nobody wrote support for', { size: 44, weight: 700 });
    s += text(72, 244, 'Instead of you writing a scraper and maintaining it forever.', { size: 26, fill: C.sec });

    const cols = [
      ['Look', ['Structured data, the accessibility', 'tree, and the requests the page', 'makes — where did this value', 'really come from?']],
      ['Try', ['Run JavaScript in the page’s own', 'origin until the answer comes', 'back the same way twice.']],
      ['Keep', ['Save what worked as a reusable', 'tool, so the second time is', 'instant and deterministic.']],
    ];
    const cw = (W - 144 - 48) / 3;
    cols.forEach(([title, body], i) => {
      const x = 72 + i * (cw + 24);
      s += panel(x, 300, cw, 250, 18);
      s += text(x + 30, 352, title, { size: 30, weight: 700, fill: C.amber });
      s += lines(x + 30, 400, body, 32, { size: 20, fill: C.sec });
    });
    s += text(72, 626, 'And what it works out, you keep.', { size: 28, weight: 700 });
    s += lines(72, 668, [
      'The route it found becomes a tool you can call again — instant and deterministic the second time,',
      'and yours, rather than an entry on a list of supported sites that somebody has to keep from rotting.',
    ], 36, { size: 22, fill: C.sec });
    return svgDoc(W, H, s);
  },
});

// S5 — GET STARTED
cards.push({
  id: 'screenshot-5-start', w: W, h: H, label: 'Screenshot 5 · Get started',
  render() {
    let s = background(W, H, [[640, 260, 700, 'glowB']]);
    s += brandRow(72, 58);
    s += text(72, 196, 'Three steps', { size: 48, weight: 700 });
    s += text(72, 244, 'You need your own API key — the extension is the hands, you bring the brain.', { size: 26, fill: C.sec });

    const steps = [
      ['Install and open the side panel', 'From the toolbar. That is the whole interface.'],
      ['Menu → LLM backend', 'Pick a provider, paste your key, choose a model. It stays on this machine.'],
      ['Ask for something', 'Turn on “Allow user scripts” in the extension details page for the rest.'],
    ];
    const y0 = 330, gap = 130;
    steps.forEach(([title, sub], i) => {
      const y = y0 + i * gap;
      s += panel(72, y - 46, W - 144, 106, 16);
      s += `<circle cx="130" cy="${y + 6}" r="28" fill="url(#brandUI)"/>`;
      s += text(130, y + 17, String(i + 1), { size: 28, weight: 700, anchor: 'middle' });
      s += text(186, y + 2, title, { size: 28, weight: 700 });
      s += text(186, y + 38, sub, { size: 22, fill: C.sec });
    });
    s += text(72, 742, 'Chrome 138+  ·  open source  ·  github.com/whitefoxx/web-agent', {
      size: 22, fill: C.muted, font: MONO,
    });
    return svgDoc(W, H, s);
  },
});

// PROMO — small tile
cards.push({
  id: 'promo-small-440x280', w: 440, h: 280, label: 'Promo tile · small',
  render() {
    const w = 440, h = 280;
    let s = background(w, h, [[110, 60, 240, 'glowB'], [350, 240, 240, 'glowP']]);
    s += logo(w / 2 - 34, 44, 68);
    s += text(w / 2, 168, 'Web Agent', { size: 36, weight: 700, anchor: 'middle' });
    s += text(w / 2, 206, 'An AI agent that uses', { size: 19, fill: C.sec, anchor: 'middle' });
    s += text(w / 2, 232, 'your own browser', { size: 19, fill: C.sec, anchor: 'middle' });
    return svgDoc(w, h, s);
  },
});

// PROMO — marquee
cards.push({
  id: 'promo-marquee-1400x560', w: 1400, h: 560, label: 'Promo tile · marquee',
  render() {
    const w = 1400, h = 560;
    let s = background(w, h, [[260, 120, 520, 'glowB'], [1150, 460, 520, 'glowP']]);
    s += logo(96, h / 2 - 72, 156);
    s += text(304, h / 2 - 34, 'Web Agent', { size: 76, weight: 700 });
    s += text(304, h / 2 + 28, 'An AI agent in your side panel that uses your own browser.', { size: 30, fill: C.sec });
    s += text(304, h / 2 + 74, 'Signed in already. 50+ tools. Bring your own model.', { size: 30, fill: C.sec });
    s += text(304, h / 2 + 132, 'Every write stops for your confirmation.', { size: 24, fill: C.amber, weight: 700 });
    return svgDoc(w, h, s);
  },
});

/* ---------- emit ---------- */
mkdirSync(join(ROOT, 'svg'), { recursive: true });
const rendered = cards.map((c) => ({ ...c, svg: c.render() }));
for (const c of rendered) writeFileSync(join(ROOT, 'svg', `${c.id}.svg`), c.svg);

const sections = rendered
  .map(
    (c) => `<section class="card" id="card-${c.id}">
      <div class="meta"><h2>${c.label}</h2><span class="dim">${c.id}.jpg · ${c.w}×${c.h}</span>
      <button onclick="dl('${c.id}',${c.w},${c.h})">Download JPG</button></div>
      <div class="frame">${c.svg}</div>
    </section>`,
  )
  .join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Agent — Chrome Web Store promo assets</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#07090f;color:#e8ecf7;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
  header{max-width:1100px;margin:0 auto 24px}
  h1{font-size:26px;margin:0 0 6px}
  header p{color:#8b93ad;margin:0}
  main{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:34px}
  .card{background:#0e1220;border:1px solid #1e2436;border-radius:14px;padding:16px}
  .meta{display:flex;align-items:center;gap:12px;margin-bottom:12px}
  .meta h2{font-size:16px;margin:0}
  .dim{color:#727c9c;font:13px ui-monospace,Menlo,monospace}
  .meta button{margin-left:auto;background:linear-gradient(90deg,#4F6BFF,#A44DFF);color:#fff;border:0;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer}
  .frame{width:100%;border-radius:10px;overflow:hidden;border:1px solid #1e2436}
  .frame svg{width:100%;height:auto;display:block}
  .bar{position:sticky;top:0;z-index:5;max-width:1100px;margin:0 auto 20px;display:flex;gap:10px}
  .bar button{background:#182036;color:#cdd6f4;border:1px solid #2a3350;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer}
</style></head><body>
<header><h1>Web Agent — Chrome Web Store promo assets</h1>
<p>Rendered client-side from inline SVG. Click <b>Download JPG</b> for a store-ready file (JPEG, no alpha) at the exact required size.</p></header>
<div class="bar"><button onclick="cards.forEach(c=>dl(c.id,c.w,c.h))">Download all</button></div>
<main>${sections}</main>
<script>
const cards=${JSON.stringify(rendered.map((c) => ({ id: c.id, w: c.w, h: c.h })))};
function dl(id,w,h){
  const svgEl=document.querySelector('#card-'+id+' svg');
  const xml=new XMLSerializer().serializeToString(svgEl);
  const url='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(xml)));
  const img=new Image();
  img.onload=()=>{
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const x=c.getContext('2d');x.fillStyle='#0B1020';x.fillRect(0,0,w,h);x.drawImage(img,0,0,w,h);
    c.toBlob(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=id+'.jpg';a.click();},'image/jpeg',0.94);
  };
  img.src=url;
}
</script></body></html>`;

writeFileSync(join(ROOT, 'promo.html'), html);
console.log('wrote', rendered.length, 'SVGs + promo.html');
