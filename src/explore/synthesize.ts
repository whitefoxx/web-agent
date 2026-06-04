/**
 * Synthesis (P3): turn an explore trace into a deterministic opencli adapter.
 *
 * One LLM call. The system prompt internalizes opencli's adapter-author
 * knowledge (strategy selection, cli() shape, signed-token handling, prefer a
 * single fetch over DOM scraping). Input is a compact digest of the trace
 * (deduped endpoints + body samples + action sequence + a DOM snapshot). Output
 * is an opencli `cli({...})` source string the existing sandbox-eval install
 * path can consume verbatim. See docs/llm-explore.md.
 */

import { chatCompletion } from '../agent/api-engine';
import { log, warn } from '../runtime/log';
import type { Trace, TraceActionEvent, TraceNetworkEvent, TraceStateEvent } from './types';

export interface SynthModel {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface SynthResult {
  ok: boolean;
  source?: string;
  site?: string;
  name?: string;
  summary?: string;
  /** Example args to verify the adapter with (from the trace). */
  testArgs?: Record<string, unknown>;
  error?: string;
}

const MAX_BODY_SAMPLE = 1800;
const MAX_HTML_SAMPLE = 6000;
const MAX_ENDPOINTS = 14;
const MAX_ACTIONS = 40;

const SYSTEM_PROMPT = `你是 opencli 适配器合成器。给你一次"探索"录制(动作序列 + 抓到的 XHR/Fetch 接口及响应 + DOM 快照),你要产出一个**确定性、不依赖 LLM** 的适配器源码,之后可直接重复运行。

输出格式(严格):
1. 先用一行中文说明你选的策略和理由。
2. 然后给一个 \`\`\`js 代码块,内容是完整可安装的 opencli 适配器源码。
3. 最后再给一个 \`\`\`json 代码块,是用来**验证**该适配器的一组真实示例参数(从录制里取真实值,比如真实的 url / 关键词),键名要和 args 完全一致,例如 {"url":"https://...","limit":10}。没有参数就给 {}。

适配器源码规范(与 marketplace 适配器一致):
\`\`\`js
import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
  site: '<站点小写标识,如 zhihu>',
  name: '<命令名,小写+下划线,如 hot 或 note_comments>',
  access: 'read',                 // 写操作才用 'write'
  description: '<一句话中文说明>',
  domain: '<主域名,如 www.zhihu.com>',
  args: [{ name: 'url', type: 'string', required: true, help: '...' }],  // 按需
  columns: ['rank', '...'],       // 输出对象的列名
  func: async (page, kwargs) => { /* 见下 */ },
});
\`\`\`

策略选择(看录制证据,优先级从高到低):
- **接口直取(最佳)**:如果某个 XHR/Fetch 接口直接返回了业务数据(JSON),就在 func 里复现它:
  \`await page.goto(<承载页 URL>)\` 然后
  \`const data = await page.evaluate('fetch("<接口URL>", {credentials:"include"}).then(r=>r.json())')\`
  再把字段映射成 columns。这样带着用户登录态、零 LLM。
- **签名/一次性 token**:接口 URL 里如果有每次都变的签名/token(如 xsec_token、sign),**不要**硬编码那个 URL。改成:先 goto 承载页,让页面自己的 JS 去发请求/签名,然后用 \`page.evaluate\` 读取页面内的 fetch 结果;或直接走 DOM 抓取。
- **DOM 抓取**:数据只在渲染后的 DOM 里时,func 里 \`await page.goto(url)\`、必要时 \`await page.wait({time:2})\` 或 \`page.autoScroll(...)\`,再 \`page.evaluate\` 用 document.querySelectorAll 抓取。

func 约定:
- 签名固定为 \`async (page, kwargs) => {...}\`,返回**对象数组**,每个对象的键要和 columns 完全一致。
- page 是 opencli 的 IPage:有 goto/evaluate/wait/autoScroll/getCookies 等。page.evaluate 接收一段 JS 字符串(可写 IIFE 或 \`async () => {...}\`),在页面 MAIN world 执行并返回可序列化结果。
- 用 kwargs 读取参数(如 kwargs.url、kwargs.limit),做基本校验。
- 数据为空就 \`throw new Error('...')\`。
- 只用录制里出现过的真实接口/选择器,别编造。`;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s;
}

/** Compact the trace into a token-bounded digest for the synthesis prompt. */
export function buildTraceDigest(trace: Trace): string {
  const actions = trace.events.filter((e): e is TraceActionEvent => e.stream === 'action');
  const networks = trace.events.filter((e): e is TraceNetworkEvent => e.stream === 'network');
  const states = trace.events.filter((e): e is TraceStateEvent => e.stream === 'state');

  const parts: string[] = [];
  parts.push(`## 任务\n${trace.task ?? '(未提供)'}`);
  if (trace.site) parts.push(`## 站点\n${trace.site}`);
  if (trace.url) parts.push(`## 起始 URL\n${trace.url}`);

  // Dedup endpoints by method+path; keep the richest (has-body, JSON) first.
  const byKey = new Map<string, TraceNetworkEvent>();
  for (const n of networks) {
    let path = n.url;
    try {
      const u = new URL(n.url);
      path = `${u.origin}${u.pathname}`;
    } catch {
      /* keep raw */
    }
    const key = `${n.method} ${path}`;
    const prev = byKey.get(key);
    // Prefer the instance that actually carries a body.
    if (!prev || (!prev.responseBody && n.responseBody)) byKey.set(key, n);
  }
  const endpoints = [...byKey.values()]
    .sort((a, b) => (b.responseBody ? 1 : 0) - (a.responseBody ? 1 : 0))
    .slice(0, MAX_ENDPOINTS);

  if (endpoints.length) {
    const lines = endpoints.map((n, i) => {
      const head = `${i + 1}. ${n.method} ${n.url}\n   status=${n.status ?? '?'} type=${n.contentType ?? '?'}`;
      const body = n.responseBody
        ? `\n   响应体样本: ${clip(n.responseBody, MAX_BODY_SAMPLE)}`
        : '';
      const reqBody = n.requestBody ? `\n   请求体: ${clip(n.requestBody, 300)}` : '';
      return head + reqBody + body;
    });
    parts.push(`## 捕获到的接口(${endpoints.length})\n${lines.join('\n')}`);
  } else {
    parts.push('## 捕获到的接口\n(无 XHR/Fetch — 数据可能只在 DOM 里,考虑 DOM 抓取)');
  }

  if (actions.length) {
    const lines = actions.slice(0, MAX_ACTIONS).map((a) => {
      const args = a.args ? clip(JSON.stringify(a.args), 200) : '';
      return `- ${a.tool}(${args}) → ${a.status}${a.resultDigest ? ` ${clip(a.resultDigest, 160)}` : ''}`;
    });
    parts.push(`## 动作序列\n${lines.join('\n')}`);
  }

  // Most recent / largest DOM snapshot, for the scrape fallback.
  const snap = states
    .filter((s) => typeof s.html === 'string' && s.html)
    .sort((a, b) => (b.html?.length ?? 0) - (a.html?.length ?? 0))[0];
  if (snap?.html) {
    parts.push(`## DOM 快照(${snap.url ?? ''})\n${clip(snap.html, MAX_HTML_SAMPLE)}`);
  }

  return parts.join('\n\n');
}

/** Pull the adapter source: prefer an explicitly js/ts-tagged fence (so a
 * trailing ```json verify block isn't mistaken for the source); fall back to
 * the first fence of any kind, then the whole string. */
function extractSource(content: string): { source: string; summary: string } {
  const typed = /```(?:js|javascript|ts|typescript)\s+([\s\S]*?)```/.exec(content);
  const fence = typed ?? /```\s*([\s\S]*?)```/.exec(content);
  if (fence) {
    const summary = content.slice(0, fence.index).trim().split('\n').filter(Boolean).pop() ?? '';
    return { source: fence[1].trim(), summary };
  }
  return { source: content.trim(), summary: '' };
}

/** Pull a ```json fenced block as the verify args; {} on absence/parse error. */
function extractTestArgs(content: string): Record<string, unknown> {
  const m = /```json\s*([\s\S]*?)```/.exec(content);
  if (!m) return {};
  try {
    const v = JSON.parse(m[1].trim());
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseField(source: string, field: string): string | undefined {
  const m = new RegExp(`${field}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`).exec(source);
  return m?.[1];
}

export async function synthesizeAdapter(
  trace: Trace,
  model: SynthModel,
  opts: { signal?: AbortSignal; repair?: { prevSource: string; error: string } } = {},
): Promise<SynthResult> {
  const digest = buildTraceDigest(trace);
  const userContent = opts.repair
    ? `${digest}\n\n## 上一版适配器(运行失败,请修复)\n\`\`\`js\n${clip(opts.repair.prevSource, 6000)}\n\`\`\`\n\n## 运行报错\n${clip(opts.repair.error, 1500)}\n\n请针对报错修正后,按相同的输出格式重新给出修正版源码 + 验证参数。`
    : digest;
  log(
    'explore',
    `synthesize${opts.repair ? '(repair)' : ''}: trace=${trace.traceId} input=${userContent.length} chars`,
  );
  let resp;
  try {
    resp = await chatCompletion({
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      signal: opts.signal,
      body: {
        model: model.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        max_tokens: 4096,
      },
    });
  } catch (e) {
    warn('explore', 'synthesize chatCompletion failed', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const content = resp.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) return { ok: false, error: 'synthesis returned empty content' };

  const { source, summary } = extractSource(content);
  const testArgs = extractTestArgs(content);
  const site = parseField(source, 'site');
  const name = parseField(source, 'name');
  if (!site || !name || !/cli\s*\(/.test(source)) {
    return {
      ok: false,
      error: 'synthesis output is not a recognizable cli({...}) adapter',
      summary,
    };
  }
  log('explore', `synthesize ok → ${site}/${name} (${source.length} chars)`);
  return { ok: true, source, site, name, summary, testArgs };
}
