/**
 * Tool subsetting pure helper (src/agent/tool-select.ts). docs §10.12.
 */
import { describe, expect, it } from 'vitest';
import { selectTools } from '../src/agent/tool-select';

const T = (name: string) => ({ type: 'function' as const, function: { name, description: '' } });
const many = (n: number, site: string) => Array.from({ length: n }, (_, i) => T(`${site}__c${i}`));

describe('selectTools', () => {
  it('returns all unchanged when under the threshold', () => {
    const tools = [T('generic__open_url'), T('bilibili__hot')];
    const sel = selectTools(tools, '看 bilibili', { threshold: 40 });
    expect(sel.narrowed).toBe(false);
    expect(sel.tools).toHaveLength(2);
  });

  it('narrows to generic + the named site when over threshold', () => {
    const tools = [...many(10, 'generic'), ...many(20, 'bilibili'), ...many(20, 'twitter')];
    const sel = selectTools(tools, '帮我看 bilibili 的视频', { threshold: 40 });
    expect(sel.narrowed).toBe(true);
    expect(sel.dropped).toBe(20); // twitter dropped
    expect(sel.tools.some((t) => t.function.name.startsWith('twitter__'))).toBe(false);
    expect(sel.tools.filter((t) => t.function.name.startsWith('bilibili__'))).toHaveLength(20);
    expect(sel.tools.filter((t) => t.function.name.startsWith('generic__'))).toHaveLength(10);
  });

  it('keeps ALL when the task names no recognizable site (no stranding)', () => {
    const tools = [...many(10, 'generic'), ...many(40, 'bilibili')];
    const sel = selectTools(tools, '随便看看', { threshold: 40 });
    expect(sel.narrowed).toBe(false);
    expect(sel.tools).toHaveLength(50);
  });

  it('keeps multiple named sites', () => {
    const tools = [...many(5, 'generic'), ...many(30, 'bilibili'), ...many(30, 'weibo')];
    const sel = selectTools(tools, '对比 bilibili 和 weibo', { threshold: 40 });
    expect(sel.tools.some((t) => t.function.name.startsWith('bilibili__'))).toBe(true);
    expect(sel.tools.some((t) => t.function.name.startsWith('weibo__'))).toBe(true);
    expect(sel.dropped).toBe(0);
  });
});
