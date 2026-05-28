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

/** Adapter names to hide from the first-turn overview. Writes against the
 * user's account (publish / comment-create) stay hidden until they're
 * explicitly described — keeps the chatbot from absent-mindedly listing
 * them as options. The runtime still gates them behind a per-call user
 * confirmation dialog (see WRITE_CONFIRM_REQ wiring in service-worker.ts),
 * so even if the chatbot describes-and-executes one, nothing fires
 * without a green light from the user. */
const HIDDEN_BY_DEFAULT = new Set(['xiaohongshu__publish', 'xiaohongshu__comment-create']);

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

/** Short reminder appended after a follow-up user message in continuation
 * mode. Chatbots drift back to default behaviour over many turns; this
 * line keeps the agent-command protocol and the "judge intent" mindset
 * salient without re-spending the tokens of a full first-turn prompt. */
export function buildContinuationReminder(userText: string): string {
  return [
    userText.trim(),
    '',
    '> [WebChat Agent 提醒] 当前是 WebChat Agent 会话。判断用户意图：通用问题直接回答；需要实时 / 外部数据（小红书 / 网页等）用 `<agent-command>JSON</agent-command>` 调工具（action: `list_tools` / `describe_tool` / `execute_tool` / `done`）；模糊就反问澄清。',
  ].join('\n');
}

/** Max chars of a tool result the chatbot sees in any one iteration. Sized
 * for a 64K-token DeepSeek context: a typical token is ~3 chars (mixed
 * Chinese + English + JSON punctuation), so 64K chars ≈ 20K tokens —
 * leaves plenty for the rest of the conv history + first-turn prompt + the
 * chatbot's reply. If a tool genuinely returns more than this, prefer
 * adding pagination / filtering args to the tool over bumping this number. */
const MAX_TOOL_RESULT_CHARS = 64_000;

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
    ? ['```json', truncate(safeStringify(opts.result), MAX_TOOL_RESULT_CHARS), '```']
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
      const sig = renderArgSignature(it.args ?? []);
      lines.push(`- \`${tn}${sig}\`${writeFlag} — ${it.description ?? '(no description)'}`);
    }
  }
  lines.push(
    '',
    '> 调用工具时 `args` 字段里的键名必须**严格**匹配上面括号里的参数名（区分大小写）。不确定时先 `describe_tool` 查 schema —— 别凭语义猜参数名（例如别把 `query` 写成 `keyword` 或 `q`）。',
  );
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

/** "(query, limit?)" style one-line arg signature for the first-turn
 *  catalog. Required args have no trailing `?`; optional do. Non-string
 *  types get a `:int` / `:bool` annotation. */
function renderArgSignature(args: AdapterArg[]): string {
  if (args.length === 0) return '()';
  return (
    '(' +
    args
      .map((a) => {
        const typ = a.type && a.type !== 'string' ? `:${a.type}` : '';
        return a.required ? `${a.name}${typ}` : `${a.name}${typ}?`;
      })
      .join(', ') +
    ')'
  );
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
你是 **WebChat Agent** —— 一个跑在用户浏览器扩展里的 AI 助手。你有三种回答方式可选，**请根据用户意图自行判断该用哪一种**：

1. **直接回答**：用你已有的知识 / 推理回答问题（适合通用知识、概念解释、代码问题、写作、翻译、计算等）。
2. **调用工具**：通过 \`<agent-command>JSON</agent-command>\` 调用我们扩展提供的工具，访问外部站点的实时数据（小红书 / 网页等）。
3. **反问澄清**：意图模糊时主动反问用户，例如「你想看小红书的真人评价，还是想要一份综合介绍？」

## 何时该用哪种 — 判断指南

| 用户问的是… | 选哪种 |
|------|--------|
| 通用知识 / 概念 / 代码 / 写作 / 翻译 / 计算 | 直接回答 |
| 实时 / 私域数据，明确点名小红书 / 某账号 / 当前网页 | 调用工具 |
| 「最近什么火」「现在 X 怎么样」「我的 X 上有什么」这类**时效或个人化**问题 | 调用工具 |
| 模糊到无法判断（"扫地机器人哪个好"既可能想要通用对比也可能想要小红书真人种草） | 先反问澄清，或简要回答后问"要不要让我去小红书看看真实评价？" |

写代码 / 解释概念时不要无谓地去调用工具；查实时数据时不要凭你的训练记忆瞎编。

## 工具调用协议

当你决定调用工具时，输出格式：

<agent-command>
{"action":"<动作>", ...}
</agent-command>

**不要用 \`\`\`agent-command\`\`\` 这种代码块格式** —— 聊天网页会给代码块加 Copy/Download/语法高亮等特殊样式，干扰指令抽取。用上面这种自定义 HTML 标签最稳。

自然语言和 \`<agent-command>\` 可以混在同一条回复里：先用自然语言说明你打算做什么，再输出指令块。一条回复可以含多个指令块（顺序执行），但**通常一次只调一个工具、等结果再决定下一步**更稳。

每次工具执行完成后，系统会自动把结果作为下一条用户消息发给你。基于结果决定下一步：继续调用工具，或用自然语言给出最终答复。

不需要工具就直接用自然语言回答即可（不要输出 \`<agent-command>\`），本轮就结束了。
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

1. **先判断意图再决定要不要调工具**。能直接回答的别绕弯子调工具；需要实时数据的也别凭记忆瞎编。
2. 不熟悉的工具先 \`describe_tool\` 拿完整 schema，避免参数错误。
3. 一次只调用一个工具，等结果出来再决定下一步。
4. 收集够信息后，**不要**再输出 \`<agent-command>\`——用自然语言直接回答用户。
5. 工具失败时，看错误信息：可能是参数错了、用户没登录、被限流；不要无脑重试，重试 1 次仍失败就把情况告诉用户、问要不要换个思路。
6. 涉及账号写操作（发布笔记、评论回复等）的工具默认在概览里隐藏；如果用户明确要求，先用 \`describe_tool\` 学习它再调用。注意：所有 \`access: 'write'\` 工具在 \`execute_tool\` 时会触发用户**二次确认弹窗**，没用户点击同意你的调用就不会真正执行。这是兜底机制；你仍需自己先用自然语言征求用户意见，确认后再发起调用。
7. 模糊请求要敢于反问，不要硬猜。比如「我想看看那个产品」—— 反问「哪个产品？或者你想我去小红书搜什么关键词？」。
`;
