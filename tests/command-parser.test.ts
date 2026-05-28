import { describe, it, expect } from 'vitest';
import { parseAgentCommands } from '../src/agent/command-parser';

describe('parseAgentCommands', () => {
  it('returns empty result for plain text', () => {
    const r = parseAgentCommands('Hello world, just a regular reply.');
    expect(r.commands).toEqual([]);
    expect(r.cleanedText).toBe('Hello world, just a regular reply.');
  });

  it('extracts an agent-command from <agent-command> tags (canonical form)', () => {
    const md = [
      '我先看一下小红书首页：',
      '',
      '<agent-command>',
      '{"action":"execute_tool", "tool":"xiaohongshu__feed", "args":{"limit":10}}',
      '</agent-command>',
      '',
      '稍等。',
    ].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].action).toBe('execute_tool');
    expect(r.commands[0].tool).toBe('xiaohongshu__feed');
    expect(r.commands[0].args).toEqual({ limit: 10 });
    expect(r.cleanedText).toContain('我先看一下');
    expect(r.cleanedText).toContain('稍等。');
    expect(r.cleanedText).not.toContain('agent-command');
    expect(r.cleanedText).not.toContain('execute_tool');
  });

  it('accepts <agent_command> underscore variant and is case-insensitive', () => {
    for (const tag of ['agent-command', 'agent_command', 'AGENT-COMMAND', 'Agent-Command']) {
      const md = `<${tag}>{"action":"done"}</${tag}>`;
      const r = parseAgentCommands(md);
      expect(r.commands, `tag=${tag}`).toHaveLength(1);
      expect(r.commands[0].action, `tag=${tag}`).toBe('done');
    }
  });

  it('extracts multiple <agent-command> blocks in order', () => {
    const md = [
      '<agent-command>{"action":"list_tools","args":{"category":"xiaohongshu"}}</agent-command>',
      '中间话',
      '<agent-command>{"action":"describe_tool","args":{"name":"xiaohongshu__feed"}}</agent-command>',
    ].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands.map((c) => c.action)).toEqual(['list_tools', 'describe_tool']);
    expect(r.cleanedText).toContain('中间话');
  });

  it('extracts a single fenced agent-command block (backward-compat)', () => {
    const md = [
      '我先看一下小红书首页：',
      '',
      '```agent-command',
      '{"action":"execute_tool", "tool":"xiaohongshu__feed", "args":{"limit":10}}',
      '```',
      '',
      '稍等。',
    ].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].action).toBe('execute_tool');
    expect(r.commands[0].tool).toBe('xiaohongshu__feed');
    expect(r.commands[0].args).toEqual({ limit: 10 });
    expect(r.cleanedText).toContain('我先看一下');
    expect(r.cleanedText).toContain('稍等。');
    expect(r.cleanedText).not.toContain('agent-command');
    expect(r.cleanedText).not.toContain('execute_tool');
  });

  it('extracts multiple blocks in order', () => {
    const md = [
      '```agent-command',
      '{"action":"list_tools","args":{"category":"xiaohongshu"}}',
      '```',
      '中间话',
      '```agent-command',
      '{"action":"describe_tool","args":{"name":"xiaohongshu__feed"}}',
      '```',
    ].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands.map((c) => c.action)).toEqual(['list_tools', 'describe_tool']);
    expect(r.cleanedText).toContain('中间话');
  });

  it('accepts underscored and non-spaced language tags', () => {
    const variants = ['agent-command', 'agent_command', 'agentcommand', 'AGENT-COMMAND'];
    for (const lang of variants) {
      const md = ['```' + lang, '{"action":"done"}', '```'].join('\n');
      const r = parseAgentCommands(md);
      expect(r.commands, `lang=${lang}`).toHaveLength(1);
      expect(r.commands[0].action, `lang=${lang}`).toBe('done');
    }
  });

  it('returns parse_error for invalid JSON inside the block', () => {
    const md = ['```agent-command', '{this is not json}', '```'].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].action).toBe('parse_error');
    expect(r.commands[0].message).toBeDefined();
  });

  it('returns parse_error when JSON parses to a non-object', () => {
    const md = ['```agent-command', '42', '```'].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].action).toBe('parse_error');
  });

  it('preserves raw command text for debugging', () => {
    const md = ['```agent-command', '{"action":"done"}', '```'].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands[0].raw).toContain('done');
    expect(r.commands[0].raw).toContain('```');
  });

  it('recognises a fence with empty language as a command when body is command-shaped JSON', () => {
    // This is the DeepSeek case: their code-block renderer doesn't propagate
    // `language-agent-command` onto the <code> tag, so DOM-to-markdown
    // extraction emits the fence with an empty language tag.
    const md = [
      '我先看一下：',
      '```',
      '{"action":"describe_tool","args":{"name":"xiaohongshu__feed"}}',
      '```',
    ].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].action).toBe('describe_tool');
    expect(r.commands[0].args).toEqual({ name: 'xiaohongshu__feed' });
    expect(r.cleanedText).not.toContain('describe_tool');
  });

  it('recognises a `json`-tagged fence as a command when body has an action key', () => {
    const md = ['```json', '{"action":"done"}', '```'].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].action).toBe('done');
  });

  it('leaves non-command empty-lang code blocks alone', () => {
    const md = ['something else:', '```', '{"foo":1}', '```', 'done'].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(0);
    expect(r.cleanedText).toContain('```');
    expect(r.cleanedText).toContain('{"foo":1}');
  });

  it('leaves typed code samples in unrelated languages alone', () => {
    const md = ['```python', 'print("hi")', '```'].join('\n');
    const r = parseAgentCommands(md);
    expect(r.commands).toHaveLength(0);
    expect(r.cleanedText).toContain('python');
  });

  it('collapses excess blank lines after removing blocks', () => {
    const md = [
      'before',
      '',
      '',
      '```agent-command',
      '{"action":"done"}',
      '```',
      '',
      '',
      '',
      'after',
    ].join('\n');
    const r = parseAgentCommands(md);
    // Should not have triple newlines in between.
    expect(/\n{3,}/.test(r.cleanedText)).toBe(false);
    expect(r.cleanedText).toMatch(/before[\s\S]+after/);
  });
});
