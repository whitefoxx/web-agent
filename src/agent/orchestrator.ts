/**
 * Agent orchestrator — runs a single multi-turn session.
 *
 * Flow (one call to `runSession`):
 *
 *   build first-turn prompt (system + user request)
 *     │
 *     ▼
 *   inject into DeepSeek tab  ◄────────┐
 *     │                                 │ next iteration
 *     ▼                                 │
 *   wait for CHATBOT_RESPONSE           │
 *     │                                 │
 *     ▼                                 │
 *   commands.length === 0 → DONE        │
 *   else process each command, build    │
 *   "tool result" prompt, loop ─────────┘
 *
 * The orchestrator does not own message routing. It calls into the supplied
 * `Driver` for "inject" and "wait for response" — the service worker wires
 * those to actual chrome.* APIs. This keeps the loop unit-testable.
 */

import {
  buildFirstTurnPrompt,
  formatDescribeToolResult,
  formatListToolsResult,
  formatToolResultPrompt,
} from './system-prompt';
import { log, warn, error as logError } from '../runtime/log';
import { appendTurn, type SessionState, newIterationId, saveSession } from './session';
import type { ParsedCommand, ToolTrace } from '../connectors/messages';

export interface ChatbotResponse {
  rawText: string;
  cleanedText: string;
  reasoningText?: string;
  commands: ParsedCommand[];
}

export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface Driver {
  /** Open / focus a fresh DeepSeek chat (clicks "New chat"). MVP: optional;
   * if not implemented, we just keep the existing conversation. */
  startFreshChat?(): Promise<void>;
  /** Inject `text` into the chatbot tab and trigger submit. */
  inject(opts: { iterationId: string; text: string }): Promise<void>;
  /** Block until the chatbot's response is fully received. */
  waitForResponse(opts: { iterationId: string; timeoutMs?: number }): Promise<ChatbotResponse>;
  /** Run a tool by name. */
  executeTool(opts: { tool: string; args: Record<string, unknown> }): Promise<ToolExecResult>;
  /** Emit UI events (assistant text, tool trace, session done). */
  emit(evt: OrchEvent): void;
}

export type SessionDoneReason =
  | 'no_more_commands'
  | 'done_signal'
  | 'max_iterations'
  | 'error'
  | 'user_abort';

export type OrchEvent =
  | {
      type: 'assistant_turn';
      iteration: number;
      cleanedText: string;
      rawText?: string;
      reasoningText?: string;
      commands: ParsedCommand[];
    }
  | { type: 'tool_trace'; trace: ToolTrace }
  | {
      type: 'session_done';
      reason: SessionDoneReason;
      error?: string;
    };

export interface RunOptions {
  session: SessionState;
  userText: string;
  driver: Driver;
  signal?: AbortSignal;
  maxIterations?: number;
  /** Skip the write-op safety filter when listing tools in the first turn. */
  showAllTools?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

export async function runSession(opts: RunOptions): Promise<void> {
  const { session, userText, driver } = opts;
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  log('loop', `session=${session.id} run() begin`, { userText: userText.slice(0, 80) });

  session.status = 'running';
  appendTurn(session, { role: 'user', text: userText, ts: Date.now() });
  await saveSession(session);

  // Start fresh chat in the chatbot tab if the driver supports it.
  try {
    await driver.startFreshChat?.();
  } catch (e) {
    warn('loop', 'startFreshChat failed (continuing in existing conversation)', e);
  }

  let nextPrompt = buildFirstTurnPrompt({ userText, showAllTools: opts.showAllTools });

  for (session.iterations = 0; session.iterations < maxIter; session.iterations++) {
    if (opts.signal?.aborted) return finish('user_abort');

    const iterationId = newIterationId(session);
    log('loop', `iter ${session.iterations} → inject (${nextPrompt.length} chars)`);
    try {
      await driver.inject({ iterationId, text: nextPrompt });
    } catch (e) {
      logError('loop', 'inject failed', e);
      return finish('error', e instanceof Error ? e.message : String(e));
    }

    let response: ChatbotResponse;
    try {
      response = await driver.waitForResponse({
        iterationId,
        timeoutMs: DEFAULT_RESPONSE_TIMEOUT_MS,
      });
    } catch (e) {
      logError('loop', 'waitForResponse failed', e);
      return finish('error', e instanceof Error ? e.message : String(e));
    }

    log('loop', `iter ${session.iterations} ← response`, {
      cleanedLen: response.cleanedText.length,
      reasoningLen: response.reasoningText?.length ?? 0,
      commandCount: response.commands.length,
    });

    appendTurn(session, {
      role: 'assistant',
      cleanedText: response.cleanedText,
      reasoningText: response.reasoningText,
      commands: response.commands,
      iteration: session.iterations,
      ts: Date.now(),
    });
    driver.emit({
      type: 'assistant_turn',
      iteration: session.iterations,
      cleanedText: response.cleanedText,
      rawText: response.rawText,
      reasoningText: response.reasoningText,
      commands: response.commands,
    });
    await saveSession(session);

    if (response.commands.length === 0) {
      return finish('no_more_commands');
    }

    // Process commands in order, building the next user-side prompt.
    const resultChunks: string[] = [];
    let doneRequested = false;
    for (const cmd of response.commands) {
      if (opts.signal?.aborted) return finish('user_abort');
      const chunk = await runOneCommand(cmd, driver, session);
      if (chunk === DONE_SENTINEL) {
        doneRequested = true;
        break;
      }
      if (chunk) resultChunks.push(chunk);
    }
    if (doneRequested) return finish('done_signal');
    nextPrompt = resultChunks.join('\n\n---\n\n');
  }
  return finish('max_iterations');

  function finish(reason: SessionDoneReason, err?: string): void {
    session.status = reason === 'error' ? 'error' : reason === 'user_abort' ? 'aborted' : 'idle';
    void saveSession(session);
    driver.emit({ type: 'session_done', reason, error: err });
    log('loop', `session=${session.id} done`, { reason, err });
  }
}

const DONE_SENTINEL = Symbol('done');
type CommandChunk = string | typeof DONE_SENTINEL | null;

async function runOneCommand(
  cmd: ParsedCommand,
  driver: Driver,
  session: SessionState,
): Promise<CommandChunk> {
  const traceId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  driver.emit({
    type: 'tool_trace',
    trace: {
      id: traceId,
      action: cmd.action,
      tool: cmd.tool,
      args: cmd.args,
      status: 'started',
    },
  });
  appendTurn(session, {
    role: 'tool_trace',
    trace: { id: traceId, action: cmd.action, tool: cmd.tool, args: cmd.args, status: 'started' },
    ts: Date.now(),
  });

  let chunk: CommandChunk;
  const traceFinal: ToolTrace = {
    id: traceId,
    action: cmd.action,
    tool: cmd.tool,
    args: cmd.args,
    status: 'completed',
    durationMs: 0,
  };

  try {
    switch (cmd.action) {
      case 'list_tools': {
        const category =
          typeof cmd.args?.category === 'string' ? (cmd.args.category as string) : undefined;
        chunk = formatListToolsResult(category);
        traceFinal.result = chunk;
        break;
      }
      case 'describe_tool': {
        const name = typeof cmd.args?.name === 'string' ? (cmd.args.name as string) : undefined;
        if (!name) {
          chunk = `## describe_tool 缺少 name 参数。`;
          traceFinal.status = 'failed';
          traceFinal.error = 'missing name';
        } else {
          chunk = formatDescribeToolResult(name);
          traceFinal.result = chunk;
        }
        break;
      }
      case 'execute_tool': {
        const tool = cmd.tool;
        const args = cmd.args ?? {};
        if (!tool) {
          chunk = `## execute_tool 缺少 tool 参数。`;
          traceFinal.status = 'failed';
          traceFinal.error = 'missing tool';
          break;
        }
        const r = await driver.executeTool({ tool, args });
        chunk = formatToolResultPrompt({
          tool,
          args,
          ok: r.ok,
          result: r.result,
          error: r.error,
          iteration: session.iterations,
        });
        traceFinal.status = r.ok ? 'completed' : 'failed';
        traceFinal.result = r.result;
        traceFinal.error = r.error;
        break;
      }
      case 'done': {
        chunk = DONE_SENTINEL;
        break;
      }
      case 'parse_error': {
        chunk = `## 指令解析失败\n\n${cmd.message ?? '(unknown)'}\n\n请检查你的 agent-command 代码块格式：必须是合法 JSON。`;
        traceFinal.status = 'failed';
        traceFinal.error = cmd.message ?? 'parse_error';
        break;
      }
      default: {
        chunk = `## 未知 action: ${cmd.action}\n\n支持的 action: list_tools / describe_tool / execute_tool / done`;
        traceFinal.status = 'failed';
        traceFinal.error = `unknown action: ${cmd.action}`;
        break;
      }
    }
  } catch (e) {
    traceFinal.status = 'failed';
    traceFinal.error = e instanceof Error ? e.message : String(e);
    chunk = `## 指令执行抛错\n\n${traceFinal.error}`;
  }
  // Every code path in the switch (and the catch block) assigns `chunk`, but
  // TS can't prove that statically; default to null so the function still
  // type-checks.
  chunk ??= null;

  traceFinal.durationMs = Date.now() - t0;
  driver.emit({ type: 'tool_trace', trace: traceFinal });
  appendTurn(session, { role: 'tool_trace', trace: traceFinal, ts: Date.now() });

  return chunk;
}
