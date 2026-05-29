/**
 * Adapters management section for the settings drawer.
 *
 * Phase A: paste-to-install + installed list (enable / disable / uninstall).
 * The marketplace browse tab (A3) plugs in here later via the same client.
 *
 * Install path: paste opencli adapter source → evaled in the SidePanel's hidden
 * sandbox iframe (sandbox-host) → captured defs sent to the SW to persist +
 * register. pipeline adapters become callable immediately; func adapters are
 * stored + listed but marked "needs func support" (Phase B).
 */

import { useEffect, useState } from 'preact/hooks';
import {
  installAdapterFromSource,
  listInstalled,
  uninstallAdapter,
  setAdapterEnabled,
} from './adapters-client';
import type { InstalledAdapterSummary } from '../connectors/messages';

type InstallState =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'ok'; msg: string }
  | { kind: 'err'; msg: string };

export function AdaptersSection() {
  const [list, setList] = useState<InstalledAdapterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPaste, setShowPaste] = useState(false);
  const [source, setSource] = useState('');
  const [state, setState] = useState<InstallState>({ kind: 'idle' });

  async function refresh(): Promise<void> {
    setLoading(true);
    setList(await listInstalled());
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    // Refresh when the SW reports the installed set changed (e.g. another view).
    const handler = (m: unknown) => {
      if ((m as { type?: string })?.type === 'ADAPTERS_CHANGED') void refresh();
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  async function onInstall(): Promise<void> {
    const src = source.trim();
    if (!src) return;
    setState({ kind: 'installing' });
    const r = await installAdapterFromSource(src, { type: 'manual' });
    if (!r.ok) {
      setState({ kind: 'err', msg: r.error ?? '安装失败' });
      return;
    }
    const parts = [`已安装 ${r.title ?? r.id}`];
    if (r.registered) parts.push(`${r.registered} 个命令可用`);
    if (r.deferred) parts.push(`${r.deferred} 个 func 命令暂存(需 Phase B)`);
    setState({ kind: 'ok', msg: parts.join(' · ') });
    setSource('');
    setShowPaste(false);
    void refresh();
  }

  async function onToggle(a: InstalledAdapterSummary): Promise<void> {
    await setAdapterEnabled(a.id, !a.enabled);
    void refresh();
  }

  async function onUninstall(a: InstalledAdapterSummary): Promise<void> {
    if (!confirm(`卸载 ${a.title}?`)) return;
    await uninstallAdapter(a.id);
    void refresh();
  }

  const linkBtn =
    'background:transparent;border:none;color:var(--accent,#0ea5e9);cursor:pointer;font-size:12px;padding:0';
  const chip = (text: string, color: string): preact.JSX.Element => (
    <span style={`font-size:10px;padding:1px 6px;border-radius:4px;background:${color};color:#fff`}>
      {text}
    </span>
  );

  return (
    <div class="section">
      <h4>
        Adapters <span style="color:var(--muted);font-weight:400">({list.length})</span>
        <button
          style={`${linkBtn};float:right`}
          onClick={() => {
            setShowPaste((v) => !v);
            setState({ kind: 'idle' });
          }}
        >
          {showPaste ? '取消' : '+ 贴码安装'}
        </button>
      </h4>

      <div style="font-size:11px;color:var(--muted);margin-bottom:6px">
        安装 opencli adapter,无需重新构建扩展。⚠️ 只安装你信任来源的代码 —— 安装会执行第三方脚本(已在隔离沙箱内)。
      </div>

      {showPaste && (
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
          <textarea
            placeholder="粘贴 opencli adapter 源码(import { cli } from '@jackwener/opencli/registry'; cli({...}))"
            value={source}
            onInput={(e) => setSource((e.target as HTMLTextAreaElement).value)}
            rows={6}
            style="width:100%;font-family:monospace;font-size:11px"
          />
          <button
            class="icon-btn"
            disabled={!source.trim() || state.kind === 'installing'}
            onClick={onInstall}
          >
            {state.kind === 'installing' ? '安装中…' : '安装'}
          </button>
        </div>
      )}

      {state.kind === 'ok' && (
        <div style="font-size:11px;color:var(--ok,#16a34a);margin-bottom:6px">✓ {state.msg}</div>
      )}
      {state.kind === 'err' && (
        <div style="font-size:11px;color:var(--err,#dc2626);margin-bottom:6px">✗ {state.msg}</div>
      )}

      {loading ? (
        <div style="font-size:11px;color:var(--muted)">加载中…</div>
      ) : list.length === 0 ? (
        <div style="font-size:11px;color:var(--muted)">（还没有安装任何 adapter）</div>
      ) : (
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">
          {list.map((a) => (
            <li
              key={a.id}
              style="border:1px solid var(--border,#e7e5e4);border-radius:6px;padding:6px 8px"
            >
              <div style="display:flex;align-items:center;gap:6px">
                <code style="font-size:12px">{a.title}</code>
                {a.kind === 'func' && chip('func·待 Phase B', '#a16207')}
                {a.kind === 'mixed' && chip('mixed', '#a16207')}
                {!a.enabled && chip('已禁用', '#78716c')}
                <span style="margin-left:auto;font-size:10px;color:var(--muted)">
                  {a.commandCount} 命令
                </span>
              </div>
              <div style="display:flex;gap:10px;margin-top:4px">
                <button style={linkBtn} onClick={() => void onToggle(a)}>
                  {a.enabled ? '禁用' : '启用'}
                </button>
                <button
                  style={linkBtn.replace('var(--accent,#0ea5e9)', 'var(--err,#dc2626)')}
                  onClick={() => void onUninstall(a)}
                >
                  卸载
                </button>
                {a.origin.type === 'marketplace' && (
                  <span style="font-size:10px;color:var(--muted)">来自市场</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
