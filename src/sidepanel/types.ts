import type { ParsedCommand, ToolTrace } from '../connectors/messages';

export interface UiUserTurn {
  role: 'user';
  text: string;
  ts: number;
}

export interface UiAssistantTurn {
  role: 'assistant';
  text: string;
  rawText?: string;
  reasoningText?: string;
  commands: ParsedCommand[];
  iteration: number;
  ts: number;
}

export interface UiToolTrace {
  role: 'tool';
  trace: ToolTrace;
  ts: number;
}

export interface UiSystem {
  role: 'system';
  text: string;
  level: 'info' | 'error';
  ts: number;
}

export type UiTurn = UiUserTurn | UiAssistantTurn | UiToolTrace | UiSystem;
