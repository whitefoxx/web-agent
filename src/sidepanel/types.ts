import type { PageRef, ParsedCommand, ToolTrace } from '../messages';

export interface UiUserTurn {
  role: 'user';
  text: string;
  /** Pages this turn refers to (summarize-this-page / chat-with-page) — quote cards under the bubble. */
  pageRefs?: PageRef[];
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
  /** Optional expandable detail (e.g. a workflow run's full per-step output),
   * rendered left-aligned monospace inside a collapsible. */
  detail?: string;
  ts: number;
}

export type UiTurn = UiUserTurn | UiAssistantTurn | UiToolTrace | UiSystem;
