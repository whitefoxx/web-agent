/**
 * Adapters management section for the settings drawer.
 *
 * Installing was removed 2026-07-09 — adapters are used on demand via ephemeral
 * `load_adapter` (the agent runs find_adapters → load_adapter each task), so
 * there's no persistent install. Two tabs remain:
 *  - Explore-generated — adapters synthesized via the explore flow (origin 'explore', the
 *               ONLY persisted kind). Auto-persisted by the SW when the smoke
 *               test passes (or a write adapter skips it) — no Install click; rows
 *               carry an untested / verified / verify-failed badge + delete.
 *  - Marketplace — browse the bundled catalog (count from marketplace/index.json at
 *             fetch time); each row can be Run (ephemeral load + try it) or
 *             Reference (hand it to the agent in chat). No install, no manual
 *             pre-loading (load-into-session removed 2026-07-11 — Reference covers it).
 *
 * Load path: adapter source → sha256-verified fetch → eval'd in the offscreen
 * sandbox → registered into the SW registry for THIS session only. func adapters
 * need the per-extension "Allow User Scripts" toggle (Chrome 138+) to execute,
 * surfaced in the banner. (Explore-synthesized adapters persist via the same
 * captured-defs path, kept for that flow only.)
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  installAdapterFromSource,
  listInstalled,
  getAdapterSource,
  getAdapterCommands,
  uninstallAdapter,
  loadAdapter,
  type HealTarget,
} from './adapters-client';
import { RunPanel } from './adapter-run';
import { buildAdapterReport } from '../adapters/adapter-report';
import { highlightMatches } from './highlight';
import {
  fetchMarketIndex,
  fetchAdapterSource,
  entryId,
  type MarketIndex,
  type MarketAdapter,
} from '@base/core/marketplace';
import type {
  InstalledAdapterSummary,
  AdapterCommand,
  GetAdapterHealthReq,
  GetAdapterHealthResp,
  ReregisterAdaptersReq,
  ReregisterAdaptersResp,
} from '../messages';
import {
  computeHealthStatus,
  type AdapterHealth,
  type HealthStatus,
} from '../adapters/adapter-health-store';
import {
  IconCopy,
  IconCheck,
  IconCode,
  IconPlug,
  IconPlay,
  IconTrash,
  IconChevronDown,
  IconCornerUpLeft,
  IconRefresh,
  IconDownload,
} from './Icons';

type Tab = 'mine' | 'market';
type TypeFilter = 'all' | 'pipeline' | 'func';

type InstallState =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'ok'; msg: string }
  | { kind: 'err'; msg: string };

export function AdaptersSection({
  onReference,
  onHeal,
}: {
  /** Insert the adapter's tool chip(s) into the chat composer (and close this
   * page). Lets the user reference any adapter — incl. not-installed — to the
   * agent, like /command does for installed ones. */
  onReference?: (tools: string[]) => void;
  /** Start an explore run seeded to re-derive a drifted adapter (H1-P2). */
  onHeal?: (task: string, label: string, healTarget: HealTarget) => void;
} = {}) {
  const [tab, setTab] = useState<Tab>('market');
  const [list, setList] = useState<InstalledAdapterSummary[]>([]);
  const [health, setHealth] = useState<Map<string, AdapterHealth>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<InstallState>({ kind: 'idle' });
  // Proactive "Allow user scripts" guidance (adapter-hot-plug §10.38): most market
  // adapters are func-type and silently can't run while the per-extension
  // toggle is off (it resets whenever the unpacked build is re-added). Detect
  // it live and guide the user instead of letting installs fail mysteriously.
  const [userScriptsOn, setUserScriptsOn] = useState<boolean>(() => {
    const c = (globalThis as { chrome?: { userScripts?: { configureWorld?: unknown } } }).chrome;
    return !!c?.userScripts && typeof c.userScripts.configureWorld === 'function';
  });

  async function retryUserScripts(): Promise<void> {
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'REREGISTER_ADAPTERS',
      } satisfies ReregisterAdaptersReq)) as ReregisterAdaptersResp | undefined;
      if (r?.available) {
        setUserScriptsOn(true);
        setState({
          kind: 'ok',
          msg: r.commands > 0 ? `Enabled: registered ${r.commands} adapter command(s)` : 'Enabled',
        });
        void refresh();
      } else {
        setState({
          kind: 'err',
          msg: 'The browser has not granted the "user scripts" permission to the extension yet — reload this extension once at chrome://extensions (the ↻ on the card), and installed adapters will take effect automatically',
        });
      }
    } catch {
      setState({ kind: 'err', msg: 'Check failed, please reload the extension and try again' });
    }
  }

  // Market state.
  const [market, setMarket] = useState<MarketIndex | null>(null);
  const [marketErr, setMarketErr] = useState<string | null>(null);
  const [refreshingMarket, setRefreshingMarket] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  async function refresh(): Promise<void> {
    setLoading(true);
    setList(await listInstalled());
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'GET_ADAPTER_HEALTH',
      } satisfies GetAdapterHealthReq)) as GetAdapterHealthResp | undefined;
      setHealth(new Map((r?.health ?? []).map((h) => [h.id, h])));
    } catch {
      /* health is best-effort */
    }
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

  // Lazy-load the market index the first time the user opens the Marketplace tab.
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

  // "Update now": the market index is cache-first with a 6h TTL (marketplace.ts),
  // so a just-pushed adapter can be up to 6h invisible — and the lazy-load
  // effect above never re-fetches once `market` is set. This forces a fresh
  // network pull (bypassing the cache), so newly-published adapters show up now.
  async function onRefreshMarket(): Promise<void> {
    setRefreshingMarket(true);
    try {
      const idx = await fetchMarketIndex({ forceFresh: true });
      setMarket(idx);
      setMarketErr(null);
      setState({ kind: 'ok', msg: `Catalog updated · ${idx.adapters.length} adapters total` });
    } catch (e) {
      setState({ kind: 'err', msg: `Update failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRefreshingMarket(false);
    }
  }

  // Adapters this extension synthesized via explore (origin 'explore') — the
  // only persisted kind now that install was removed.
  const mineList = useMemo(() => list.filter((a) => a.origin.type === 'explore'), [list]);

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
  ): Promise<boolean> {
    setState({ kind: 'installing' });
    const r = await installAdapterFromSource(src, origin);
    if (!r.ok) {
      setState({ kind: 'err', msg: r.error ?? 'Install failed' });
      return false;
    }
    const name = r.title ?? r.id ?? '';
    const registered = r.registered ?? 0;
    const dFunc = r.deferredFunc ?? 0;
    const dUnsup = r.deferredUnsupported ?? 0;
    // 0 registered + something deferred = the user clicked install but nothing
    // actually became a callable tool. Surface it as a WARNING, not a success,
    // and say why — otherwise the toast looks like a green tick and the user
    // reasonably expects it to work.
    if (registered === 0 && (dFunc > 0 || dUnsup > 0)) {
      const reasons: string[] = [];
      if (dFunc > 0) reasons.push(`${dFunc} func command(s) not registered (enable "Allow user scripts" in the extension details)`);
      if (dUnsup > 0) reasons.push(`${dUnsup} pipeline command(s) use steps the engine does not support`);
      setState({
        kind: 'err',
        msg: `${name} saved but has no usable commands — ${reasons.join('; ')}. The agent can't see this tool and will fall back to generic__* when called.`,
      });
      void refresh();
      return true;
    }
    const parts = [`Installed ${name}`];
    if (registered) parts.push(`${registered} command(s) available`);
    if (dFunc) parts.push(`${dFunc} func command(s) deferred (enable "Allow user scripts")`);
    if (dUnsup) parts.push(`${dUnsup} pipeline command(s) use unsupported steps`);
    setState({ kind: 'ok', msg: parts.join(' · ') });
    void refresh();
    return true;
  }

  // Restore the upstream marketplace version of a locally-healed adapter,
  // discarding the local heal (re-couples it to market auto-updates). H1 #2.
  async function onRestore(id: string): Promise<void> {
    try {
      // forceFresh: fetchAdapterSource below sha-verifies against this index.
      const idx = await fetchMarketIndex({ forceFresh: true });
      setMarket(idx);
      const entry = idx.adapters.find((e) => entryId(e) === id);
      if (!entry) {
        setState({ kind: 'err', msg: 'This tool is no longer in the marketplace and can\'t be restored' });
        return;
      }
      const src = await fetchAdapterSource(entry);
      await installSource(src, { type: 'marketplace', url: `bundled:${id}` });
    } catch (e) {
      setState({ kind: 'err', msg: e instanceof Error ? e.message : 'Restore failed' });
    }
  }

  async function onUninstall(a: InstalledAdapterSummary): Promise<void> {
    if (!confirm(`Uninstall ${a.title}?`)) return;
    await uninstallAdapter(a.id);
    void refresh();
  }

  return (
    <div class="adapters-section">
      <p class="page-intro">
        An adapter wraps a site's actions into a <b>tool</b> the AI can call (like "search 小红书" or "get 微博 trending").
        <b>No install needed</b>: when a task starts the agent automatically finds a fitting adapter in the <b>marketplace</b> and loads it on demand; you can also
        <b>Run</b> one to try it out, or <b>Reference</b> it into the chat for the agent. Site you want isn't there? Use
        <b>explore-and-generate-a-tool</b> mode (type <code>/explore</code> in the composer) and let the agent
        figure it out live and generate one — anything that passes its try-run shows up automatically in the
        <b>Explore-generated</b> tab (persisted, deletable).
      </p>
      <div class="adapters-tip">
        💡 Adapters are <b>loaded on demand, never persisted to disk</b>: a load lasts only for the current session (gone on SW restart), so they
        <b>don't stay resident and don't eat tokens</b>; next task the agent just finds and loads again — nothing for you to manage.
      </div>
      {!userScriptsOn && (
        <div class="banner warn" style="margin-bottom:10px">
          ⚠️ <b>"Allow user scripts" is off</b> — most marketplace adapters (func-type) won't run even after loading. To enable:
          <code>chrome://extensions</code> → this extension's "Details" → turn on
          <b>"Allow user scripts"</b> (on Chrome below 138, turn on "Developer mode" at the top right instead),
          then come back and click "I've enabled it" — no browser restart needed.
          <div style="display:flex;gap:8px;margin-top:8px">
            <button
              class="btn outline"
              onClick={() =>
                void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
              }
            >
              Open extension settings
            </button>
            <button class="btn primary" onClick={() => void retryUserScripts()}>
              I've enabled it, apply now
            </button>
          </div>
        </div>
      )}
      <div class="pill-row" style="margin-bottom:14px">
        <button
          class={`pill ${tab === 'market' ? 'selected' : ''}`}
          onClick={() => setTab('market')}
        >
          Marketplace {typeof market?.count === 'number' && <span class="count">{market.count}</span>}
        </button>
        <button class={`pill ${tab === 'mine' ? 'selected' : ''}`} onClick={() => setTab('mine')}>
          Explore-generated <span class="count">{mineList.length}</span>
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

      {tab === 'mine' && (
        <InstalledPanel
          list={mineList}
          health={health}
          onHeal={onHeal}
          onRestore={onRestore}
          loading={loading}
          isMine
          emptyHint="Switch to explore-and-generate-a-tool mode in the chat and run once; the generated tools will appear here."
          onUninstall={onUninstall}
          onReference={onReference}
        />
      )}

      {tab === 'market' && (
        <MarketPanel
          market={market}
          err={marketErr}
          filtered={filtered}
          counts={marketCounts}
          search={search}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          onSearchChange={setSearch}
          onReference={onReference}
          onRefresh={onRefreshMarket}
          refreshing={refreshingMarket}
        />
      )}
    </div>
  );
}

/* ───────── installed tab ───────── */

interface InstalledPanelProps {
  list: InstalledAdapterSummary[];
  health: Map<string, AdapterHealth>;
  onHeal?: (task: string, label: string, healTarget: HealTarget) => void;
  onRestore?: (id: string) => void;
  loading: boolean;
  /** Explore-generated tab: label the destructive action Delete (vs Uninstall). */
  isMine?: boolean;
  /** Empty-state message override. */
  emptyHint?: string;
  onUninstall: (a: InstalledAdapterSummary) => Promise<void>;
  onReference?: (tools: string[]) => void;
}

/** Lists persisted adapters — now only the explore-synthesized ones (Explore-generated
 * tab). Install/paste was removed 2026-07-09. */
function InstalledPanel(p: InstalledPanelProps): preact.JSX.Element {
  return (
    <div>
      {p.loading ? (
        <div class="hist-empty">Loading…</div>
      ) : p.list.length === 0 ? (
        <div class="empty-state">
          <div class="empty-glyph">
            <IconPlug size={22} />
          </div>
          <div class="empty-title">No explore-generated tools yet</div>
          <div class="empty-hint">
            {p.emptyHint ?? 'Switch to explore-and-generate-a-tool mode in the chat and run once; the generated tools will appear here.'}
          </div>
        </div>
      ) : (
        <ul class="item-list">
          {p.list.map((a) => (
            <InstalledRow
              key={a.id}
              a={a}
              health={p.health.get(a.id)}
              onHeal={p.onHeal}
              onRestore={p.onRestore}
              isMine={p.isMine}
              onUninstall={p.onUninstall}
              onReference={p.onReference}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Seed the heal task for a drifted adapter: its broken source + last error +
 * the target, so the explore agent re-derives the SAME operation (same name)
 * rather than starting blind. */
export function buildHealTask(
  id: string,
  source: string,
  lastError?: string,
): { task: string; label: string } {
  const slash = id.indexOf('/');
  const site = slash < 0 ? id : id.slice(0, slash);
  const name = slash < 0 ? id : id.slice(slash + 1);
  const tool = `${site}__${name}`;
  const label = `🔧 Fix ${tool}`;
  const task =
    `Please fix a broken site adapter \`${tool}\` (it keeps failing in real runs — the site structure likely changed).\n\n` +
    (lastError ? `Most recent error:\n${lastError}\n\n` : '') +
    `Its current source:\n\`\`\`js\n${source}\n\`\`\`\n\n` +
    `Task: re-explore this operation on the site — open_url the relevant pages, use find_structured_data / ` +
    `find_in_network / read_network / eval_js to confirm where the data comes from now, then call ` +
    `synthesize_adapter with the **same name \`${name}\`** to regenerate it, until verify passes (returns non-empty rows). ` +
    `Try to keep the argument schema the same as before.`;
  return { task, label };
}

function fmtAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  return `${Math.floor(sec / 86400)} days ago`;
}

const HEALTH_BADGE: Record<
  Exclude<HealthStatus, 'healthy' | 'unknown'>,
  { label: string; cls: string }
> = {
  broken: { label: 'May be broken', cls: 'broken' },
  degraded: { label: 'Degraded', cls: 'degraded' },
  blocked: { label: 'Restricted', cls: 'blocked' },
};

/** Health badge on an installed-adapter row — shown only when NOT healthy, so the
 * list surfaces drift/blocks instead of decorating the normal case. broken =
 * likely-drifted (≥3 consecutive empty/generic fails), degraded = 1–2, blocked =
 * site-side (auth/rate). Tooltip carries the last error + last-success time. */
function HealthBadge({ health }: { health?: AdapterHealth }): preact.JSX.Element | null {
  const status = computeHealthStatus(health);
  if (status === 'healthy' || status === 'unknown') return null;
  const b = HEALTH_BADGE[status];
  const worked = health?.lastOkTs ? `last OK ${fmtAgo(health.lastOkTs)}` : 'never succeeded';
  const title = `${b.label}${health?.lastError ? ` — ${health.lastError}` : ''}(${worked})`;
  return (
    <span class={`health-badge ${b.cls}`} title={title}>
      {b.label}
    </span>
  );
}

/** One installed-adapter row — a unified item card. Tap the head to expand:
 * chips + description, then Run / Source / Uninstall. Uninstall is the only destructive
 * action (no enable/disable — if you don't want it, uninstall). */
function InstalledRow({
  a,
  health,
  isMine,
  onUninstall,
  onReference,
  onHeal,
  onRestore,
}: {
  a: InstalledAdapterSummary;
  health?: AdapterHealth;
  isMine?: boolean;
  onHeal?: (task: string, label: string, healTarget: HealTarget) => void;
  onRestore?: (id: string) => void;
  onUninstall: (a: InstalledAdapterSummary) => Promise<void>;
  onReference?: (tools: string[]) => void;
}): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [commands, setCommands] = useState<AdapterCommand[] | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function loadCommands(): Promise<void> {
    if (commands === null) setCommands(await getAdapterCommands(a.id));
  }

  // Fetch commands the first time the card opens — gives us the description and
  // populates the run panel without a second round-trip.
  async function toggleCard(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next) await loadCommands();
  }

  async function onToggleRun(): Promise<void> {
    const next = !runOpen;
    setRunOpen(next);
    if (next) {
      setSourceOpen(false);
      await loadCommands();
    }
  }

  async function onToggleSource(): Promise<void> {
    if (sourceOpen) {
      setSourceOpen(false);
      return;
    }
    if (source == null) {
      setSourceBusy(true);
      const s = await getAdapterSource(a.id);
      setSource(s);
      setSourceBusy(false);
      if (s == null) return;
    }
    setRunOpen(false);
    setSourceOpen(true);
  }

  async function onCopySource(): Promise<void> {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  // Reference this adapter into the chat composer as tool chip(s) — one per
  // command. Load commands first if the card was never expanded.
  async function onReferenceClick(): Promise<void> {
    let cmds = commands;
    if (cmds === null) {
      cmds = await getAdapterCommands(a.id);
      setCommands(cmds);
    }
    const tools = cmds.map((c) => c.tool);
    if (tools.length) onReference?.(tools);
  }

  const healStatus = computeHealthStatus(health);
  const healable = healStatus === 'broken' || healStatus === 'degraded';

  // Re-derive a drifted adapter: fetch its current source, seed an explore run
  // (via onHeal → App.startRun) to re-explore + re-synthesize the SAME operation.
  async function onHealClick(): Promise<void> {
    let src = source;
    if (src == null) {
      src = await getAdapterSource(a.id);
      setSource(src);
    }
    if (!src) return;
    const { task, label } = buildHealTask(a.id, src, health?.lastError);
    const slash = a.id.indexOf('/');
    onHeal?.(task, label, {
      id: a.id,
      site: slash < 0 ? a.id : a.id.slice(0, slash),
      name: slash < 0 ? a.id : a.id.slice(slash + 1),
      origin: a.origin,
    });
  }

  // Report this broken MARKET adapter to the marketplace repo (pre-filled issue).
  function onReport(): void {
    const r = buildAdapterReport({
      id: a.id,
      tool: a.id.replace('/', '__'),
      error: health?.lastError,
      version: chrome.runtime.getManifest().version,
    });
    void chrome.tabs.create({ url: r.url, active: true });
  }

  // Contribute the local heal back to the market (pre-filled issue w/ source).
  async function onContributeHeal(): Promise<void> {
    let src = source;
    if (src == null) {
      src = await getAdapterSource(a.id);
      setSource(src);
    }
    if (!src) return;
    const r = buildAdapterReport({
      id: a.id,
      tool: a.id.replace('/', '__'),
      source: src,
      version: chrome.runtime.getManifest().version,
    });
    if (r.clipboard) {
      try {
        await navigator.clipboard.writeText(r.clipboard);
      } catch {
        /* ignore */
      }
    }
    void chrome.tabs.create({ url: r.url, active: true });
  }

  const kindLabel = a.kind === 'func' ? 'func' : a.kind === 'mixed' ? 'mixed' : 'pipeline';
  const healed = a.origin.healedFrom === 'marketplace';
  const originLabel = healed
    ? 'locally healed'
    : a.origin.type === 'marketplace'
      ? 'from marketplace'
      : a.origin.type === 'explore'
        ? 'locally explored'
        : 'manually installed';

  return (
    <li class={`item-card ${open ? 'open' : ''}`}>
      <button class="item-head" onClick={() => void toggleCard()} aria-expanded={open}>
        <span class={`item-glyph ${a.verifyStatus === 'passed' ? 'ok' : ''}`}>
          <IconPlug size={16} />
        </span>
        <span class="item-main">
          <span class="item-title mono">{a.title}</span>
          <span class="item-sub">
            <span class="item-sub-text">
              {a.description || `${kindLabel} · ${originLabel}`}
            </span>
          </span>
        </span>
        <HealthBadge health={health} />
        {healed && (
          <span
            class="healed-tag"
            title="This tool has been healed locally and decoupled from marketplace auto-updates. Expand to 'Restore marketplace version' to pull back the official one."
          >
            Local fix
          </span>
        )}
        <span class="item-meta">{a.commandCount} commands</span>
        <IconChevronDown size={16} class="item-chevron" />
      </button>
      {open && (
        <div class="item-body">
          <div class="item-chips">
            {a.kind === 'func' && <span class="ad-chip kind-func">func</span>}
            {a.kind === 'mixed' && <span class="ad-chip kind-mixed">mixed</span>}
            {a.origin.type === 'explore' && <span class="ad-chip accent">Explore-generated</span>}
            {a.verifyStatus === 'passed' && <span class="ad-chip ok">Verified</span>}
            {a.verifyStatus === 'failed' && (
              <span class="ad-chip danger" title={a.verifyNote}>
                Verify failed
              </span>
            )}
            {a.verifyStatus === 'untested' && <span class="ad-chip muted">Untested</span>}
          </div>
          <div class="item-actions">
            {healable && onHeal && (
              <button
                class="btn sm heal"
                title="Have the AI re-explore and rebuild this broken tool"
                onClick={() => void onHealClick()}
              >
                <IconRefresh size={13} /> Fix
              </button>
            )}
            {healable && a.origin.type === 'marketplace' && (
              <button
                class="btn sm outline"
                title="File a breakage report to the marketplace (GitHub issue)"
                onClick={onReport}
              >
                Report broken
              </button>
            )}
            {healed && onRestore && (
              <button
                class="btn sm outline"
                title="Pull back the official marketplace version, discarding the local fix (re-accept marketplace auto-updates)"
                onClick={() => void onRestore(a.id)}
              >
                <IconDownload size={13} /> Restore marketplace version
              </button>
            )}
            {healed && (
              <button
                class="btn sm heal"
                title="Contribute your local fix to the marketplace (opens a GitHub issue with the source; a maintainer audits and merges it)"
                onClick={() => void onContributeHeal()}
              >
                Contribute fix
              </button>
            )}
            {a.enabled && (
              <button class="btn sm tonal" onClick={() => void onToggleRun()}>
                <IconPlay size={13} /> {runOpen ? 'Collapse' : 'Run'}
              </button>
            )}
            <button class="btn sm outline" onClick={() => void onToggleSource()}>
              <IconCode size={13} /> {sourceOpen ? 'Hide source' : 'Source'}
            </button>
            {onReference && (
              <button
                class="btn sm outline"
                title="Reference into the chat: have the AI run / explain / modify it"
                onClick={() => void onReferenceClick()}
              >
                <IconCornerUpLeft size={13} /> Reference
              </button>
            )}
            <button class="btn sm danger spacer" onClick={() => void onUninstall(a)}>
              <IconTrash size={13} /> {isMine ? 'Delete' : 'Uninstall'}
            </button>
          </div>
          {sourceBusy && <div class="item-sub">Loading source…</div>}
          {sourceOpen && source != null && (
            <div class="item-code-wrap">
              <button
                class="item-code-copy"
                title={copied ? 'Copied' : 'Copy source'}
                onClick={() => void onCopySource()}
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </button>
              <pre class="item-code">{source}</pre>
            </div>
          )}
          {runOpen && (
            <div class="adapter-card-run">
              {commands === null ? (
                <div class="item-sub">Loading commands…</div>
              ) : commands.length === 0 ? (
                <div class="item-sub">No runnable commands.</div>
              ) : (
                commands.map((c) => (
                  <CommandRunner key={c.tool} c={c} onCancel={() => setRunOpen(false)} />
                ))
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** One command inside an installed adapter: header + a manual run panel (read
 * commands only — writes still go through the in-conversation write-confirm). */
function CommandRunner({
  c,
  onCancel,
}: {
  c: AdapterCommand;
  onCancel?: () => void;
}): preact.JSX.Element {
  return (
    <div style="border-top:1px dashed rgba(127,127,127,.2);padding-top:6px;margin-top:6px;">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <code style="font-size:12px;">{c.tool}</code>
        {c.access === 'write' && (
          <span class="ad-chip" style="background:rgba(239,68,68,0.1);color:var(--err);border:1px solid rgba(239,68,68,0.2);">
            write
          </span>
        )}
      </div>
      {c.description && (
        <div style="font-size:11px;opacity:.7;margin-top:2px;">{c.description}</div>
      )}
      {c.access === 'write' ? (
        <div style="font-size:12px;opacity:.6;margin-top:4px;">
          Run write operations in the chat (they ask for confirmation).
        </div>
      ) : (
        <RunPanel tool={c.tool} args={c.args} onCancel={onCancel} />
      )}
    </div>
  );
}

/* ───────── market tab ───────── */

interface MarketPanelProps {
  market: MarketIndex | null;
  err: string | null;
  filtered: MarketAdapter[];
  counts: { all: number; pipeline: number; func: number };
  search: string;
  typeFilter: TypeFilter;
  onTypeFilterChange: (t: TypeFilter) => void;
  onSearchChange: (s: string) => void;
  onReference?: (tools: string[]) => void;
  /** Force a fresh index pull (bypasses the 6h cache). */
  onRefresh: () => Promise<void>;
  refreshing: boolean;
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
          <div style="font-weight:600;margin-bottom:4px">Failed to load marketplace</div>
          <div style="font-size:11px;line-height:1.5">{p.err}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.5">
            Adapters come from a remote repo (GitHub
            raw). Check your network; if offline, already-loaded / explore-generated adapters still work — you just can't browse new ones.
          </div>
          <button
            class="pill market-refresh"
            style="margin-top:10px"
            onClick={() => void p.onRefresh()}
            disabled={p.refreshing}
          >
            <IconRefresh size={12} /> {p.refreshing ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    );
  }
  if (!p.market) {
    return <div class="hist-empty">Loading marketplace catalog…</div>;
  }
  return (
    <div>
      <div class="market-search">
        <input
          type="text"
          placeholder="Search site / name / description (e.g. reddit, price, news)"
          value={p.search}
          onInput={(e) => p.onSearchChange((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="market-filters">
        <button
          class={`pill ${p.typeFilter === 'all' ? 'selected' : ''}`}
          onClick={() => p.onTypeFilterChange('all')}
        >
          All <span class="count">{p.counts.all}</span>
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
            title="About what func-type adapters need to run"
            aria-label="About func-type adapters"
            aria-expanded={showFuncNote}
          >
            ?
          </button>
        )}
        <button
          class="pill market-refresh"
          onClick={() => void p.onRefresh()}
          disabled={p.refreshing}
          title="Pull the latest catalog from the remote repo (bypasses the 6-hour cache; just-published adapters show up immediately)"
        >
          <IconRefresh size={12} /> {p.refreshing ? 'Updating…' : 'Update catalog'}
        </button>
      </div>

      {showFuncNote && (
        <div class="banner warn" style="margin-bottom:14px">
          <div>
            <strong>func-type</strong> adapters need Chrome 138+ and the "Extension details → Allow user scripts" toggle on,
            otherwise they won't run even once installed (the toast turns red).
          </div>
        </div>
      )}

      <div class="market-result-count">
        Showing {p.filtered.length}
        {p.filtered.length !== p.counts.all ? ` / ${p.counts.all}` : ''}
      </div>
      {p.filtered.length === 0 ? (
        <div class="hist-empty">No matching adapters</div>
      ) : (
        <ul class="item-list">
          {p.filtered.map((a) => (
            <MarketRow key={entryId(a)} a={a} search={p.search} onReference={p.onReference} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface MarketRowProps {
  a: MarketAdapter;
  search: string;
  onReference?: (tools: string[]) => void;
}

/** A market adapter as a unified item-card: tap to expand → Run (ephemeral load, try it) /
 * Source (full-width) / Reference. No install — the agent loads adapters on demand per task
 * (load-into-session was removed 2026-07-11: Reference covers the "hand it to the agent"
 * intent, and find_adapters/load_adapter make manual pre-loading unnecessary). */
function MarketRow({ a, search, onReference }: MarketRowProps): preact.JSX.Element {
  const id = entryId(a);
  const tool = `${a.site}__${a.name}`;
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [commands, setCommands] = useState<AdapterCommand[] | null>(null);

  async function onToggleSource(): Promise<void> {
    if (sourceOpen) {
      setSourceOpen(false);
      return;
    }
    if (source == null) {
      setSourceBusy(true);
      let s: string;
      try {
        s = await fetchAdapterSource(a);
      } catch {
        s = '';
      }
      setSource(s);
      setSourceBusy(false);
      if (!s) return;
    }
    setRunOpen(false);
    setSourceOpen(true);
  }

  async function onCopySource(): Promise<void> {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  // Run a not-installed market adapter: load it ephemerally (offscreen eval) into
  // the session, then run — no install needed.
  async function onToggleRun(): Promise<void> {
    if (runOpen) {
      setRunOpen(false);
      return;
    }
    setSourceOpen(false);
    setRunOpen(true);
    if (commands === null) {
      setRunBusy(true);
      setRunErr(null);
      const r = await loadAdapter(a.site, a.name);
      setRunBusy(false);
      if (r.ok) setCommands(r.commands ?? []);
      else setRunErr(r.error ?? 'Load failed');
    }
  }

  const typeChip =
    a.type === 'pipeline' ? (
      <span class="ad-chip type-pipeline">pipeline</span>
    ) : a.type === 'func' ? (
      <span class="ad-chip type-func">func</span>
    ) : null;

  return (
    <li class={`item-card ${open ? 'open' : ''}`}>
      <button class="item-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span class="item-glyph neutral">
          <IconPlug size={16} />
        </span>
        <span class="item-main">
          <span class="item-title mono">{highlightMatches(id, search)}</span>
          {a.description && (
            <span class="item-sub">
              <span class="item-sub-text">{highlightMatches(a.description, search)}</span>
            </span>
          )}
        </span>
        <IconChevronDown size={16} class="item-chevron" />
      </button>
      {open && (
        <div class="item-body">
          <div class="item-chips">{typeChip}</div>
          <div class="item-actions">
            <button class="btn sm tonal" onClick={() => void onToggleRun()}>
              <IconPlay size={13} /> {runOpen ? 'Collapse' : 'Run'}
            </button>
            <button class="btn sm outline" onClick={() => void onToggleSource()}>
              <IconCode size={13} />{' '}
              {sourceBusy && !sourceOpen ? 'Loading…' : sourceOpen ? 'Hide source' : 'Source'}
            </button>
            {onReference && (
              <button
                class="btn sm outline"
                title="Reference into the chat: have the AI run / explain / modify it"
                onClick={() => onReference([tool])}
              >
                <IconCornerUpLeft size={13} /> Reference
              </button>
            )}
          </div>
          {sourceOpen && source && (
            <div class="item-code-wrap">
              <button
                class="item-code-copy"
                title={copied ? 'Copied' : 'Copy source'}
                onClick={() => void onCopySource()}
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </button>
              <pre class="item-code">{source}</pre>
            </div>
          )}
          {runOpen && (
            <div class="adapter-card-run">
              {runBusy ? (
                <div class="item-sub">Loading temporarily…</div>
              ) : runErr ? (
                <div class="item-sub" style="color:var(--err)">
                  {runErr}
                </div>
              ) : commands === null ? null : commands.length === 0 ? (
                <div class="item-sub">No runnable commands.</div>
              ) : (
                commands.map((c) => (
                  <CommandRunner key={c.tool} c={c} onCancel={() => setRunOpen(false)} />
                ))
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
