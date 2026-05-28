/**
 * Layered system prompt for the chatbot. The first user turn injects the full
 * protocol overview + a short one-line summary of every available tool. The
 * chatbot can drill down via `list_tools` / `describe_tool` meta-actions
 * before invoking `execute_tool`, so individual tool schemas don't bloat the
 * first message.
 *
 * On subsequent turns we only inject tool results or meta-action responses —
 * the chatbot remembers the protocol from message 1.
 */

import { getRegistry } from '../runtime/registry.js';
import type { AdapterDef, AdapterArg } from '../tools/manifest';

/** Adapter names to hide from the first-turn overview. Write-ops live here
 * until per-action user confirmation lands. They still appear via
 * `describe_tool` so a determined chatbot can call them — but we want the
 * default path to favour read-only operations. */
const HIDDEN_BY_DEFAULT = new Set([
  'xiaohongshu__publish',
  'xiaohongshu__comment-create',
  'xiaohongshu__download',
]);

export interface BuildPromptOpts {
  userText: string;
  /** Disable the write-op safety filter and list every registered tool. */
  showAllTools?: boolean;
}

export function buildFirstTurnPrompt(opts: BuildPromptOpts): string {
  return [
    PROTOCOL_HEADER.trim(),
    '',
    renderToolCatalog({ showAllTools: opts.showAllTools }).trim(),
    '',
    META_ACTIONS.trim(),
    '',
    FLOW_GUIDE.trim(),
    '',
    '## 用户原始请求',
    '',
    opts.userText.trim(),
    '',
    '请规划下一步：可以直接回答用户，或者发起一个 agent-command 来获取你需要的信息。',
  ].join('\n');
}

/** Wrap a tool execution result as the next "user message" the chatbot sees. */
export function formatToolResultPrompt(opts: {
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  error?: string;
  iteration: number;
}): string {
  const head = opts.ok ? `## 工具结果 — ${opts.tool}` : `## 工具失败 — ${opts.tool}`;
  const argLine = opts.args ? `\n参数: ${safeStringify(opts.args)}` : '';
  const bodyLines = opts.ok
    ? ['```json', truncate(safeStringify(opts.result), 8000), '```']
    : [`错误: ${opts.error ?? '(unknown)'}`];
  return [
    head + argLine,
    '',
    ...bodyLines,
    '',
    '请基于这个结果继续：发起下一个 agent-command，或者用自然语言回答用户。',
  ].join('\n');
}

export function formatListToolsResult(category: string | undefined): string {
  const items = listTools(category);
  if (items.length === 0) {
    return `## list_tools(${category ?? 'all'}) — 无匹配工具`;
  }
  const lines = [`## list_tools(${category ?? 'all'}) — ${items.length} 个工具`, ''];
  for (const it of items) {
    lines.push(`- **${toolName(it)}** — ${it.description ?? '(no description)'}`);
  }
  lines.push('');
  lines.push('需要具体参数说明请调用 describe_tool。');
  return lines.join('\n');
}

export function formatDescribeToolResult(toolName: string): string {
  const sep = toolName.indexOf('__');
  if (sep < 0) {
    return `## describe_tool(${toolName}) — 工具名格式错误，应为 site__name`;
  }
  const site = toolName.slice(0, sep);
  const name = toolName.slice(sep + 2);
  const def = (getRegistry() as AdapterDef[]).find((d) => d.site === site && d.name === name);
  if (!def) {
    return `## describe_tool(${toolName}) — 工具不存在`;
  }
  const lines = [
    `## describe_tool(${toolName})`,
    '',
    `**描述**: ${def.description ?? '(no description)'}`,
    `**写操作**: ${def.access === 'write' ? '是 — 注意：可能影响用户账号' : '否'}`,
  ];
  if (def.domain) lines.push(`**作用域**: ${def.domain}`);
  lines.push('', '**参数**:');
  const args = def.args ?? [];
  if (args.length === 0) {
    lines.push('- (无)');
  } else {
    for (const a of args) {
      lines.push(
        `- \`${a.name}\` (${typeOf(a)}${a.required ? ', required' : ''})${a.default !== undefined ? ` default=${JSON.stringify(a.default)}` : ''}${a.help ? ` — ${a.help}` : ''}`,
      );
    }
  }
  lines.push(
    '',
    '**调用示例**:',
    '<agent-command>',
    JSON.stringify(
      {
        action: 'execute_tool',
        tool: toolName,
        args: exampleArgs(args),
      },
      null,
      2,
    ),
    '</agent-command>',
  );
  return lines.join('\n');
}

/* ───────── helpers ───────── */

function listTools(category: string | undefined): AdapterDef[] {
  const all = getRegistry() as AdapterDef[];
  if (!category) return all;
  return all.filter((a) => a.site === category);
}

function renderToolCatalog(opts: { showAllTools?: boolean }): string {
  const all = getRegistry() as AdapterDef[];
  const grouped = new Map<string, AdapterDef[]>();
  for (const a of all) {
    const list = grouped.get(a.site) ?? [];
    list.push(a);
    grouped.set(a.site, list);
  }
  const lines = ['## 可用工具'];
  for (const [site, items] of grouped) {
    lines.push('', `### ${site} (${items.length})`);
    for (const it of items) {
      const tn = toolName(it);
      if (!opts.showAllTools && HIDDEN_BY_DEFAULT.has(tn)) continue;
      const writeFlag = it.access === 'write' ? ' [write]' : '';
      lines.push(`- \`${tn}\`${writeFlag} — ${it.description ?? '(no description)'}`);
    }
  }
  if (
    !opts.showAllTools &&
    [...HIDDEN_BY_DEFAULT].some((t) => all.some((a) => toolName(a) === t))
  ) {
    lines.push(
      '',
      '> 注：涉及写操作（发布/评论/下载等）的工具默认隐藏，必须经 describe_tool 主动获取后才能调用，且仅在用户明确同意时执行。',
    );
  }
  return lines.join('\n');
}

function toolName(a: AdapterDef): string {
  return `${a.site}__${a.name}`;
}

function typeOf(a: AdapterArg): string {
  return a.type ?? 'string';
}

function exampleArgs(args: AdapterArg[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) {
    if (a.default !== undefined) {
      out[a.name] = a.default;
    } else if (!a.required) {
      continue;
    } else if (a.type === 'int') {
      out[a.name] = 0;
    } else if (a.type === 'bool') {
      out[a.name] = false;
    } else {
      out[a.name] = '...';
    }
  }
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/* ───────── static prompt sections ───────── */

const PROTOCOL_HEADER = `
你是一个浏览器 AI Agent，可以通过结构化指令调用工具来访问/操作多个网站，从而帮助用户完成任务。

## 响应协议（重要 — 严格按此格式）

当你需要调用工具时，把工具指令用 \`<agent-command>...</agent-command>\` 标签包裹一段 JSON：

<agent-command>
{"action":"<动作>", ...}
</agent-command>

**不要用 \`\`\`agent-command\`\`\` 这种代码块格式** —— 聊天网页会给代码块加 Copy/Download/语法高亮等特殊样式，干扰指令抽取。直接用上面这种自定义 HTML 标签最稳。

调用工具与自然语言可以混合在同一条回复里：先用自然语言说明你打算做什么，然后输出 \`<agent-command>\` 块。一条回复中可以包含多个 \`<agent-command>\` 块（会被顺序执行），但通常一次只调用一个工具、看完结果再决定下一步更稳。

如果你不需要任何工具就能回答，直接用自然语言回答即可（不要输出 \`<agent-command>\`），整个会话就结束。

每次工具执行完成后，系统会自动把结果作为下一条用户消息发给你。你可以基于结果决定下一步：继续调用工具，或者用自然语言给出最终答复。
`;

const META_ACTIONS = `
## 可用的 action 类型

- **list_tools**：列出某个站点/分类下的全部工具一行摘要。
  <agent-command>
  {"action":"list_tools", "args":{"category":"xiaohongshu"}}
  </agent-command>

- **describe_tool**：获取某个工具的完整参数说明 + 调用示例。
  <agent-command>
  {"action":"describe_tool", "args":{"name":"xiaohongshu__feed"}}
  </agent-command>

- **execute_tool**：真正执行工具。
  <agent-command>
  {"action":"execute_tool", "tool":"xiaohongshu__feed", "args":{"limit":10}}
  </agent-command>

- **done**：表示你已经收集到全部信息，下一条用自然语言给最终答复。这个 action 是可选的；只要回复里不再有 \`<agent-command>\` 块，循环也会终止。
  <agent-command>
  {"action":"done"}
  </agent-command>
`;

const FLOW_GUIDE = `
## 工作建议

1. 不熟悉的工具，先调用 \`describe_tool\` 拿到完整参数 schema，避免传错参数。
2. 一次只调用一个工具，等结果出来再决定下一步。
3. 收集够信息后，**不要**再输出 agent-command 块——用自然语言直接回答用户。
4. 工具失败时，看错误信息：可能是参数错了、用户没登录、被限流；不要无脑重试，重试 1 次仍失败就把情况告诉用户。
5. 涉及写操作（发布、评论、下载等）的工具默认隐藏；如果用户明确要求，先用 describe_tool 学习它，并在最终调用前**再次和用户确认**。
`;
