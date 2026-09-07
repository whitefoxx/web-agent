/**
 * F2 — adapter invoke core (shared UI). Introspect an adapter command's arg
 * schema → render an editable form → run it via RUN_TOOL → show the result.
 * Reused by the explore try-run card (App.tsx) and the manual-run panel in the
 * Adapters view (T6a). Read commands only — RUN_TOOL refuses writes.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { ExploreAdapterArg, RunToolReq, RunToolResp } from '../messages';
import { CopyableBlock } from './components/CopyableBlock';

/** Seed form strings from an arg schema (+ optional example args). */
export function initArgVals(
  args?: ExploreAdapterArg[],
  testArgs?: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const names = args?.length ? args.map((a) => a.name) : Object.keys(testArgs ?? {});
  for (const n of names) {
    const v = testArgs?.[n];
    out[n] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** Coerce form strings to typed args; omit empties (use the arg's default). */
export function buildArgs(
  args: ExploreAdapterArg[] | undefined,
  vals: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const byName = new Map((args ?? []).map((a) => [a.name, a]));
  for (const [name, raw] of Object.entries(vals)) {
    const s = raw.trim();
    if (s === '') continue;
    const t = byName.get(name)?.type ?? 'string';
    if (t === 'int' || t === 'number' || t === 'float') {
      const n = Number(s);
      out[name] = Number.isNaN(n) ? s : n;
    } else if (t === 'bool' || t === 'boolean') {
      out[name] = s === 'true' || s === '1';
    } else {
      out[name] = s;
    }
  }
  return out;
}

export async function runTool(tool: string, args: Record<string, unknown>): Promise<RunToolResp> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'RUN_TOOL',
      tool,
      args,
    } satisfies RunToolReq)) as RunToolResp | undefined;
    return resp ?? { type: 'RUN_TOOL_RESP', ok: false, error: 'No response' };
  } catch (e) {
    return { type: 'RUN_TOOL_RESP', ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Editable-args form + run button. `runLabel` lets callers say "Try run" vs "Run". */
export function ArgsForm({
  args,
  values,
  onChange,
  onRun,
  busy,
  runLabel = 'Run',
  onCancel,
}: {
  args?: ExploreAdapterArg[];
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  onRun: () => void;
  busy: boolean;
  runLabel?: string;
  /** When provided, render a Cancel button next to the run button. */
  onCancel?: () => void;
}): JSX.Element {
  const fields: ExploreAdapterArg[] = args?.length
    ? args
    : Object.keys(values).map((name) => ({ name }));
  return (
    <div style="margin-top:8px;border-top:1px dashed rgba(127,127,127,.25);padding-top:8px;">
      <div style="font-size:11px;opacity:.6;margin-bottom:4px;">Fill in the arguments, then run:</div>
      {fields.length === 0 ? (
        <div style="font-size:12px;opacity:.6;margin-bottom:6px;">(no arguments)</div>
      ) : (
        fields.map((f) => (
          <div key={f.name} style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
            <label style="font-size:12px;min-width:88px;opacity:.8;">
              {f.name}
              {f.required ? <span style="color:var(--err);">*</span> : null}
            </label>
            <input
              style="flex:1;font-size:12px;padding:3px 6px;border:1px solid rgba(127,127,127,.3);border-radius:6px;background:transparent;color:inherit;"
              value={values[f.name] ?? ''}
              placeholder={f.help ?? f.type ?? ''}
              onInput={(e) =>
                onChange({ ...values, [f.name]: (e.target as HTMLInputElement).value })
              }
            />
          </div>
        ))
      )}
      <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
        <button
          class="send-btn"
          disabled={busy}
          onClick={onRun}
          style="width:auto;padding:3px 14px;border-radius:8px;"
        >
          {busy ? `${runLabel}…` : runLabel}
        </button>
        {onCancel && (
          <button class="btn sm outline" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** Self-contained manual runner for one adapter command: arg form + result
 * (with a copy button on the result via CopyableBlock). */
export function RunPanel({
  tool,
  args,
  onCancel,
}: {
  tool: string;
  args?: ExploreAdapterArg[];
  /** When provided, render a Cancel button next to the run button. */
  onCancel?: () => void;
}): JSX.Element {
  const [vals, setVals] = useState<Record<string, string>>(() => initArgVals(args));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RunToolResp | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setRes(null);
    const r = await runTool(tool, buildArgs(args, vals));
    setRes(r);
    setBusy(false);
  }

  return (
    <div>
      <ArgsForm
        args={args}
        values={vals}
        onChange={setVals}
        onRun={() => void run()}
        busy={busy}
        onCancel={onCancel}
      />
      {res &&
        (res.ok ? (
          <CopyableBlock
            title={res.rows != null ? `${res.rows} rows` : 'Done'}
            text={res.preview ?? ''}
            maxHeight={300}
          />
        ) : (
          <div style="margin-top:6px;color:var(--err);font-size:12px;">Run failed: {res.error}</div>
        ))}
    </div>
  );
}
