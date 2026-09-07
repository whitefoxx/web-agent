/**
 * Map a tool-trace into a compact activity-timeline row — a semantic icon key +
 * a concise Chinese label (Claude-for-Chrome-style) — plus screenshot-thumbnail
 * extraction. Pure, so the labels are unit-tested. See tests/activity.test.ts.
 */
import type { ToolTrace } from '../messages';

export type ActivityIcon =
  | 'navigate'
  | 'read'
  | 'search'
  | 'camera'
  | 'click'
  | 'type'
  | 'scroll'
  | 'plan'
  | 'subagent'
  | 'memory'
  | 'image'
  | 'site'
  | 'action';

export interface Activity {
  icon: ActivityIcon;
  label: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function clip(s: string, n = 40): string {
  s = s.trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function shortUrl(u: string): string {
  return clip(u.replace(/^https?:\/\//, ''), 42);
}
function siteOf(tool: string): string {
  const i = tool.indexOf('__');
  return i >= 0 ? tool.slice(0, i) : '';
}
function nameOf(tool: string): string {
  const i = tool.indexOf('__');
  return i >= 0 ? tool.slice(i + 2) : tool;
}

/** Tool → {icon, concise Chinese label} for the activity timeline. */
export function toolActivity(trace: ToolTrace): Activity {
  const tool = trace.tool ?? '';
  const a = trace.args ?? {};
  const site = siteOf(tool);
  const name = nameOf(tool);

  // Engine pseudo-tools (intercepted, never dispatched).
  switch (tool) {
    case 'update_plan':
      return { icon: 'plan', label: 'Update plan' };
    case 'submit_plan':
      return { icon: 'plan', label: 'Submit plan' };
    case 'spawn_subagent':
      return { icon: 'subagent', label: `Subtask: ${clip(str(a.task), 24)}` };
    case 'remember':
      return { icon: 'memory', label: `Remember: ${clip(str(a.fact), 24)}` };
    case 'view_image':
      return { icon: 'image', label: 'View image' };
    case 'generate_image':
      return { icon: 'image', label: 'Generate image' };
  }

  // Generic web primitives.
  switch (tool) {
    case 'generic__open_url':
      return { icon: 'navigate', label: `Open ${shortUrl(str(a.url))}` };
    case 'generic__get_page_text':
      return { icon: 'read', label: 'Read page text' };
    case 'generic__get_interactives':
      return { icon: 'read', label: 'Read interactive elements' };
    case 'generic__screenshot':
      return { icon: 'camera', label: 'Screenshot' };
    case 'generic__click':
      return { icon: 'click', label: a.text ? `Click "${clip(str(a.text), 18)}"` : 'Click' };
    case 'generic__type_into':
      return { icon: 'type', label: a.text ? `Type "${clip(str(a.text), 18)}"` : 'Type text' };
    case 'generic__scroll_page':
      return { icon: 'scroll', label: 'Scroll page' };
    case 'generic__close_tab':
      return { icon: 'navigate', label: 'Close tab' };
  }

  // Site adapters: searchy commands get a magnifier, the rest a globe.
  const query = str(a.query) || str(a.keyword) || str(a.q) || str(a.search);
  if (/search|搜索/i.test(name) || query) {
    return {
      icon: 'search',
      label: query ? `Search ${site || 'page'} for "${clip(query, 22)}"` : `${site} · ${name}`,
    };
  }
  if (site) return { icon: 'site', label: `${site} · ${name}` };
  return { icon: 'action', label: name || tool || 'Run action' };
}

const SITE_DOMAINS: Record<string, string> = {
  youtube: 'youtube.com',
  bilibili: 'bilibili.com',
  b站: 'bilibili.com',
  小红书: 'xiaohongshu.com',
  xiaohongshu: 'xiaohongshu.com',
  微博: 'weibo.com',
  weibo: 'weibo.com',
  twitter: 'twitter.com',
  知乎: 'zhihu.com',
  zhihu: 'zhihu.com',
  reddit: 'reddit.com',
  linkedin: 'linkedin.com',
  github: 'github.com',
  豆瓣: 'douban.com',
  douban: 'douban.com',
  微信读书: 'weread.qq.com',
  weread: 'weread.qq.com',
  v2ex: 'v2ex.com',
  抖音: 'douyin.com',
  douyin: 'douyin.com',
};

/** Best-effort detection of the sites a plan touches, for display in the plan
 * card ("sites involved"). Scans the goal + steps text for known site names and
 * explicit domains. Display-only — NOT an enforced per-run allowlist. */
export function planSites(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const [k, d] of Object.entries(SITE_DOMAINS)) {
    if (t.includes(k.toLowerCase())) out.add(d);
  }
  for (const m of t.matchAll(/\b([a-z0-9-]+\.(?:com|cn|org|net|io))\b/g)) out.add(m[1]!);
  return [...out].slice(0, 6);
}

/** Find a screenshot data URL anywhere in a tool result (string or nested
 * object) so the timeline can show an inline thumbnail. null if none. */
export function screenshotDataUrl(result: unknown): string | null {
  const seen = new Set<unknown>();
  function walk(v: unknown): string | null {
    if (typeof v === 'string') {
      const m = v.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/);
      return m ? m[0] : null;
    }
    if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      for (const x of Object.values(v as Record<string, unknown>)) {
        const r = walk(x);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(result);
}
