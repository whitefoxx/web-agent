/**
 * external-mcp — the externally_connectable JSON-RPC (MCP-shaped) tool source
 * for allowed web apps (localmd). Covers: origin gating (reject unlisted /
 * missing origins BEFORE any listener attaches), the initialize / tools/list
 * handshake, -32601 on unknown methods (and silence for id-less notifications),
 * and the web_task paths — success, engine error, LLM-not-configured, bad
 * params, per-port serialization, 1MB result truncation, and disconnect-aborts.
 * driveApiSession + loadLlmConfig are mocked; the port is a hand-rolled fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const driveApiSession = vi.hoisted(() => vi.fn());
const loadLlmConfig = vi.hoisted(() => vi.fn());
const runExternalTool = vi.hoisted(() => vi.fn());
const isExternalTool = vi.hoisted(() => vi.fn());
const recordCall = vi.hoisted(() => vi.fn());
const openAiToolsFromRegistry = vi.hoisted(() => vi.fn());

vi.mock('../src/background/engine-driver', () => ({ driveApiSession }));
vi.mock('../src/config/llm-config', () => ({ loadLlmConfig }));
// bridge-client pulls the whole SW module graph — mock it; the REAL shared
// executor (write gates included) is covered by tests/bridge-external-tool.test.ts.
vi.mock('../src/background/bridge-client', () => ({
  runExternalTool,
  isExternalTool,
  recordCall,
  BRIDGE_CALL_TIMEOUT_MS: 240_000,
}));
vi.mock('@base/tools/manifest', () => ({ openAiToolsFromRegistry }));

import { handleExternalConnect } from '../src/background/external-mcp';
import { forwardOrchEvent } from '../src/background/orch-events';
import { activeSessions } from '../src/background/active-sessions';
import type { SessionState } from '../src/agent/session';

/* ───────── harness ───────── */

function stubChrome(matches: string[] = ['http://localhost:5173/*']): void {
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '9.9.9', externally_connectable: { matches } }),
      sendMessage: () => Promise.resolve(), // orch-events' sidepanel broadcast
      lastError: undefined,
    },
  });
}

interface FakePort {
  port: chrome.runtime.Port;
  posted: Array<Record<string, unknown>>;
  send(m: unknown): void;
  disconnect(): void;
  disconnected: boolean;
  listenerCount: number;
}

function fakePort(origin?: string): FakePort {
  const posted: Array<Record<string, unknown>> = [];
  const msgHandlers: Array<(m: unknown) => void> = [];
  const discHandlers: Array<() => void> = [];
  const self: FakePort = {
    posted,
    disconnected: false,
    get listenerCount() {
      return msgHandlers.length;
    },
    send: (m) => msgHandlers.forEach((f) => f(m)),
    disconnect: () => discHandlers.forEach((f) => f()),
    port: {
      name: 'mcp',
      sender: origin ? { origin } : {},
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      disconnect: () => {
        self.disconnected = true;
      },
      onMessage: { addListener: (f: (m: unknown) => void) => msgHandlers.push(f) },
      onDisconnect: { addListener: (f: () => void) => discHandlers.push(f) },
    } as unknown as chrome.runtime.Port,
  };
  return self;
}

/** Connect from the allowed dev origin and return the wired fake port. */
function connected(): FakePort {
  const p = fakePort('http://localhost:5173');
  handleExternalConnect(p.port);
  return p;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await flush();
}

const callWebTask = (id: number, task: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'web_task', arguments: { task } },
});

beforeEach(() => {
  stubChrome();
  openAiToolsFromRegistry.mockReturnValue([]);
  isExternalTool.mockReturnValue(false);
  loadLlmConfig.mockResolvedValue({
    provider: 'p',
    baseUrl: 'https://x',
    apiKey: 'sk',
    model: 'm',
  });
  driveApiSession.mockImplementation(async (session: SessionState) => {
    session.history.push({
      role: 'assistant',
      cleanedText: '最终答案',
      commands: [],
      iteration: 0,
      ts: 1,
    });
    session.status = 'idle';
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  driveApiSession.mockReset();
  loadLlmConfig.mockReset();
  runExternalTool.mockReset();
  isExternalTool.mockReset();
  recordCall.mockReset();
  openAiToolsFromRegistry.mockReset();
});

/* ───────── origin gating ───────── */

describe('origin 校验', () => {
  it('rejects a connection from an unlisted origin without attaching listeners', () => {
    const p = fakePort('https://evil.example');
    handleExternalConnect(p.port);
    expect(p.disconnected).toBe(true);
    expect(p.listenerCount).toBe(0);
  });

  it('rejects a connection with no sender origin', () => {
    const p = fakePort(undefined);
    handleExternalConnect(p.port);
    expect(p.disconnected).toBe(true);
  });

  it('accepts the allowlisted origin', () => {
    const p = connected();
    expect(p.disconnected).toBe(false);
    expect(p.listenerCount).toBe(1);
  });

  it('refuses wildcard manifest patterns instead of widening the allowlist', () => {
    stubChrome(['*://*/*', 'http://localhost:5173/*']);
    const evil = fakePort('https://evil.example');
    handleExternalConnect(evil.port);
    expect(evil.disconnected).toBe(true);
    const ok = fakePort('http://localhost:5173');
    handleExternalConnect(ok.port);
    expect(ok.disconnected).toBe(false);
  });
});

/* ───────── handshake ───────── */

describe('initialize / tools/list', () => {
  it('answers initialize with protocol version + serverInfo from the manifest', () => {
    const p = connected();
    p.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(p.posted).toHaveLength(1);
    const msg = p.posted[0] as { jsonrpc: string; id: number; result: Record<string, unknown> };
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'web-agent', version: '9.9.9' },
      },
    });
    // Skill-level guidance for MCP clients that don't install the SKILL.md.
    expect(typeof msg.result.instructions).toBe('string');
  });

  it('lists exactly the web_task tool with a required task arg (empty registry)', () => {
    const p = connected();
    p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = p.posted[0].result as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('web_task');
    expect(result.tools[0].inputSchema).toMatchObject({ type: 'object', required: ['task'] });
  });

  it('merges the registry catalog after web_task, converted OpenAI→MCP shape', () => {
    openAiToolsFromRegistry.mockReturnValue([
      {
        type: 'function',
        function: {
          name: 'generic__list_tabs',
          description: '列出标签页',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'generic__open_url',
          description: '打开网页',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '要打开的 URL' } },
            required: ['url'],
          },
        },
      },
    ]);
    const p = connected();
    p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = p.posted[0].result as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    expect(result.tools).toHaveLength(3); // 1 (web_task) + 目录数
    expect(result.tools[0].name).toBe('web_task');
    // OpenAI {type:'function', function:{name, description, parameters}} →
    // MCP {name, description, inputSchema} — no function wrapper, no `type`.
    expect(result.tools[2]).toEqual({
      name: 'generic__open_url',
      description: '打开网页',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的 URL' } },
        required: ['url'],
      },
    });
  });
});

/* ───────── protocol errors ───────── */

describe('protocol errors', () => {
  it('returns -32601 for an unknown method', () => {
    const p = connected();
    p.send({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
    expect(p.posted[0]).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it('stays silent on an id-less notification, even an unknown one', () => {
    const p = connected();
    p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    p.send({ jsonrpc: '2.0', method: 'no/such/notification' });
    expect(p.posted).toEqual([]);
  });

  it('returns -32600 for a non-JSON-RPC message with an id', () => {
    const p = connected();
    p.send({ id: 5, hello: 'world' });
    expect(p.posted[0]).toMatchObject({ id: 5, error: { code: -32600 } });
  });

  it('rejects an inbound message over 1MB', () => {
    const p = connected();
    p.send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { blob: 'x'.repeat(1_100_000) },
    });
    expect(p.posted[0]).toMatchObject({ id: 9, error: { code: -32600 } });
  });

  it('returns -32602 for an unknown tool name', async () => {
    const p = connected();
    p.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    await settle();
    expect(p.posted[0]).toMatchObject({ id: 3, error: { code: -32602 } });
  });

  it('returns -32602 when task is missing or empty', async () => {
    const p = connected();
    p.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'web_task', arguments: { task: '  ' } },
    });
    await settle();
    expect(p.posted[0]).toMatchObject({ id: 4, error: { code: -32602 } });
    expect(driveApiSession).not.toHaveBeenCalled();
  });
});

/* ───────── direct tool calls (registry catalog via the shared executor) ───────── */

type McpContentLike = { type: string; text?: string; data?: string; mimeType?: string };

describe('direct tool calls', () => {
  const callTool = (id: number, name: string, args: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('dispatches to the shared bridge executor with origin webmcp and returns JSON text', async () => {
    isExternalTool.mockReturnValue(true);
    runExternalTool.mockResolvedValue({ ok: true, result: { tabs: [{ id: 1 }] } });
    const p = connected();
    p.send(callTool(5, 'generic__list_tabs', {}));
    await settle();
    expect(runExternalTool).toHaveBeenCalledWith('generic__list_tabs', {}, 'webmcp');
    expect(p.posted[0]).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ tabs: [{ id: 1 }] }) }],
        isError: false,
      },
    });
    expect(recordCall).toHaveBeenCalledWith(
      'generic__list_tabs',
      true,
      undefined,
      expect.any(Number),
    );
  });

  it('maps a write-gate refusal to isError:true (gate itself lives in bridge-client)', async () => {
    isExternalTool.mockReturnValue(true);
    runExternalTool.mockResolvedValue({
      ok: false,
      error: '外部写操作已禁用(在扩展「外部接入」开启「允许外部写操作」)',
    });
    const p = connected();
    p.send(callTool(6, 'weibo__post', { text: 'hi' }));
    await settle();
    const result = p.posted[0].result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('外部写操作已禁用');
    expect(recordCall).toHaveBeenCalledWith(
      'weibo__post',
      false,
      expect.stringContaining('已禁用'),
      expect.any(Number),
    );
  });

  it('converts a screenshot dataUrl into an MCP image block + JSON text for the rest', async () => {
    isExternalTool.mockReturnValue(true);
    runExternalTool.mockResolvedValue({
      ok: true,
      result: { dataUrl: 'data:image/png;base64,QUJD', bytes: 3, tab_id: 7 },
    });
    const p = connected();
    p.send(callTool(8, 'generic__screenshot', { tab_id: 7 }));
    await settle();
    const result = p.posted[0].result as { content: McpContentLike[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
    expect(result.content[1]).toEqual({
      type: 'text',
      text: JSON.stringify({ bytes: 3, tab_id: 7 }),
    });
  });

  it('drops an over-1MB image block with a note instead of truncating base64', async () => {
    isExternalTool.mockReturnValue(true);
    runExternalTool.mockResolvedValue({
      ok: true,
      result: { dataUrl: `data:image/png;base64,${'A'.repeat(1_200_000)}`, bytes: 900_000 },
    });
    const p = connected();
    p.send(callTool(9, 'generic__screenshot', { full_page: true }));
    await settle();
    const wire = JSON.stringify(p.posted[0]);
    expect(new TextEncoder().encode(wire).length).toBeLessThanOrEqual(1_048_576);
    const result = p.posted[0].result as { content: McpContentLike[]; isError: boolean };
    expect(result.content.every((b) => b.type === 'text')).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('omitted');
  });

  it('is NOT queued behind a pending web_task', async () => {
    let releaseTask!: () => void;
    driveApiSession.mockImplementation(async (session: SessionState) => {
      await new Promise<void>((r) => {
        releaseTask = r;
      });
      session.history.push({
        role: 'assistant',
        cleanedText: '慢',
        commands: [],
        iteration: 0,
        ts: 1,
      });
      session.status = 'idle';
    });
    isExternalTool.mockReturnValue(true);
    runExternalTool.mockResolvedValue({ ok: true, result: 'quick' });
    const p = connected();
    p.send(callWebTask(1, '慢任务'));
    p.send(callTool(2, 'generic__list_tabs'));
    await settle();
    expect(p.posted.map((m) => m.id)).toEqual([2]); // 直接调用先回,web_task 还挂着
    releaseTask();
    await settle();
    expect(p.posted.map((m) => m.id)).toEqual([2, 1]);
  });
});

/* ───────── web_task ───────── */

describe('web_task', () => {
  it('runs the task through driveApiSession and returns the final assistant text', async () => {
    const p = connected();
    p.send(callWebTask(3, '打开 example.com,告诉我页面标题'));
    await settle();
    expect(driveApiSession).toHaveBeenCalledTimes(1);
    // Existing protections stay on: mode 'chat', autoApprove=false.
    expect(driveApiSession.mock.calls[0][2]).toBe('chat');
    expect(driveApiSession.mock.calls[0][4]).toBe(false);
    expect(p.posted[0]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: '最终答案' }], isError: false },
    });
  });

  it('forwards engine progress as notifications/progress (no id)', async () => {
    driveApiSession.mockImplementation(async (session: SessionState) => {
      forwardOrchEvent(session.id, {
        type: 'tool_trace',
        trace: { id: 't1', action: 'tool', tool: 'generic__open_url', status: 'started' },
      });
      session.history.push({
        role: 'assistant',
        cleanedText: 'ok',
        commands: [],
        iteration: 0,
        ts: 1,
      });
      session.status = 'idle';
    });
    const p = connected();
    p.send(callWebTask(3, '看看 example.com'));
    await settle();
    expect(p.posted[0]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { message: 'Tool: generic__open_url' },
    });
    expect(p.posted[0]).not.toHaveProperty('id');
    expect(p.posted[1]).toMatchObject({ id: 3 });
  });

  it('maps an errored run to isError:true with the engine error text', async () => {
    driveApiSession.mockImplementation(async (session: SessionState) => {
      forwardOrchEvent(session.id, { type: 'session_done', reason: 'error', error: 'LLM boom' });
      session.status = 'error';
    });
    const p = connected();
    p.send(callWebTask(3, '任务'));
    await settle();
    const result = p.posted[0].result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('LLM boom');
  });

  it('maps a thrown driveApiSession to isError:true', async () => {
    driveApiSession.mockRejectedValue(new Error('engine exploded'));
    const p = connected();
    p.send(callWebTask(3, '任务'));
    await settle();
    const result = p.posted[0].result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('engine exploded');
  });

  it('fails fast with a configure-a-model hint when no LLM profile is set', async () => {
    loadLlmConfig.mockResolvedValue({ provider: 'p', baseUrl: '', apiKey: '', model: '' });
    const p = connected();
    p.send(callWebTask(3, '任务'));
    await settle();
    const result = p.posted[0].result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('configure a model');
    expect(driveApiSession).not.toHaveBeenCalled();
  });

  it('serializes tools/call on the same port — second task waits for the first', async () => {
    let releaseFirst!: () => void;
    driveApiSession
      .mockImplementationOnce(async (session: SessionState) => {
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        session.history.push({
          role: 'assistant',
          cleanedText: '一',
          commands: [],
          iteration: 0,
          ts: 1,
        });
        session.status = 'idle';
      })
      .mockImplementationOnce(async (session: SessionState) => {
        session.history.push({
          role: 'assistant',
          cleanedText: '二',
          commands: [],
          iteration: 0,
          ts: 1,
        });
        session.status = 'idle';
      });
    const p = connected();
    p.send(callWebTask(1, '任务一'));
    p.send(callWebTask(2, '任务二'));
    await settle();
    expect(driveApiSession).toHaveBeenCalledTimes(1); // 二 still queued
    releaseFirst();
    await settle();
    expect(driveApiSession).toHaveBeenCalledTimes(2);
    expect(p.posted.map((m) => m.id)).toEqual([1, 2]);
  });

  it('truncates an over-1MB result and says so', async () => {
    driveApiSession.mockImplementation(async (session: SessionState) => {
      session.history.push({
        role: 'assistant',
        cleanedText: 'x'.repeat(3_000_000),
        commands: [],
        iteration: 0,
        ts: 1,
      });
      session.status = 'idle';
    });
    const p = connected();
    p.send(callWebTask(3, '大结果'));
    await settle();
    const wire = JSON.stringify(p.posted[0]);
    expect(new TextEncoder().encode(wire).length).toBeLessThanOrEqual(1_048_576);
    const result = p.posted[0].result as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain('truncated');
  });

  it('aborts the in-flight session when the port disconnects, and never replies', async () => {
    const aborted: boolean[] = [];
    driveApiSession.mockImplementation(async (session: SessionState) => {
      const ctl = new AbortController();
      activeSessions.set(session.id, { session, abort: ctl });
      await new Promise((r) => setTimeout(r, 10));
      aborted.push(ctl.signal.aborted);
      activeSessions.delete(session.id);
      session.status = 'aborted';
    });
    const p = connected();
    p.send(callWebTask(3, '任务'));
    await flush();
    p.disconnect();
    await new Promise((r) => setTimeout(r, 30));
    expect(aborted).toEqual([true]);
    expect(p.posted).toEqual([]); // nobody left to answer
  });
});
