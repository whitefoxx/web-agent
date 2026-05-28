/**
 * Convert the adapter registry into OpenAI-style tool (function) schemas.
 *
 * Tool name format: `${site}__${name}` (double underscore).
 * - matches the OpenAI tool name regex `^[a-zA-Z0-9_-]{1,64}$`
 * - reversibly maps back to (site, name) via split('__')
 * - keeps dashes in command names (e.g. `xiaohongshu__creator-notes`)
 */

import { getRegistry } from '../runtime/registry.js';

export interface AdapterArg {
  name: string;
  type?: 'string' | 'int' | 'bool';
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  help?: string;
}

export interface AdapterDef {
  site: string;
  name: string;
  access?: 'read' | 'write';
  description?: string;
  domain?: string;
  args?: AdapterArg[];
  columns?: string[];
  func: (page: unknown, kwargs: Record<string, unknown>) => Promise<unknown>;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

const TYPE_MAP: Record<string, string> = {
  string: 'string',
  int: 'integer',
  bool: 'boolean',
};

export function openAiToolsFromRegistry(): OpenAITool[] {
  const out: OpenAITool[] = [];
  for (const def of getRegistry() as AdapterDef[]) {
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];
    for (const arg of def.args ?? []) {
      const type = TYPE_MAP[arg.type ?? 'string'] ?? 'string';
      properties[arg.name] = {
        type,
        ...(arg.help ? { description: arg.help } : {}),
      };
      if (arg.required) required.push(arg.name);
    }
    out.push({
      type: 'function',
      function: {
        name: `${def.site}__${def.name}`,
        description: def.description ?? '',
        parameters: { type: 'object', properties, required },
      },
    });
  }
  return out;
}

export function lookupAdapter(toolName: string): AdapterDef | null {
  const sep = toolName.indexOf('__');
  if (sep < 0) return null;
  const site = toolName.slice(0, sep);
  const name = toolName.slice(sep + 2);
  for (const def of getRegistry() as AdapterDef[]) {
    if (def.site === site && def.name === name) return def;
  }
  return null;
}
