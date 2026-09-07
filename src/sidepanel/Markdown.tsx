/**
 * Render markdown safely. Chatbot output is treated as untrusted: parse with
 * `marked` (GFM) and sanitize with DOMPurify before insertion. All links
 * open in a new tab so a misclick can't replace the side panel.
 *
 * With `cite`, agent replies get citation rendering: a trailing Sources block is
 * split off + styled, and inline `[n]` markers that map to a listed source turn
 * into clickable superscripts. See src/agent/citations.ts for the producing end.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: false,
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** A source heading line — matches 来源 / 参考 / 引用 / Sources / References (kept in sync with citations.ts). */
const SOURCE_HEADING =
  /(^|\n)[ \t]*(?:来源|参考(?:资料)?|引用|Sources?|References?)[ \t]*[:：]?[ \t]*(?=\n|$)/i;

const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Parse `n → url` from a sources block. Accepts `1. [t](url)`, `1. url`, `[1] … url`. */
function parseSourceMap(block: string): Map<number, string> {
  const map = new Map<number, string>();
  const patterns = [
    /^[ \t]*(\d+)[.)、][ \t]*\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gm, // 1. [title](url)
    /^[ \t]*\[(\d+)\][ \t]*.*?(https?:\/\/[^\s)]+)/gm, //           [1] title url
    /^[ \t]*(\d+)[.)、][ \t]*<?(https?:\/\/[^\s>)]+)>?/gm, //        1. url
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const n = parseInt(m[1], 10);
      if (!map.has(n)) map.set(n, m[2]);
    }
  }
  return map;
}

/** Turn inline `[n]` (not `[n](…)`) into a superscript link to its source URL. */
function injectInlineCites(body: string, map: Map<number, string>): string {
  if (!map.size) return body;
  return body.replace(/\[(\d+)\](?!\()/g, (whole, d: string) => {
    const url = map.get(parseInt(d, 10));
    if (!url) return whole;
    return `<sup class="cite"><a href="${escAttr(url)}">${d}</a></sup>`;
  });
}

function render(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
}

export function Markdown({
  text,
  className,
  cite,
}: {
  text: string;
  className?: string;
  cite?: boolean;
}) {
  const cls = className ? `markdown ${className}` : 'markdown';

  if (cite) {
    const m = text.match(SOURCE_HEADING);
    const splitAt = m ? (m.index ?? 0) + (m[1] ? m[1].length : 0) : -1;
    const body = splitAt >= 0 ? text.slice(0, splitAt) : text;
    const block = splitAt >= 0 ? text.slice(splitAt) : '';
    const map = block ? parseSourceMap(block) : new Map<number, string>();
    let html = render(injectInlineCites(body, map));
    if (block) html += `<div class="md-sources">${render(block)}</div>`;
    return <div class={cls} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return <div class={cls} dangerouslySetInnerHTML={{ __html: render(text) }} />;
}
