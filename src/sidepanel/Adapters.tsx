/**
 * Adapters management section for the settings drawer.
 *
 * Two tabs:
 *  - 已安装 — list with enable/disable/uninstall + a paste-to-install panel.
 *  - 市场   — browse the bundled catalog (122 pipeline adapters), with a
 *             featured row up top and a searchable full list below; every row
 *             is a one-click install.
 *
 * Install path (same for paste and market): adapter source → eval'd in the
 * SidePanel's hidden sandbox iframe (sandbox-host) → captured defs sent to the
 * SW to persist + register. pipeline adapters become callable immediately;
 * func adapters are stored + listed but marked "needs func support" (Phase B).
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  installAdapterFromSource,
  listInstalled,
  uninstallAdapter,
  setAdapterEnabled,
} from './adapters-client';
import {
  fetchMarketIndex,
  entryId,
  FEATURED_IDS,
  type MarketIndex,
  type MarketAdapter,
} from './marketplace';
import type { InstalledAdapterSummary } from '../connectors/messages';

type Tab = 'installed' | 'market';
type TypeFilter = 'all' | 'pipeline' | 'func';

type InstallState =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'ok'; msg: string }
  | { kind: 'err'; msg: string };

export function AdaptersSection() {
  const [tab, setTab] = useState<Tab>('installed');
  const [list, setList] = useState<InstalledAdapterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPaste, setShowPaste] = useState(false);
  const [source, setSource] = useState('');
  const [state, setState] = useState<InstallState>({ kind: 'idle' });

  // Market state.
  const [market, setMarket] = useState<MarketIndex | null>(null);
  const [marketErr, setMarketErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  async function refresh(): Promise<void> {
    setLoading(true);
    setList(await listInstalled());
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    const handler = (m: unknown) => {
      if ((m as { type?: string })?.type === 'ADAPTERS_CHANGED') void refresh();
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // Lazy-load the market index the first time the user opens the 市场 tab.
  // Avoids paying the ~240KB fetch + parse for users who never browse.
  useEffect(() => {
    if (tab !== 'market' || market || marketErr) return;
    let cancelled = false;
    void (async () => {
      try {
        const idx = await fetchMarketIndex();
        if (!cancelled) setMarket(idx);
      } catch (e) {
        if (!cancelled) setMarketErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, market, marketErr]);

  const installedIds = useMemo(() => new Set(list.map((a) => a.id)), [list]);

  const featured = useMemo<MarketAdapter[]>(() => {
    if (!market) return [];
    const byId = new Map(market.adapters.map((a) => [entryId(a), a]));
    return FEATURED_IDS.map((id) => byId.get(id)).filter((a): a is MarketAdapter => !!a);
  }, [market]);

  const filtered = useMemo<MarketAdapter[]>(() => {
    if (!market) return [];
    const q = search.trim().toLowerCase();
    return market.adapters.filter((a) => {
      if (typeFilter !== 'all' && a.type !== typeFilter) return false;
      if (!q) return true;
      return (
        a.site.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [market, search, typeFilter]);

  const marketCounts = useMemo(() => {
    if (!market) return { all: 0, pipeline: 0, func: 0 };
    let pipeline = 0;
    let func = 0;
    for (const a of market.adapters) {
      if (a.type === 'pipeline') pipeline++;
      else if (a.type === 'func') func++;
    }
    return { all: market.adapters.length, pipeline, func };
  }, [market]);

  async function installSource(
    src: string,
    origin: { type: 'marketplace' | 'manual'; url?: string },
    id?: string,
  ): Promise<boolean> {
    setState({ kind: 'installing' });
    if (id) setInstalling((p) => new Set(p).add(id));
    try {
      const r = await installAdapterFromSource(src, origin);
      if (!r.ok) {
        setState({ kind: 'err', msg: r.error ?? '安装失败' });
        return false;
      }
      const name = r.title ?? r.id ?? id ?? '';
      const registered = r.registered ?? 0;
      const dFunc = r.deferredFunc ?? 0;
      const dUnsup = r.deferredUnsupported ?? 0;
      // 0 registered + something deferred = the user clicked install but nothing
      // actually became a callable tool. Surface it as a WARNING, not a success,
      // and say why (func/Phase B vs unsupported step) — otherwise the toast
      // looks like a green tick and the user reasonably expects it to work.
      if (registered === 0 && (dFunc > 0 || dUnsup > 0)) {
        const reasons: string[] = [];
        if (dFunc > 0) reasons.push(`${dFunc} 个 func 命令暂存(需 Phase B)`);
        if (dUnsup > 0) reasons.push(`${dUnsup} 个 pipeline 命令用了引擎不支持的步骤`);
        setState({
          kind: 'err',
          msg: `${name} 已保存但无可用命令 — ${reasons.join('、')}。agent 看不到这个工具,调用时会回落到 generic__*。`,
        });
        void refresh();
        return true;
      }
      const parts = [`已安装 ${name}`];
      if (registered) parts.push(`${registered} 个命令可用`);
      if (dFunc) parts.push(`${dFunc} 个 func 命令暂存(需 Phase B)`);
      if (dUnsup) parts.push(`${dUnsup} 个 pipeline 命令用了不支持的步骤`);
      setState({ kind: 'ok', msg: parts.join(' · ') });
      void refresh();
      return true;
    } finally {
      if (id) {
        setInstalling((p) => {
          const s = new Set(p);
          s.delete(id);
          return s;
        });
      }
    }
  }

  async function onInstallPaste(): Promise<void> {
    const src = source.trim();
    if (!src) return;
    const ok = await installSource(src, { type: 'manual' });
    if (ok) {
      setSource('');
      setShowPaste(false);
    }
  }

  async function onInstallMarket(a: MarketAdapter): Promise<void> {
    const id = entryId(a);
    await installSource(a.source, { type: 'marketplace', url: `bundled:${id}` }, id);
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

  const tabBtn = (k: Tab, label: string, count?: number): preact.JSX.Element => (
    <button
      onClick={() => setTab(k)}
      style={`background:transparent;border:none;cursor:pointer;font-size:12px;padding:4px 8px;border-bottom:2px solid ${
        tab === k ? 'var(--accent,#0ea5e9)' : 'transparent'
      };color:${tab === k ? 'var(--accent,#0ea5e9)' : 'var(--muted)'};font-weight:${
        tab === k ? '600' : '400'
      }`}
    >
      {label}
      {typeof count === 'number' && (
        <span style="margin-left:4px;font-weight:400;opacity:0.75">({count})</span>
      )}
    </button>
  );

  return (
    <div class="section">
      <h4 style="margin-bottom:6px">Adapters</h4>

      <div style="display:flex;gap:0;border-bottom:1px solid var(--border,#e7e5e4);margin-bottom:8px">
        {tabBtn('installed', '已安装', list.length)}
        {tabBtn('market', '市场', market?.count)}
      </div>

      {state.kind === 'ok' && (
        <div style="font-size:11px;color:var(--ok,#16a34a);margin-bottom:6px">✓ {state.msg}</div>
      )}
      {state.kind === 'err' && (
        <div style="font-size:11px;color:var(--err,#dc2626);margin-bottom:6px">✗ {state.msg}</div>
      )}

      {tab === 'installed' && (
        <InstalledPanel
          list={list}
          loading={loading}
          showPaste={showPaste}
          source={source}
          installing={state.kind === 'installing'}
          onTogglePaste={() => {
            setShowPaste((v) => !v);
            setState({ kind: 'idle' });
          }}
          onSourceChange={setSource}
          onInstallPaste={onInstallPaste}
          onToggle={onToggle}
          onUninstall={onUninstall}
          chip={chip}
          linkBtn={linkBtn}
        />
      )}

      {tab === 'market' && (
        <MarketPanel
          market={market}
          err={marketErr}
          featured={featured}
          filtered={filtered}
          counts={marketCounts}
          installedIds={installedIds}
          installing={installing}
          search={search}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          onSearchChange={setSearch}
          onInstall={onInstallMarket}
        />
      )}
    </div>
  );
}

/* ───────── installed tab ───────── */

interface InstalledPanelProps {
  list: InstalledAdapterSummary[];
  loading: boolean;
  showPaste: boolean;
  source: string;
  installing: boolean;
  onTogglePaste: () => void;
  onSourceChange: (s: string) => void;
  onInstallPaste: () => Promise<void>;
  onToggle: (a: InstalledAdapterSummary) => Promise<void>;
  onUninstall: (a: InstalledAdapterSummary) => Promise<void>;
  chip: (text: string, color: string) => preact.JSX.Element;
  linkBtn: string;
}

function InstalledPanel(p: InstalledPanelProps): preact.JSX.Element {
  return (
    <div>
      <div style="display:flex;align-items:center;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);flex:1">
          ⚠️ 安装会执行第三方脚本(已隔离在沙箱内)。只安装你信任来源的代码。
        </div>
        <button style={p.linkBtn} onClick={p.onTogglePaste}>
          {p.showPaste ? '取消' : '+ 贴码安装'}
        </button>
      </div>

      {p.showPaste && (
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
          <textarea
            placeholder="粘贴 opencli adapter 源码(import { cli } from '@jackwener/opencli/registry'; cli({...}))"
            value={p.source}
            onInput={(e) => p.onSourceChange((e.target as HTMLTextAreaElement).value)}
            rows={6}
            style="width:100%;font-family:monospace;font-size:11px"
          />
          <button
            class="icon-btn"
            disabled={!p.source.trim() || p.installing}
            onClick={() => void p.onInstallPaste()}
          >
            {p.installing ? '安装中…' : '安装'}
          </button>
        </div>
      )}

      {p.loading ? (
        <div style="font-size:11px;color:var(--muted)">加载中…</div>
      ) : p.list.length === 0 ? (
        <div style="font-size:11px;color:var(--muted)">
          （还没有安装任何 adapter — 去「市场」tab 一键装几个）
        </div>
      ) : (
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">
          {p.list.map((a) => (
            <li
              key={a.id}
              style="border:1px solid var(--border,#e7e5e4);border-radius:6px;padding:6px 8px"
            >
              <div style="display:flex;align-items:center;gap:6px">
                <code style="font-size:12px">{a.title}</code>
                {a.kind === 'func' && p.chip('func·待 Phase B', '#a16207')}
                {a.kind === 'mixed' && p.chip('mixed', '#a16207')}
                {!a.enabled && p.chip('已禁用', '#78716c')}
                <span style="margin-left:auto;font-size:10px;color:var(--muted)">
                  {a.commandCount} 命令
                </span>
              </div>
              <div style="display:flex;gap:10px;margin-top:4px">
                <button style={p.linkBtn} onClick={() => void p.onToggle(a)}>
                  {a.enabled ? '禁用' : '启用'}
                </button>
                <button
                  style={p.linkBtn.replace('var(--accent,#0ea5e9)', 'var(--err,#dc2626)')}
                  onClick={() => void p.onUninstall(a)}
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

/* ───────── market tab ───────── */

interface MarketPanelProps {
  market: MarketIndex | null;
  err: string | null;
  featured: MarketAdapter[];
  filtered: MarketAdapter[];
  counts: { all: number; pipeline: number; func: number };
  installedIds: Set<string>;
  installing: Set<string>;
  search: string;
  typeFilter: TypeFilter;
  onTypeFilterChange: (t: TypeFilter) => void;
  onSearchChange: (s: string) => void;
  onInstall: (a: MarketAdapter) => Promise<void>;
}

function MarketPanel(p: MarketPanelProps): preact.JSX.Element {
  if (p.err) {
    return (
      <div style="font-size:11px;color:var(--err,#dc2626)">
        市场加载失败:{p.err}
        <div style="color:var(--muted);margin-top:4px">
          确保 dist/marketplace-index.json 存在,且 manifest 把它列在 web_accessible_resources。
        </div>
      </div>
    );
  }
  if (!p.market) {
    return <div style="font-size:11px;color:var(--muted)">加载市场目录…</div>;
  }
  const typeBtn = (t: TypeFilter, label: string, n: number): preact.JSX.Element => (
    <button
      onClick={() => p.onTypeFilterChange(t)}
      style={`font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer;border:1px solid ${
        p.typeFilter === t ? 'var(--accent,#0ea5e9)' : 'var(--border,#e7e5e4)'
      };background:${p.typeFilter === t ? 'var(--accent,#0ea5e9)' : 'transparent'};color:${
        p.typeFilter === t ? '#fff' : 'inherit'
      }`}
    >
      {label} <span style="opacity:0.75">{n}</span>
    </button>
  );
  return (
    <div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">
        内置 {p.counts.all} 个 opencli adapter ({p.counts.pipeline} pipeline · {p.counts.func} func)
      </div>
      {p.counts.func > 0 && (
        <div style="font-size:10px;color:var(--muted);background:#fef3c7;border:1px solid #fde68a;border-radius:4px;padding:4px 6px;margin-bottom:8px">
          ⚠️ <strong>func 型</strong>需 Chrome 138+,并在「扩展详情 → 允许用户脚本」开关打开,否则装了也跑不起来(toast 会报红)。
        </div>
      )}

      {p.featured.length > 0 && p.search.trim() === '' && p.typeFilter === 'all' && (
        <div style="margin-bottom:10px">
          <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:4px">
            ⭐ 推荐
          </div>
          <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px">
            {p.featured.map((a) => (
              <MarketRow
                key={entryId(a)}
                a={a}
                installed={p.installedIds.has(entryId(a))}
                installing={p.installing.has(entryId(a))}
                onInstall={p.onInstall}
                accent
              />
            ))}
          </ul>
        </div>
      )}

      <div style="margin-bottom:6px">
        <input
          type="text"
          placeholder="搜索 site / name / 描述(例:reddit、价格、新闻)"
          value={p.search}
          onInput={(e) => p.onSearchChange((e.target as HTMLInputElement).value)}
          style="width:100%;padding:4px 6px;font-size:11px;border:1px solid var(--border,#e7e5e4);border-radius:4px"
        />
      </div>

      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="font-size:11px;color:var(--muted)">类型</span>
        {typeBtn('all', '全部', p.counts.all)}
        {typeBtn('pipeline', 'pipeline', p.counts.pipeline)}
        {typeBtn('func', 'func', p.counts.func)}
      </div>

      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">
        显示 {p.filtered.length}
        {p.filtered.length !== p.counts.all ? `/${p.counts.all}` : ''}
      </div>
      {p.filtered.length === 0 ? (
        <div style="font-size:11px;color:var(--muted)">没有匹配的 adapter</div>
      ) : (
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:2px;max-height:360px;overflow-y:auto">
          {p.filtered.map((a) => (
            <MarketRow
              key={entryId(a)}
              a={a}
              installed={p.installedIds.has(entryId(a))}
              installing={p.installing.has(entryId(a))}
              onInstall={p.onInstall}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface MarketRowProps {
  a: MarketAdapter;
  installed: boolean;
  installing: boolean;
  onInstall: (a: MarketAdapter) => Promise<void>;
  accent?: boolean;
}

function MarketRow({ a, installed, installing, onInstall, accent }: MarketRowProps): preact.JSX.Element {
  const id = entryId(a);
  // pipeline 绿、func 橙(标识 Phase B 前提)。chip 用 inline style 而不是 className
  // 以避免 sidepanel/style.css 改动。
  const typeChip =
    a.type === 'pipeline' ? (
      <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#dcfce7;color:#166534;font-weight:600">
        pipeline
      </span>
    ) : a.type === 'func' ? (
      <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#ffedd5;color:#9a3412;font-weight:600">
        func
      </span>
    ) : null;
  return (
    <li
      style={`border:1px solid ${accent ? 'var(--accent,#0ea5e9)' : 'var(--border,#e7e5e4)'};border-radius:4px;padding:4px 8px;display:flex;align-items:center;gap:6px`}
    >
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;display:flex;align-items:center;gap:6px">
          <code>{id}</code>
          {typeChip}
        </div>
        {a.description && (
          <div style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {a.description}
          </div>
        )}
      </div>
      {installed ? (
        <span style="font-size:10px;color:var(--ok,#16a34a)">✓ 已安装</span>
      ) : (
        <button
          class="icon-btn"
          style="font-size:11px;padding:2px 8px"
          disabled={installing}
          onClick={() => void onInstall(a)}
        >
          {installing ? '安装中…' : '安装'}
        </button>
      )}
    </li>
  );
}
