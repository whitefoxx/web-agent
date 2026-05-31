/**
 * Adapters management section for the settings drawer.
 *
 * Two tabs:
 *  - 已安装 — list with enable/disable/uninstall + a paste-to-install panel.
 *  - 市场   — browse the bundled catalog (count comes from marketplace/index.json
 *             at fetch time), with a featured row up top and a searchable full
 *             list below; every row is a one-click install.
 *
 * Install path (same for paste and market): adapter source → eval'd in the
 * SidePanel's hidden sandbox iframe (sandbox-host) → captured defs sent to the
 * SW to persist + register. pipeline + func both register immediately; func
 * requires the per-extension "Allow User Scripts" toggle to actually execute
 * (Chrome 138+), which is surfaced in the market panel banner.
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
  fetchAdapterSource,
  entryId,
  FEATURED_IDS,
  type MarketIndex,
  type MarketAdapter,
} from './marketplace';
import type { InstalledAdapterSummary } from '../messages';

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
      // and say why — otherwise the toast looks like a green tick and the user
      // reasonably expects it to work.
      if (registered === 0 && (dFunc > 0 || dUnsup > 0)) {
        const reasons: string[] = [];
        if (dFunc > 0) reasons.push(`${dFunc} 个 func 命令未注册(需在扩展详情开「允许用户脚本」)`);
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
      if (dFunc) parts.push(`${dFunc} 个 func 命令暂存(需开「允许用户脚本」)`);
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
    // Schema-v2: index carries only a relative source path; the actual `.js`
    // body lives at marketplace/<site>/<name>.js and is fetched on demand
    // here, with sha256 verified against the index (refuses tampered bodies).
    setState({ kind: 'installing' });
    setInstalling((p) => new Set(p).add(id));
    let src: string;
    try {
      src = await fetchAdapterSource(a);
    } catch (e) {
      setState({ kind: 'err', msg: e instanceof Error ? e.message : String(e) });
      setInstalling((p) => {
        const s = new Set(p);
        s.delete(id);
        return s;
      });
      return;
    }
    await installSource(src, { type: 'marketplace', url: `bundled:${id}` }, id);
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

  return (
    <div class="adapters-section">
      <div class="pill-row" style="margin-bottom:14px">
        <button
          class={`pill ${tab === 'installed' ? 'selected' : ''}`}
          onClick={() => setTab('installed')}
        >
          已安装 <span class="count">{list.length}</span>
        </button>
        <button
          class={`pill ${tab === 'market' ? 'selected' : ''}`}
          onClick={() => setTab('market')}
        >
          市场 {typeof market?.count === 'number' && <span class="count">{market.count}</span>}
        </button>
      </div>

      {state.kind === 'ok' && (
        <div class="banner ok" style="margin-bottom:10px">
          ✓ {state.msg}
        </div>
      )}
      {state.kind === 'err' && (
        <div class="banner err" style="margin-bottom:10px">
          ✗ {state.msg}
        </div>
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
}

function InstalledPanel(p: InstalledPanelProps): preact.JSX.Element {
  return (
    <div>
      <div class="adapters-paste-bar">
        <span class="adapters-paste-warning">
          ⚠️ 安装会执行第三方脚本(已隔离在沙箱内),请只装信任来源的代码。
        </span>
        <button class="btn sm outline" onClick={p.onTogglePaste}>
          {p.showPaste ? '取消' : '+ 贴码安装'}
        </button>
      </div>

      {p.showPaste && (
        <div class="adapters-paste-form">
          <textarea
            placeholder="粘贴 opencli adapter 源码 (import { cli } from '@jackwener/opencli/registry'; cli({...}))"
            value={p.source}
            onInput={(e) => p.onSourceChange((e.target as HTMLTextAreaElement).value)}
            rows={6}
          />
          <button
            class="btn primary"
            disabled={!p.source.trim() || p.installing}
            onClick={() => void p.onInstallPaste()}
          >
            {p.installing ? '安装中…' : '安装'}
          </button>
        </div>
      )}

      {p.loading ? (
        <div class="hist-empty">加载中…</div>
      ) : p.list.length === 0 ? (
        <div class="hist-empty">还没有安装任何 adapter — 去「市场」tab 一键装几个</div>
      ) : (
        <ul class="adapters-list">
          {p.list.map((a) => (
            <li key={a.id} class="adapter-card">
              <div class="adapter-card-head">
                <code class="adapter-card-title">{a.title}</code>
                {a.kind === 'func' && <span class="ad-chip kind-func">func</span>}
                {a.kind === 'mixed' && <span class="ad-chip kind-mixed">mixed</span>}
                {!a.enabled && <span class="ad-chip muted">已禁用</span>}
                <span class="adapter-card-cmd-count">{a.commandCount} 命令</span>
              </div>
              <div class="adapter-card-actions">
                <button class="btn sm outline" onClick={() => void p.onToggle(a)}>
                  {a.enabled ? '禁用' : '启用'}
                </button>
                <button class="btn sm danger outline" onClick={() => void p.onUninstall(a)}>
                  卸载
                </button>
                {a.origin.type === 'marketplace' && (
                  <span class="adapter-card-origin">来自市场</span>
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
  // The func/Chrome-138 notice is one-time information; surface it on-demand
  // via the (?) button next to the filter pills so it doesn't perpetually
  // eat space at the top of every visit.
  const [showFuncNote, setShowFuncNote] = useState(false);
  if (p.err) {
    return (
      <div class="banner err">
        <div>
          <div style="font-weight:600;margin-bottom:4px">市场加载失败</div>
          <div style="font-size:11px;line-height:1.5">{p.err}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.5">
            确保 dist/marketplace/index.json 存在,且 manifest 把 marketplace/* 列在
            web_accessible_resources。重建: node scripts/build-marketplace-index.mjs --popular
          </div>
        </div>
      </div>
    );
  }
  if (!p.market) {
    return <div class="hist-empty">加载市场目录…</div>;
  }
  return (
    <div>
      <div class="market-search">
        <input
          type="text"
          placeholder="搜索 site / name / 描述(例: reddit、价格、新闻)"
          value={p.search}
          onInput={(e) => p.onSearchChange((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="market-filters">
        <button
          class={`pill ${p.typeFilter === 'all' ? 'selected' : ''}`}
          onClick={() => p.onTypeFilterChange('all')}
        >
          全部 <span class="count">{p.counts.all}</span>
        </button>
        <button
          class={`pill ${p.typeFilter === 'pipeline' ? 'selected' : ''}`}
          onClick={() => p.onTypeFilterChange('pipeline')}
        >
          pipeline <span class="count">{p.counts.pipeline}</span>
        </button>
        <button
          class={`pill ${p.typeFilter === 'func' ? 'selected' : ''}`}
          onClick={() => p.onTypeFilterChange('func')}
        >
          func <span class="count">{p.counts.func}</span>
        </button>
        {p.counts.func > 0 && (
          <button
            class={`pill info-toggle ${showFuncNote ? 'selected' : ''}`}
            onClick={() => setShowFuncNote((v) => !v)}
            title="关于 func 型 adapter 的运行前提"
            aria-label="func 型说明"
            aria-expanded={showFuncNote}
          >
            ?
          </button>
        )}
      </div>

      {showFuncNote && (
        <div class="banner warn" style="margin-bottom:14px">
          <div>
            <strong>func 型</strong>需 Chrome 138+,并在「扩展详情 → 允许用户脚本」开关打开,
            否则装了也跑不起来(toast 会报红)。
          </div>
        </div>
      )}

      {p.featured.length > 0 && p.search.trim() === '' && p.typeFilter === 'all' && (
        <div class="market-featured">
          <div class="market-featured-label">⭐ 推荐</div>
          <ul class="market-list">
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

      <div class="market-result-count">
        显示 {p.filtered.length}
        {p.filtered.length !== p.counts.all ? ` / ${p.counts.all}` : ''}
      </div>
      {p.filtered.length === 0 ? (
        <div class="hist-empty">没有匹配的 adapter</div>
      ) : (
        <ul class="market-list market-list-scroll">
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

function MarketRow({
  a,
  installed,
  installing,
  onInstall,
  accent,
}: MarketRowProps): preact.JSX.Element {
  const id = entryId(a);
  // pipeline 绿、func 橙(orange 提示 func 需要「允许用户脚本」开关)。
  const typeChip =
    a.type === 'pipeline' ? (
      <span class="ad-chip type-pipeline">pipeline</span>
    ) : a.type === 'func' ? (
      <span class="ad-chip type-func">func</span>
    ) : null;
  return (
    <li class={`market-row ${accent ? 'accent' : ''}`}>
      <div class="market-row-body">
        <div class="market-row-head">
          <code class="market-row-id">{id}</code>
          {typeChip}
        </div>
        {a.description && <div class="market-row-desc">{a.description}</div>}
      </div>
      {installed ? (
        <span class="market-row-installed">✓ 已安装</span>
      ) : (
        <button class="btn sm primary" disabled={installing} onClick={() => void onInstall(a)}>
          {installing ? '安装中…' : '安装'}
        </button>
      )}
    </li>
  );
}
