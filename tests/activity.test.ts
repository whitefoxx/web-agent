/**
 * Activity-timeline mapping (src/sidepanel/activity.ts).
 */
import { describe, expect, it } from 'vitest';
import { planSites, screenshotDataUrl, toolActivity } from '../src/sidepanel/activity';
import type { ToolTrace } from '../src/messages';

const T = (tool: string, args: Record<string, unknown> = {}): ToolTrace => ({
  id: 't',
  action: 'execute_tool',
  tool,
  args,
  status: 'completed',
});

describe('toolActivity', () => {
  it('labels generic web primitives with the right icon', () => {
    expect(
      toolActivity(T('generic__open_url', { url: 'https://youtube.com/results?q=x' })),
    ).toEqual({
      icon: 'navigate',
      label: 'Open youtube.com/results?q=x',
    });
    expect(toolActivity(T('generic__get_page_text')).icon).toBe('read');
    expect(toolActivity(T('generic__screenshot'))).toEqual({ icon: 'camera', label: 'Screenshot' });
    expect(toolActivity(T('generic__click', { text: '登录按钮' }))).toEqual({
      icon: 'click',
      label: 'Click "登录按钮"',
    });
  });

  it('labels engine pseudo-tools', () => {
    expect(toolActivity(T('update_plan')).icon).toBe('plan');
    expect(toolActivity(T('spawn_subagent', { task: '抓取并对比' })).label).toContain('Subtask');
    expect(toolActivity(T('remember', { fact: '常用账号 X' })).label).toContain('Remember');
  });

  it('detects searchy site adapters', () => {
    const a = toolActivity(T('bilibili__search', { keyword: 'agent harness' }));
    expect(a.icon).toBe('search');
    expect(a.label).toContain('bilibili');
    expect(a.label).toContain('agent harness');
  });

  it('falls back to site · name for other site adapters', () => {
    expect(toolActivity(T('bilibili__subtitle', { bvid: 'x' }))).toEqual({
      icon: 'site',
      label: 'bilibili · subtitle',
    });
  });
});

describe('planSites', () => {
  it('detects known site names + explicit domains', () => {
    expect(planSites('在 youtube 上搜索，再看 bilibili')).toEqual(
      expect.arrayContaining(['youtube.com', 'bilibili.com']),
    );
    expect(planSites('打开 example.com 抓取内容')).toContain('example.com');
  });
  it('returns [] when no site is mentioned', () => {
    expect(planSites('帮我算一下 2 加 2')).toEqual([]);
  });
});

describe('screenshotDataUrl', () => {
  it('finds a data:image URL in a nested result', () => {
    const url = 'data:image/png;base64,AAAA';
    expect(screenshotDataUrl({ image: url, meta: 1 })).toBe(url);
  });
  it('returns null when there is no image', () => {
    expect(screenshotDataUrl({ text: 'hello' })).toBeNull();
    expect(screenshotDataUrl('plain')).toBeNull();
  });
});
