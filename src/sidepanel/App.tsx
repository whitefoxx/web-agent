import { Component, createContext, Fragment } from 'preact';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import { Markdown } from './Markdown';
import { AdaptersSection, buildHealTask } from './Adapters';
import { buildAdapterReport } from '../adapters/adapter-report';
import { toExploredSite } from '../adapters/namespace';
import { highlightMatches } from './highlight';
import { CopyableBlock } from './components/CopyableBlock';
import { WelcomeCard } from './components/WelcomeCard';
import {
  IconArrowUp,
  IconChevronLeft,
  IconClock,
  IconCog,
  IconMenu,
  IconPlus,
  IconPlug,
  IconBrain,
  IconPaperclip,
  IconFile,
  IconRefresh,
  IconStop,
  IconTerminal,
  IconX,
  IconFlag,
  IconEye,
  IconSearch,
  IconCamera,
  IconPointer,
  IconType,
  IconScroll,
  IconList,
  IconBranch,
  IconSave,
  IconImage,
  IconGlobe,
  IconCheckCircle,
  IconChevronDown,
  IconDot,
  IconHand,
  IconFastForward,
  IconCheck,
  IconCopy,
  IconSparkle,
  IconPlay,
  IconPencil,
  IconTrash,
  IconCornerDownLeft,
  IconUpload,
  IconMaximize,
  IconChevronUp,
  IconNote,
  IconDownload,
  IconKey,
  IconChat,
} from './Icons';
import {
  listSecretInfos,
  saveSecret,
  updateSecretMeta,
  renameSecret,
  deleteSecret,
  isValidSecretName,
  type SecretInfo,
} from '../config/secret-store';
import { FEATURES } from '../config/features';
import {
  loadRedactPatterns,
  saveRedactPattern,
  deleteRedactPattern,
  makeRedactId,
  isValidRegex,
  type RedactPattern,
} from '../config/redaction-store';
import { toolActivity, screenshotDataUrl, planSites, type ActivityIcon } from './activity';
import { initArgVals, buildArgs, runTool, ArgsForm } from './adapter-run';
import { captureRegion } from './region-capture';
import {
  gatherCommands,
  mergeToolCatalog,
  expandCommandTokens,
  tokensToDisplay,
  type CommandItem,
} from './commands';
import { fetchMarketIndex, type MarketAdapter, type MarketIndex } from '@base/core/marketplace';
import { CommandEditor, type CommandEditorHandle } from './command-editor';
import {
  listShortcuts,
  saveShortcut,
  deleteShortcut,
  makeShortcutId,
  type Shortcut,
} from '../shortcuts/store';
import {
  listSkills,
  saveSkill,
  deleteSkill,
  makeSkillId,
  type Skill,
} from '../skills/store';
import {
  makeScheduleId,
  cadenceLabel,
  listScheduleNotices,
  removeScheduleNotice,
  SCHEDULE_NOTICES_KEY,
  SCHEDULES_KEY,
  type Schedule,
  type Cadence,
  type ScheduleNotice,
} from '../schedules/store';
import type { UiAssistantTurn, UiTurn } from './types';
import {
  type AbortSessionReq,
  type SteerMessageReq,
  type AssistantTurnEvt,
  type AssistantTurnPatchEvt,
  type RunStatsEvt,
  type DeleteSessionReq,
  type GetSessionReq,
  type GetSessionResp,
  type GetSessionStateReq,
  type IterationProgressEvt,
  type ListSessionsReq,
  type ListSessionsResp,
  type Message,
  type SessionDoneEvt,
  type SessionNoticeEvt,
  type SubagentEvt,
  type PlanUpdatedEvt,
  type ModeChangedEvt,
  type ExploreResultEvt,
  type SessionSummary,
  type ToolTrace,
  type ToolTraceEvt,
  type UserMessageReq,
  type WriteConfirmReq,
  type WriteConfirmResp,
  type HumanTakeoverReq,
  type HumanTakeoverResp,
  type PlanDecisionReq,
  type PlanDecisionResp,
  type GetMemoryReq,
  type SchedulesResp,
  type SaveScheduleReq,
  type DeleteScheduleReq,
  type RunScheduleNowReq,
  type RunScheduleNowResp,
  type AdapterBrokenEvt,
  type MemoryStateResp,
  type SetMemoryReq,
  type SetMemoryEnabledReq,
  type EditMemoryLlmReq,
  type EditMemoryLlmResp,
  type ListSiteScriptsReq,
  type ListSiteScriptsResp,
  type SetSiteScriptEnabledReq,
  type DeleteSiteScriptReq,
  type CreateSiteScriptReq,
  type SiteScriptMutResp,
  type ImportSiteScriptsReq,
  type ImportSiteScriptsResp,
  type ListNotesReq,
  type ListNotesResp,
  type AddNoteReq,
  type UpdateNoteReq,
  type DeleteNoteReq,
  type NoteMutResp,
  type ExploreRepairReq,
  type SetAdapterVerifyReq,
  type GetTraceReq,
  type GetTraceResp,
  type GetBridgeStatusReq,
  type GetBridgeStatusResp,
  type GetBridgeLogReq,
  type GetBridgeLogResp,
  type BridgeCall,
  type SetBridgeEnabledReq,
  type GetAllToolsReq,
  type GetAllToolsResp,
  type AdapterCommand,
  type ExploreAdapter,
  type ExploreAdapterEvt,
  type PageRef,
} from '../messages';
import type { SessionState, Turn } from '../agent/session';
import {
  installAdapterFromSource,
  getAdapterSource,
  registerSessionAdapter,
  type HealTarget,
} from './adapters-client';
import { isTerminal, type PlanState } from '../agent/plan';
import type { MemoryState } from '../agent/memory-store';
import type { SiteScript } from '@base/site-scripts/store';
import { renderMemoryExport } from '../agent/memory-store';
import {
  matchNotes,
  noteExcerpt,
  deriveNoteTitle,
  renderNotesExport,
  type Note,
} from '../agent/notes-store';
import { reconcileStaleAdapters } from './adapters-client';
import { makeSessionId } from '../agent/session';
import {
  loadSelSettings,
  saveSelSettings,
  normalizeBlacklistEntry,
  type SelToolbarSettings,
  type SelAction,
} from '@base/selection/settings';
import {
  listAllHighlights,
  removeHighlight,
  clearPageHighlights,
  type PageHighlights,
} from '@base/selection/highlights-store';
import {
  DEFAULT_CONFIG,
  PROVIDERS,
  CAPABILITIES,
  loadLlmConfig,
  resolveSlots,
  loadProfiles,
  upsertProfile,
  deleteProfile,
  setSlot,
  newProfileId,
  autoLabel,
  providerById,
  needsBaseUrl,
  type Capability,
  type LlmConfig,
  type LlmProfile,
  type LlmProfileStore,
} from '../config/llm-config';

interface ProgressState {
  iteration: number;
  phase: 'injecting' | 'awaiting' | 'streaming';
  textLen?: number;
}

/** A live parallel-subagent lane (parallel-execution v2). */
interface SubagentLane {
  id: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  digestChars?: number;
  durationMs?: number;
}

/** A session still RUNNING in the background (multi-session). The strip exists
 * only while such sessions exist — a finished one leaves the strip immediately
 * (the toast announces it; History has the result), so no-parallel means no
 * strip at all (avoid it when you can). Full turns are NOT mirrored — IDB has them
 * (every step is saved); switching reloads via GET_SESSION. */
interface BgSessionInfo {
  updatedAt: number;
}

/** Cap on concurrently RUNNING sessions — beyond this, tab-pool leases and LLM
 * quota churn make every session slower; the user can wait or stop one. */
const MAX_PARALLEL_SESSIONS = 3;

type View =
  | 'closed'
  | 'menu'
  | 'backend'
  | 'adapters'
  | 'shortcuts'
  | 'skills'
  | 'bridge'
  | 'secrets'
  | 'history'
  | 'memory'
  | 'notes'
  | 'schedules'
  | 'siteScripts'
  | 'seltoolbar';

const PAGE_LABELS: Record<Exclude<View, 'closed' | 'menu'>, string> = {
  backend: 'LLM config',
  adapters: 'Adapters',
  shortcuts: 'Workflows',
  skills: 'Skills',
  bridge: 'External access',
  secrets: 'Credentials & masking',
  history: 'History',
  memory: 'My memory',
  notes: 'My notes',
  schedules: 'Scheduled tasks',
  siteScripts: 'Site scripts',
  seltoolbar: 'Selection toolbar',
};

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const ACTIVITY_ICON: Record<ActivityIcon, (p: { size?: number }) => preact.JSX.Element> = {
  navigate: IconFlag,
  read: IconEye,
  search: IconSearch,
  camera: IconCamera,
  click: IconPointer,
  type: IconType,
  scroll: IconScroll,
  plan: IconList,
  subagent: IconBranch,
  memory: IconSave,
  image: IconImage,
  site: IconGlobe,
  action: IconDot,
};

type TurnKind = 'user' | 'system' | 'tool' | 'reasoning' | 'answer';

/** An assistant turn is "reasoning" (a timeline narration bullet) if a tool turn
 * follows it before the next user message; otherwise it's the "answer" bubble. */
function classifyTurn(turns: UiTurn[], i: number): TurnKind {
  const t = turns[i]!;
  if (t.role === 'user') return 'user';
  if (t.role === 'system') return 'system';
  if (t.role === 'tool') return 'tool';
  for (let j = i + 1; j < turns.length && turns[j]!.role !== 'user'; j++) {
    if (turns[j]!.role === 'tool') return 'reasoning';
  }
  return 'answer';
}

/** Whether tool activity preceded this turn in the current exchange — used to
 * place a "✓ Done" marker at the end of the timeline, just before the answer. */
function hadToolActivityBefore(turns: UiTurn[], i: number): boolean {
  for (let j = i - 1; j >= 0 && turns[j]!.role !== 'user'; j--) {
    if (turns[j]!.role === 'tool') return true;
  }
  return false;
}

/** Index of the LAST tool turn calling one of `tools` — the anchor where an
 * inline card re-homes into the flow: the settled plan checklist at the final
 * update_plan/submit_plan row, the Explore results card after the last
 * synthesize_adapter row. -1 = no anchor. (lib is ES2022 — no findLastIndex.) */
function lastToolTurnIndex(turns: UiTurn[], tools: ReadonlySet<string>): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role === 'tool' && t.trace.tool && tools.has(t.trace.tool)) return i;
  }
  return -1;
}
const PLAN_ANCHOR_TOOLS: ReadonlySet<string> = new Set(['update_plan', 'submit_plan']);
const EXPLORE_ANCHOR_TOOLS: ReadonlySet<string> = new Set(['synthesize_adapter']);

/** Tiny global toast — a transient confirmation (Copy / Save as note / Export). Provided at
 * the App root; fired from anywhere (deep buttons) via useContext(ToastContext). */
const ToastContext = createContext<(msg: string) => void>(() => {});

/** Multi-select state for an exportable list (memory / notes). Selection is by id, so
 * it survives search-filtering; the caller passes the currently-visible ids to
 * selectIds for Select all. */
function useSelection() {
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectIds(ids: string[]): void {
    setSelected(new Set(ids));
  }
  function clear(): void {
    setSelected(new Set());
  }
  function exit(): void {
    setSelMode(false);
    setSelected(new Set());
  }
  return { selMode, setSelMode, selected, toggle, selectIds, clear, exit };
}

/** Top action bar shown while picking rows to export. */
function ExportSelectBar(props: {
  total: number;
  selectedCount: number;
  onToggleAll: () => void;
  onExport: () => void;
  onCancel: () => void;
}): preact.JSX.Element {
  const allSel = props.total > 0 && props.selectedCount === props.total;
  return (
    <div class="export-bar">
      <button class="ghost-btn sm" onClick={props.onToggleAll}>
        {allSel ? 'Deselect all' : 'Select all'}
      </button>
      <span class="export-bar-count">
        {props.selectedCount}/{props.total} selected
      </span>
      <button class="btn primary sm" disabled={props.selectedCount === 0} onClick={props.onExport}>
        <IconDownload size={13} /> Export ({props.selectedCount})
      </button>
      <button class="btn outline sm" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function App() {
  const [turns, setTurns] = useState<UiTurn[]>([]);
  // `input` mirrors the contenteditable composer's SERIALIZED value (free text +
  // ⟦tool:..⟧ tokens for command chips). The editor DOM is the source of
  // truth; this mirror drives the send-enable / save-as-workflow checks.
  const [input, setInput] = useState('');
  // Imperative handle into the composer's CommandEditor (insert chips / clear).
  const composerApi = useRef<CommandEditorHandle | null>(null);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [, setProgress] = useState<ProgressState | null>(null);
  // Live parallel-subagent lanes (parallel-execution v2).
  const [lanes, setLanes] = useState<SubagentLane[]>([]);
  // Multi-session: interactive prompts are stored PER SESSION (write-confirm and
  // takeover are sent ONCE — dropping one for a non-current session would hang
  // that run to its 5-10min timeout §10.19). Only the current session's render;
  // others show a "waiting for input" badge on the session strip.
  const [pendingConfirms, setPendingConfirms] = useState<Map<string, WriteConfirmReq[]>>(
    () => new Map(),
  );
  const [pendingTakeovers, setPendingTakeovers] = useState<Map<string, HumanTakeoverReq>>(
    () => new Map(),
  );
  const [pendingPlans, setPendingPlans] = useState<Map<string, PlanDecisionReq>>(() => new Map());
  // Sessions running/finished in the background (not on screen). The SW keeps
  // driving them; we track status + unread from their broadcast events and
  // reload full turns from IDB on switch (no in-memory mirror of N streams).
  const [bgSessions, setBgSessions] = useState<Map<string, BgSessionInfo>>(() => new Map());
  // id → first-user-turn preview for the session strip labels (LIST_SESSIONS).
  const [sessionMeta, setSessionMeta] = useState<Map<string, string>>(() => new Map());
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [mode, setMode] = useState<'chat' | 'plan' | 'explore'>('chat');
  // Auto mode (per-conversation): skip the per-write confirm dialog. Off by
  // default; reset when a new conversation starts.
  const [autoMode, setAutoMode] = useState(false);
  // Explore v2: the persistent Explore-results card accumulates one row per synthesized
  // adapter (keyed by id), streaming status in. Survives across turns within an
  // explore session; toggle-able like the plan card.
  const [exploreAdapters, setExploreAdapters] = useState<ExploreAdapter[]>([]);
  // The drifted adapter the current run is healing (H1-P2), so the explore-card
  // install overwrites it IN PLACE instead of making a parallel `my-` copy.
  const [healTarget, setHealTarget] = useState<HealTarget | null>(null);
  // H1-P2c: the SW broadcasts when an installed adapter drifts into broken;
  // surface a proactive heal prompt (deduped by id; cleared on heal / dismiss).
  const [brokenAlerts, setBrokenAlerts] = useState<Map<string, AdapterBrokenEvt>>(() => new Map());
  // H3: finished scheduled-run notices — top banner rows, loaded at mount and
  // kept live via storage.onChanged; click = open the run's session + dismiss
  // (persisted, so it never shows again).
  const [schedNotices, setSchedNotices] = useState<ScheduleNotice[]>([]);
  const [exploreOpen, setExploreOpen] = useState(true);
  const [planOpen, setPlanOpen] = useState(true);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [runStats, setRunStats] = useState<{
    step: number;
    promptTokens: number;
    completionTokens: number;
  } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [adapterUpdateNote, setAdapterUpdateNote] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 1600);
  }, []);
  // Clear a pending toast timer on unmount (avoid a setState-after-unmount).
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    const onMsg = (m: unknown): void => {
      if ((m as { type?: string })?.type === 'ADAPTER_BROKEN') {
        const evt = m as AdapterBrokenEvt;
        setBrokenAlerts((cur) => {
          const next = new Map(cur);
          next.set(evt.id, evt);
          return next;
        });
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  // Header menu state machine. 'closed' = no overlay; 'menu' = dropdown
  // showing; any other value = a settings page is open. Click outside the
  // menu/page region drops back to 'closed'.
  const [view, setView] = useState<View>('closed');
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  // Skills (single-file markdown skills): loaded once, kept in sync via
  // storage.onChanged so the `/` palette reflects edits from the Skills page.
  const [skills, setSkills] = useState<Skill[]>([]);
  // Full tool catalog (adapter + generic, with arg schemas) — for the `/` palette
  // insertable-tools group (⟦tool:..⟧).
  const toolCatalogRef = useRef<Map<string, AdapterCommand>>(new Map());
  // The full marketplace catalog (metadata only) so `/` can reference ANY adapter
  // even before it's loaded (merged with the registry via mergeToolCatalog).
  const marketAdaptersRef = useRef<MarketAdapter[]>([]);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  // Plain-text file attachments: read inline at attach time (no remote store),
  // sent as a context block, viewable in-app. See docs/architecture.md §13/§14.
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; content: string }[]>([]);
  const [fileViewer, setFileViewer] = useState<{ name: string; content: string } | null>(null);
  // Whether the active config has a vision model assigned — gates image upload.
  const [hasVision, setHasVision] = useState(false);
  // Transient composer notice (e.g. "no vision model" / "file too large").
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  // 🌐 page-action menu (Summarize this page / Chat with page): null = closed; open carries the
  // user's active tab captured AT OPEN TIME (tabId locked here, not re-resolved
  // by the agent later — a tab switch mid-run must not retarget the request).
  const [pageMenu, setPageMenu] = useState<{ tab: PageRef | null } | null>(null);
  // Chat with page: an explicit MODE (entered from the 🌐 menu, exited only via the
  // row's ✕ — removing every chip keeps the mode on so the user can swap tabs).
  // Pinned pages render as chips above the input; the FIRST send of a given set
  // embeds a read-instruction block (+ quote cards); follow-ups ride on history.
  // While in the mode, sending requires ≥1 pinned tab AND non-empty text.
  const [pageChatMode, setPageChatMode] = useState(false);
  const [chatPages, setChatPages] = useState<PageRef[]>([]);
  const [tabPicker, setTabPicker] = useState<PageRef[] | null>(null); // null = closed; open holds all pickable tabs
  // Key of the pinned set the running conversation has already been told about
  // ('' = none). Reset with the conversation (New chat / load another session).
  const sentPagesKey = useRef('');
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG);
  // When opened as a full browser tab (?fullpage), widen the layout and hide the
  // page-context actions (the "current page" would be this extension tab itself).
  const [isFullPage] = useState(() => new URLSearchParams(location.search).has('fullpage'));

  const messagesRef = useRef<HTMLDivElement>(null);
  // Mirror of `sessionId` for the chrome.runtime.onMessage listener (which
  // is registered once in useEffect and would otherwise capture a stale
  // closure). Updated by the effect just below.
  const sessionIdRef = useRef<string | null>(null);
  // Plan decisions the user already answered — ignore late re-sends (§10.19) so
  // a resolved card can't pop back up.
  const handledPlanDecisions = useRef<Set<string>>(new Set());
  // Prompt ids already seen — dedupes the plan card's 3s re-sends so the
  // "a background session is waiting for you" toast fires once per prompt, not every re-send.
  const seenPromptIds = useRef<Set<string>>(new Set());
  // viewRef so the once-registered message listeners read the latest view
  // without re-subscribing (they only ever need the current view, never to
  // re-run on change). §10.21
  const viewRef = useRef<View>('closed');
  // Keep the latest runShortcut for the mount-time message listener (avoids a
  // stale closure over running/mode/apiReady).
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Workflows (prompt recipes, stored as shortcuts): load once, then stay in sync via
  // storage.onChanged so the quick-run bar reflects edits from the Workflows page.
  useEffect(() => {
    void listShortcuts().then(setShortcuts);
    void listSkills().then(setSkills);
    // Full tool catalog (adapter + generic, with arg schemas) for the `/` palette.
    void (async () => {
      const r = (await chrome.runtime.sendMessage({
        type: 'GET_ALL_TOOLS',
      } satisfies GetAllToolsReq)) as GetAllToolsResp | undefined;
      toolCatalogRef.current = new Map((r?.commands ?? []).map((c) => [c.tool, c]));
    })().catch(() => {});
    // Marketplace catalog (cache-first → instant when warm) so `/` can reference
    // any adapter, not just loaded ones.
    void fetchMarketIndex()
      .then((idx) => {
        marketAdaptersRef.current = idx.adapters;
      })
      .catch(() => {});
    const onChg = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'local') return;
      if (changes.shortcuts) setShortcuts((changes.shortcuts.newValue as Shortcut[]) ?? []);
      if (changes.skills) setSkills((changes.skills.newValue as Skill[]) ?? []);
      // Keep the `/` palette's marketplace catalog in sync with the cache: the
      // Adapters page's "Refresh catalog" (forceFresh) — and the 6h background refresh —
      // write this key, so the palette reflects newly-published adapters without
      // reopening the panel. Value is `{ index, ts }` (tolerate a legacy raw index).
      if (changes.marketIndexCache) {
        const v = changes.marketIndexCache.newValue as
          | { index?: MarketIndex }
          | MarketIndex
          | undefined;
        const idx = (v as { index?: MarketIndex })?.index ?? (v as MarketIndex | undefined);
        if (idx && Array.isArray(idx.adapters)) marketAdaptersRef.current = idx.adapters;
      }
    };
    chrome.storage.onChanged.addListener(onChg);
    return () => chrome.storage.onChanged.removeListener(onChg);
  }, []);

  /** The `/` palette's insertable tools: generic + loaded/synthesized (registry)
   * merged with every marketplace adapter, so any adapter is referenceable. */
  const getPaletteTools = (): AdapterCommand[] =>
    mergeToolCatalog([...toolCatalogRef.current.values()], marketAdaptersRef.current);

  function toggleTheme(): void {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('theme-light', next === 'light');
      chrome.storage?.local?.set({ theme: next }).catch(() => {});
      return next;
    });
  }

  /* Load saved theme on mount. */
  useEffect(() => {
    void (async () => {
      try {
        const got = await chrome.storage?.local?.get('theme');
        const saved = got?.theme as string | undefined;
        const t = saved === 'light' ? 'light' : 'dark';
        setTheme(t);
        document.documentElement.classList.toggle('theme-light', t === 'light');
      } catch { /* use default dark */ }
    })();
  }, []);

  /* Full-page tab (?fullpage / ?session): widen the layout and load the named
   * session so "Open in new tab" lands on the same conversation, roomier. */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.has('fullpage')) document.documentElement.classList.add('fullpage');
    const sid = params.get('session');
    if (!sid) return;
    void switchToSession(sid);
  }, []);

  /** Open the current conversation (or a fresh one) in a roomy full browser tab —
   * the side panel is narrow. Same app + SW, so the chat stays live in both. */
  function openInTab(): void {
    const params = new URLSearchParams({ fullpage: '1' });
    if (sessionId) params.set('session', sessionId);
    const url = `${chrome.runtime.getURL('src/sidepanel/index.html')}?${params.toString()}`;
    void chrome.tabs.create({ url });
  }

  /* On open, restore the most recent conversation so the panel comes back to
   * where you left off (and seed lastSessionId for the welcome-card link).
   *
   * Skip the auto-open when another path already owns which session to show:
   *   - a ?session= param (the effect above restores that specific one), or
   *   - a ?fullpage tab with no session (an explicit "new chat in a tab"), or
   *   - the user already started a chat before this resolved (ref non-null).
   * The header's New chat (+) button is always there to start fresh. */
  useEffect(() => {
    void (async () => {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'LIST_SESSIONS',
        } satisfies ListSessionsReq)) as ListSessionsResp | undefined;
        const list = r?.sessions ?? [];
        if (list.length === 0) return;
        const latest = list[0]!.id;
        setLastSessionId(latest);
        const params = new URLSearchParams(location.search);
        const paramDriven = params.has('session') || params.has('fullpage');
        if (!paramDriven && sessionIdRef.current === null) {
          await switchToSession(latest);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  /* Multi-session: on open, discover sessions ALREADY running in the SW (panel
   * was closed / bridge / schedule drove them) so the strip shows them. */
  useEffect(() => {
    void (async () => {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'GET_SESSION_STATE',
        } satisfies GetSessionStateReq)) as { activeSessionIds?: string[] } | undefined;
        const ids = (r?.activeSessionIds ?? []).filter((id) => id !== sessionIdRef.current);
        if (!ids.length) return;
        setBgSessions((cur) => {
          const next = new Map(cur);
          for (const id of ids) {
            if (!next.has(id)) next.set(id, { updatedAt: Date.now() });
          }
          return next;
        });
      } catch { /* ignore */ }
    })();
  }, []);

  /* Session-strip labels + ghost reconcile share this signature. */
  const bgKeySig = [...bgSessions.keys()].sort().join(',');

  /* Reconcile ghost entries: a SW death mid-run never broadcasts SESSION_DONE,
   * which would pin a pill on the strip forever. While any entry exists, poll
   * the truthful activeSessions set slowly and drop the ones that are gone. */
  useEffect(() => {
    if (!bgKeySig) return;
    const t = setInterval(() => {
      void (async () => {
        try {
          const r = (await chrome.runtime.sendMessage({
            type: 'GET_SESSION_STATE',
          } satisfies GetSessionStateReq)) as { activeSessionIds?: string[] } | undefined;
          const active = new Set(r?.activeSessionIds ?? []);
          setBgSessions((cur) => {
            let changed = false;
            const next = new Map(cur);
            for (const id of [...next.keys()]) {
              if (!active.has(id)) {
                next.delete(id);
                changed = true;
              }
            }
            return changed ? next : cur;
          });
        } catch { /* ignore */ }
      })();
    }, 10_000);
    return () => clearInterval(t);
  }, [bgKeySig]);
  useEffect(() => {
    if (!bgKeySig) return;
    void (async () => {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'LIST_SESSIONS',
        } satisfies ListSessionsReq)) as ListSessionsResp | undefined;
        setSessionMeta(
          new Map((r?.sessions ?? []).map((s) => [s.id, tokensToDisplay(s.preview ?? '')])),
        );
      } catch { /* ignore */ }
    })();
  }, [bgKeySig]);

  async function resumeLastSession(): Promise<void> {
    if (!lastSessionId) return;
    await switchToSession(lastSessionId);
  }

  function eventBelongsToCurrentSession(eventSessionId: string | undefined): boolean {
    if (!eventSessionId) return true; // global event (no session scope)
    return sessionIdRef.current === eventSessionId;
  }

  /* mount: attach listeners, open keep-alive port */
  useEffect(() => {
    const handler = (m: unknown) => onIncomingMessage(m as Message);
    chrome.runtime.onMessage.addListener(handler);
    // Pin the SW alive while the SidePanel is open. MV3 SWs are killed
    // after ~30s of no chrome.* activity, which would otherwise orphan a
    // long-running iteration (LLM thinking phases >30s with no chrome.*
    // activity → SW recycle → activeSessions vanish → the next
    // ASSISTANT_TURN arriving after wake-up is silently dropped). An open
    // chrome.runtime.Port keeps the SW pinned per MV3 spec. SW dies on
    // disconnect (panel close) — that's fine, the user isn't watching.
    // The SW still recycles after a while (an idle port doesn't reliably pin it —
    // see runtime-state.ts); when it does, the port disconnects and the new SW's
    // keepaliveConnections Set is empty on wake, so it wrongly treats the panel as
    // CLOSED — spurious "task done" desktop notification, and bridge
    // await_user_action refuses with "side panel not open". RECONNECT on disconnect so a fresh
    // SW re-learns the panel is open. See §10.33.
    let port: chrome.runtime.Port | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const openKeepalive = () => {
      if (disposed) return;
      try {
        port = chrome.runtime.connect({ name: 'web-keepalive' });
        port.onDisconnect.addListener(() => {
          port = null;
          if (disposed) return;
          reconnectTimer = setTimeout(openKeepalive, 250); // re-pin the (fresh) SW
        });
      } catch {
        if (!disposed) reconnectTimer = setTimeout(openKeepalive, 1000);
      }
    };
    openKeepalive();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      chrome.runtime.onMessage.removeListener(handler);
      try {
        port?.disconnect();
      } catch {}
    };
  }, []);

  /* load LLM config */
  useEffect(() => {
    void loadLlmConfig().then(setLlmConfig);
  }, []);

  /* Selection toolbar "Ask": consume the quote the SW parked in storage.session
   * (set while opening this panel) into the composer — checked on mount (the
   * panel may have been OPENED by the ask; the message would have raced a
   * not-yet-listening panel) and watched for later asks while open. */
  useEffect(() => {
    const consume = (v: unknown): void => {
      const p = v as { text?: string; title?: string; url?: string } | undefined;
      if (!p?.text) return;
      void chrome.storage.session?.remove('pendingSelectionAsk').catch(() => {});
      const src = p.url ? `\n(from "${p.title || hostOf(p.url)}" ${p.url})` : '';
      composerApi.current?.insertTextWithTokens(`About the following selection:\n"${p.text}"${src}\n\n`);
      composerApi.current?.focus();
    };
    void chrome.storage.session
      ?.get('pendingSelectionAsk')
      .then((got) => consume(got?.pendingSelectionAsk))
      .catch(() => {});
    const on = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'session' || !changes.pendingSelectionAsk?.newValue) return;
      consume(changes.pendingSelectionAsk.newValue);
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);

  /* Track whether a vision model is assigned (gates image upload). Re-check when
   * the LLM config changes — the backend page edits it via setLlmConfig. */
  useEffect(() => {
    let alive = true;
    void resolveSlots().then((s) => {
      if (alive) setHasVision(s.vision != null);
    });
    return () => {
      alive = false;
    };
  }, [llmConfig]);

  /* T7 P5: poll the external-control bridge so the header shows when an external
   * agent can drive the browser (visibility + one-click kill switch). */
  useEffect(() => {
    const tick = async (): Promise<void> => {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'GET_BRIDGE_STATUS',
        } satisfies GetBridgeStatusReq)) as GetBridgeStatusResp | undefined;
        setBridgeConnected(!!r?.connected);
      } catch {
        setBridgeConnected(false);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 4000);
    return () => clearInterval(t);
  }, []);

  /* On open AND periodically while open: silently re-install any installed
   * marketplace adapter whose source drifted from the remote catalog (sha256
   * mismatch) so the user always runs the latest fix without a manual
   * uninstall/reinstall. The periodic re-check is what catches a version pushed
   * WHILE the panel stays open — mount-only would miss it (e.g. a fix landing
   * mid-session). A brief toast reports what was updated. */
  useEffect(() => {
    const RECONCILE_INTERVAL_MS = 3 * 60_000;
    const run = (): void => {
      void reconcileStaleAdapters().then((updated) => {
        if (updated.length === 0) return;
        setAdapterUpdateNote(`Auto-updated ${updated.length} marketplace adapter(s): ${updated.join(', ')}`);
        setTimeout(() => setAdapterUpdateNote(null), 8000);
      });
    };
    run(); // on open
    const t = setInterval(() => {
      // Skip while the panel is hidden — no point polling the catalog unseen.
      if (typeof document !== 'undefined' && document.hidden) return;
      run();
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  /* Scheduled-run notices: load at mount; storage.onChanged keeps them live
   * (a schedule can finish while the panel is open). */
  useEffect(() => {
    void listScheduleNotices().then(setSchedNotices);
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local' || !(SCHEDULE_NOTICES_KEY in changes)) return;
      const next = changes[SCHEDULE_NOTICES_KEY]?.newValue;
      setSchedNotices(Array.isArray(next) ? (next as ScheduleNotice[]) : []);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  /* autoscroll on new turn */
  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [turns.length]);

  /* close menu dropdown on outside click. (Page overlay closes via its own
   * backdrop click — different model since the page is full-surface.) The
   * menu lives inside .menu-anchor; any click outside that subtree closes.
   * Listener attaches on next tick so the click that opened the menu doesn't
   * immediately re-close it. */
  useEffect(() => {
    if (view !== 'menu') return;
    function onDocClick(e: MouseEvent): void {
      const t = e.target as Element | null;
      if (t?.closest('.menu-anchor')) return;
      setView('closed');
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [view]);

  function onIncomingMessage(m: Message): void {
    if (!m || typeof m !== 'object') return;
    const sid = (m as { sessionId?: string }).sessionId;
    switch (m.type) {
      // Interactive prompts are ALWAYS stored, keyed by session — write-confirm
      // and takeover are sent ONCE (only plan re-sends §10.19); dropping one for
      // a backgrounded session would hang that run to its 5-10min timeout. The
      // session strip shows "waiting for input"; switching to the session renders the card.
      case 'WRITE_CONFIRM_REQ':
        onWriteConfirmReq(m as WriteConfirmReq);
        return;
      case 'HUMAN_TAKEOVER_REQ':
        onTakeoverReq(m as HumanTakeoverReq);
        return;
      case 'PLAN_DECISION_REQ':
        onPlanDecisionReq(m as PlanDecisionReq);
        return;
      // Session-scoped stream events: current session renders them; any other
      // session folds into the background tracker (status/unread only — turns
      // are reloaded from IDB on switch, not mirrored live).
      case 'ASSISTANT_TURN':
      case 'ASSISTANT_TURN_PATCH':
      case 'RUN_STATS':
      case 'TOOL_TRACE':
      case 'SESSION_DONE':
      case 'SESSION_NOTICE':
      case 'ITERATION_PROGRESS':
      case 'PLAN_UPDATED':
      case 'MODE_CHANGED':
      case 'EXPLORE_RESULT':
      case 'EXPLORE_ADAPTER':
      case 'SUBAGENT_EVT':
        if (!eventBelongsToCurrentSession(sid)) {
          if (sid) trackBackgroundEvent(m, sid);
          return;
        }
        break;
      // NOTE (③a × multi-session): takeover stays effectively un-gated — it's
      // stored per session above, but the card RENDERS for the current session
      // OR, failing that, for ANY session (incl. a bridge-driven run's
      // sessionId 'bridge', which never matches the panel's chat). A takeover
      // hard-blocks its run for up to 5min; hiding it behind a strip badge
      // would hang bridge runs silently. See `displayedTakeover`.
      default:
        break;
    }
    switch (m.type) {
      case 'ASSISTANT_TURN':
        onAssistantTurn(m as AssistantTurnEvt);
        break;
      case 'ASSISTANT_TURN_PATCH':
        setStreaming((m as AssistantTurnPatchEvt).text);
        break;
      case 'RUN_STATS': {
        const s = m as RunStatsEvt;
        setRunStats({
          step: s.step,
          promptTokens: s.promptTokens,
          completionTokens: s.completionTokens,
        });
        break;
      }
      case 'TOOL_TRACE':
        onToolTrace(m as ToolTraceEvt);
        break;
      case 'SESSION_DONE':
        onSessionDone(m as SessionDoneEvt);
        break;
      case 'SESSION_NOTICE':
        onSessionNotice(m as SessionNoticeEvt);
        break;
      case 'ITERATION_PROGRESS':
        onIterationProgress(m as IterationProgressEvt);
        break;
      case 'SUBAGENT_EVT':
        onSubagentEvt(m as SubagentEvt);
        break;
      case 'PLAN_UPDATED':
        setPlan((m as PlanUpdatedEvt).plan);
        break;
      case 'MODE_CHANGED':
        // Mid-run chat→explore upgrade (enter_explore_mode, user-confirmed):
        // sync the composer badge so follow-up turns stay in explore mode.
        setMode((m as ModeChangedEvt).mode);
        break;
      case 'EXPLORE_RESULT': {
        // Import / post-loop backstop / card-repair: one terminal result →
        // fold into the same persistent card as one adapter row.
        const r = m as ExploreResultEvt;
        setExploreAdapters((list) =>
          mergeAdapter(list, {
            id: r.traceId,
            traceId: r.traceId,
            site: r.site,
            name: r.name,
            tool: r.site && r.name ? `${r.site}__${r.name}` : undefined,
            status: r.ok ? 'untested' : 'failed',
            source: r.source,
            summary: r.summary,
            testArgs: r.testArgs,
            error: r.error,
            ts: Date.now(),
          }),
        );
        setExploreOpen(true);
        break;
      }
      case 'EXPLORE_ADAPTER': {
        setExploreAdapters((list) => mergeAdapter(list, (m as ExploreAdapterEvt).adapter));
        setExploreOpen(true);
        break;
      }
      // (EXPLORE_EVAL_REQ removed §27.3 — adapter source now evals in the
      // offscreen document, not the panel.)
      default:
        break;
    }
  }

  /** Fold a background session's event into its strip entry. Stream events fire
   * constantly (token patches) — skip the state update when nothing changes. */
  function trackBackgroundEvent(m: Message, sid: string): void {
    if (m.type === 'SESSION_DONE') {
      const done = m as SessionDoneEvt;
      // The run is over — the SW resolved/aborted its parked prompts with it,
      // and the parallel situation involving this session ended: drop its pill
      // (avoid it when you can). The toast announces it; History has the result.
      clearSessionPendings(sid);
      setBgSessions((cur) => (cur.has(sid) ? mapWithout(cur, sid) : cur));
      showToast(
        done.reason === 'error'
          ? 'A background session hit an error (see History)'
          : done.reason === 'user_abort'
            ? 'A background session was stopped'
            : done.reason === 'checkpoint'
              ? 'A background session was paused (resume from History)'
              : 'A background session finished (see History)',
      );
      return;
    }
    // Any other session-scoped event ⇒ that session is actively running.
    setBgSessions((cur) => {
      if (cur.has(sid)) return cur; // steady state → no re-render
      const next = new Map(cur);
      next.set(sid, { updatedAt: Date.now() });
      return next;
    });
  }

  function clearSessionPendings(sid: string): void {
    setPendingConfirms((cur) => (cur.has(sid) ? mapWithout(cur, sid) : cur));
    setPendingTakeovers((cur) => (cur.has(sid) ? mapWithout(cur, sid) : cur));
    setPendingPlans((cur) => (cur.has(sid) ? mapWithout(cur, sid) : cur));
  }

  function onSessionNotice(m: SessionNoticeEvt): void {
    setTurns((cur) => [
      ...cur,
      {
        role: 'system',
        text: m.text,
        level: m.level === 'error' ? 'error' : 'info',
        ts: Date.now(),
      },
    ]);
  }

  function onIterationProgress(m: IterationProgressEvt): void {
    if (m.phase === 'completed') {
      setProgress(null);
    } else if (m.phase === 'injecting' || m.phase === 'awaiting') {
      setProgress({ iteration: m.iteration, phase: m.phase });
    } else if (m.phase === 'streaming') {
      setProgress({ iteration: -1, phase: 'streaming', textLen: m.textLen });
    }
  }

  /** Parallel-subagent lanes (v2). A fresh fan-out (a `start` arriving after all
   * current lanes settled) resets the batch so cross-turn lanes don't pile up. */
  function onSubagentEvt(m: SubagentEvt): void {
    setLanes((cur) => {
      if (m.phase === 'start') {
        const allSettled = cur.length > 0 && cur.every((l) => l.status !== 'running');
        const base = allSettled ? [] : cur;
        if (base.some((l) => l.id === m.id)) return base;
        return [...base, { id: m.id, task: m.task, status: 'running' }];
      }
      const status: SubagentLane['status'] = m.ok ? 'done' : 'failed';
      const i = cur.findIndex((l) => l.id === m.id);
      if (i === -1) {
        return [
          ...cur,
          { id: m.id, task: m.task, status, digestChars: m.digestChars, durationMs: m.durationMs },
        ];
      }
      const next = cur.slice();
      next[i] = { ...next[i], status, digestChars: m.digestChars, durationMs: m.durationMs };
      return next;
    });
  }

  /** First sighting of an interactive prompt for a BACKGROUNDED session → tell
   * the user now (the strip badge persists; this catches their attention). */
  function noteBgPrompt(sid: string, promptId: string): void {
    if (seenPromptIds.current.has(promptId)) return;
    seenPromptIds.current.add(promptId);
    if (sid !== sessionIdRef.current) showToast('A background session is waiting for you — tap the session bar above to switch to it');
  }

  function onWriteConfirmReq(m: WriteConfirmReq): void {
    noteBgPrompt(m.sessionId, m.confirmId);
    setPendingConfirms((cur) => {
      const q = cur.get(m.sessionId) ?? [];
      if (q.some((c) => c.confirmId === m.confirmId)) return cur; // re-send dedupe
      const next = new Map(cur);
      next.set(m.sessionId, [...q, m]);
      return next;
    });
  }

  function onTakeoverReq(m: HumanTakeoverReq): void {
    // No bg toast: the takeover card renders globally (displayedTakeover, ③a)
    // — it's already in the user's face, unlike confirm/plan cards.
    setPendingTakeovers((cur) => {
      if (cur.get(m.sessionId)?.takeoverId === m.takeoverId) return cur;
      const next = new Map(cur);
      next.set(m.sessionId, m);
      return next;
    });
  }

  function onPlanDecisionReq(m: PlanDecisionReq): void {
    // Dedup the SW's re-sends (§10.19): ignore one already decided, and keep
    // the current card (don't reset in-progress edits) on a repeat.
    if (handledPlanDecisions.current.has(m.decisionId)) return;
    noteBgPrompt(m.sessionId, m.decisionId);
    setPendingPlans((cur) => {
      if (cur.get(m.sessionId)?.decisionId === m.decisionId) return cur;
      const next = new Map(cur);
      next.set(m.sessionId, m);
      return next;
    });
  }

  function onDecideWrite(approved: boolean): void {
    const sid = sessionId;
    if (!sid) return;
    setPendingConfirms((cur) => {
      const [first, ...rest] = cur.get(sid) ?? [];
      if (!first) return cur;
      const resp: WriteConfirmResp = {
        type: 'WRITE_CONFIRM_RESP',
        confirmId: first.confirmId,
        approved,
      };
      chrome.runtime.sendMessage(resp).catch(() => {});
      const next = new Map(cur);
      if (rest.length) next.set(sid, rest);
      else next.delete(sid);
      return next;
    });
  }

  /** Decide the DISPLAYED takeover — which may belong to a session other than
   * the one on screen (③a: bridge runs use sessionId 'bridge'; a takeover
   * hard-blocks its run, so the card renders regardless of the viewed chat). */
  function onDecideTakeover(t: HumanTakeoverReq, resume: boolean): void {
    const resp: HumanTakeoverResp = {
      type: 'HUMAN_TAKEOVER_RESP',
      takeoverId: t.takeoverId,
      resume,
    };
    chrome.runtime.sendMessage(resp).catch(() => {});
    setPendingTakeovers((cur) =>
      cur.get(t.sessionId)?.takeoverId === t.takeoverId ? mapWithout(cur, t.sessionId) : cur,
    );
  }

  function onDecidePlan(decision: 'approve' | 'reject', editedSteps?: string[]): void {
    const sid = sessionId;
    if (!sid) return;
    setPendingPlans((cur) => {
      const p = cur.get(sid);
      if (!p) return cur;
      handledPlanDecisions.current.add(p.decisionId);
      const resp: PlanDecisionResp = {
        type: 'PLAN_DECISION_RESP',
        decisionId: p.decisionId,
        decision,
        editedSteps,
      };
      chrome.runtime.sendMessage(resp).catch(() => {});
      return mapWithout(cur, sid);
    });
  }

  function onAssistantTurn(m: AssistantTurnEvt): void {
    setStreaming(null); // the finalized turn replaces the streaming bubble
    setTurns((cur) => {
      // Switch-race dedupe: the engine emits BEFORE saveSession, so a turn just
      // loaded from IDB during a session switch can arrive again as its live
      // event. Tool traces dedupe by id; assistant turns need this check.
      const recent = cur.slice(-6);
      if (
        recent.some(
          (t) => t.role === 'assistant' && t.iteration === m.iteration && t.text === m.cleanedText,
        )
      ) {
        return cur;
      }
      return [
        ...cur,
        {
          role: 'assistant',
          text: m.cleanedText,
          rawText: m.rawText,
          reasoningText: m.reasoningText,
          commands: m.commands,
          iteration: m.iteration,
          ts: Date.now(),
        },
      ];
    });
  }

  function onToolTrace(m: ToolTraceEvt): void {
    setTurns((cur) => {
      const idx = cur.findIndex((t) => t.role === 'tool' && t.trace.id === m.trace.id);
      const next: UiTurn = { role: 'tool', trace: m.trace, ts: Date.now() };
      if (idx >= 0) {
        const copy = cur.slice();
        copy[idx] = next;
        return copy;
      }
      return [...cur, next];
    });
  }

  function onSessionDone(m: SessionDoneEvt): void {
    setRunning(false);
    setProgress(null);
    setStreaming(null);
    setRunStats(null);
    setLanes([]);
    // The run is over — its parked prompts were resolved/aborted with it.
    clearSessionPendings(m.sessionId);
    // Keep the sessionId binding across ALL end reasons — no_more_commands /
    // user_abort / checkpoint / error alike. The history is persisted in IDB, so
    // the user can just type again to CONTINUE the same session with full
    // context. (Previously a hard error dropped the binding and silently started
    // a fresh session — that's what looked like "resuming treated it as a new session".) The SW
    // takes over any stale active run on the next message, so this is safe. §10.20
    // A checkpoint already surfaced an explanatory SESSION_NOTICE inline, and
    // the session stays resumable ("continue"), so don't append a redundant system
    // line — just stop the spinner (handled above) and keep the binding.
    if (m.reason === 'checkpoint') return;
    const text =
      m.reason === 'user_abort'
        ? 'Stopped'
        : m.error
          ? `Session ended: ${m.error}`
          : m.reason === 'no_more_commands'
            ? 'answer complete'
            : `Session ended (${m.reason})`;
    setTurns((cur) => [
      ...cur,
      {
        role: 'system',
        text,
        level: m.reason === 'error' ? 'error' : 'info',
        ts: Date.now(),
      },
    ]);
  }

  /** Start a fresh turn with explicit text + mode (used by onSend and by
   * quick-actions like Summarize current page). Assumes no run is in progress. */
  function startRun(
    text: string,
    runMode: typeof mode,
    images?: string[],
    opts?: { displayText?: string; pageRefs?: PageRef[]; healTarget?: HealTarget | null },
  ): void {
    // Concurrency cap: this new run + sessions already running in background.
    // Every tracked bg session is by definition still running (done ones leave).
    const runningBg = bgSessions.size;
    if (runningBg >= MAX_PARALLEL_SESSIONS) {
      showToast(`${runningBg} session(s) already running in the background (max ${MAX_PARALLEL_SESSIONS}) — wait for one to finish or stop it first`);
      return;
    }
    setHealTarget(opts?.healTarget ?? null);
    // Reuse sessionId across follow-up messages so the SW can continue in
    // the same chat history. Only allocate a new one if we're starting fresh
    // (no prior session) or the previous one ended.
    const sid = sessionId ?? makeSessionId();
    setSessionId(sid);
    setRunning(true);
    composerApi.current?.clear();
    if (images?.length) setAttachedImages([]);
    setProgress({ iteration: 0, phase: 'injecting' });
    // The Explore-results card persists across turns: a follow-up in explore mode RESUMES
    // the same trace (E4), so its adapters stay relevant. Only New session / Clear card
    // reset it. Just make sure it's expanded when an explore turn starts.
    if (runMode === 'explore') setExploreOpen(true);
    setTurns((cur) => [
      ...cur,
      {
        role: 'user',
        text: opts?.displayText ?? (images?.length ? `${text} 📷×${images.length}`.trim() : text),
        ...(opts?.pageRefs?.length ? { pageRefs: opts.pageRefs } : {}),
        ts: Date.now(),
      },
    ]);
    const req: UserMessageReq = {
      type: 'USER_MESSAGE',
      sessionId: sid,
      text,
      mode: runMode,
      ...(opts?.displayText ? { displayText: opts.displayText } : {}),
      ...(opts?.pageRefs?.length ? { pageRefs: opts.pageRefs } : {}),
      ...(images?.length ? { images } : {}),
      ...(autoMode ? { autoApprove: true } : {}),
      // Heal semantics ride to the SW: the auto-persist after a passing
      // synthesis must overwrite the ORIGINAL adapter, not add a `my-` copy.
      ...(opts?.healTarget ? { healTarget: opts.healTarget } : {}),
    };
    // Fire-and-forget: SW early-acks. All further progress arrives via
    // events (ITERATION_PROGRESS / ASSISTANT_TURN / SESSION_DONE / ...).
    chrome.runtime.sendMessage(req).catch((e) => {
      setRunning(false);
      setSessionId(null);
      setProgress(null);
      setTurns((cur) => [
        ...cur,
        {
          role: 'system',
          text: `Send failed: ${e instanceof Error ? e.message : String(e)}`,
          level: 'error',
          ts: Date.now(),
        },
      ]);
    });
  }

  function dismissAlert(id: string): void {
    setBrokenAlerts((cur) => {
      const next = new Map(cur);
      next.delete(id);
      return next;
    });
  }

  // Heal from the proactive broken-adapter banner (H1-P2c): same seeded explore
  // run as the Adapters-page Repair button, just sourced from the alert.
  async function healFromAlert(evt: AdapterBrokenEvt): Promise<void> {
    dismissAlert(evt.id);
    if (running) {
      showToast('Finish the current task before repairing');
      return;
    }
    const src = await getAdapterSource(evt.id);
    if (!src) {
      showToast('Cannot find this tool\'s source — nothing to repair');
      return;
    }
    const { task, label } = buildHealTask(evt.id, src, evt.error);
    const slash = evt.id.indexOf('/');
    startRun(task, 'explore', undefined, {
      displayText: label,
      healTarget: {
        id: evt.id,
        site: slash < 0 ? evt.id : evt.id.slice(0, slash),
        name: slash < 0 ? evt.id : evt.id.slice(slash + 1),
        origin: evt.origin,
      },
    });
  }

  // Report a broken MARKET adapter to the marketplace repo (pre-filled GitHub
  // issue) — community contribution (H1). No source, just the error + context.
  function reportFromAlert(evt: AdapterBrokenEvt): void {
    const r = buildAdapterReport({
      id: evt.id,
      tool: evt.tool,
      error: evt.error,
      version: chrome.runtime.getManifest().version,
    });
    void chrome.tabs.create({ url: r.url, active: true });
  }

  async function onSend(): Promise<void> {
    const text = input.trim();
    if (!text && attachedImages.length === 0 && attachedFiles.length === 0) return;
    if (running) {
      // Steer: inject into the running session instead of starting a new turn.
      // (Image attachments only attach to a fresh turn, not a mid-run steer.)
      if (!sessionId || !text) return;
      // Expand ⟦cmd:..⟧ chips to their canned prompt for the agent; show the
      // compact /name form in the bubble.
      const req: SteerMessageReq = {
        type: 'STEER_MESSAGE',
        sessionId,
        text: expandCommandTokens(text),
      };
      void chrome.runtime.sendMessage(req).catch(() => {});
      composerApi.current?.clear();
      setTurns((cur) => [...cur, { role: 'user', text: `↪ ${tokensToDisplay(text)}`, ts: Date.now() }]);
      return;
    }
    // Chat-with-page mode: a message must target ≥1 pinned tab and carry real text
    // (the send button is also disabled — this guards Enter-key sends).
    if (pageChatMode && (chatPages.length === 0 || !text)) return;
    // Workflow references expand to their recipe text in the composer, so the agent
    // just sees the recipe as normal message text — nothing extra to inject.
    // ⟦tool:..⟧ tokens name a tool/adapter the agent can call directly.
    // Plain-text files are read inline and folded into the message as fenced
    // context blocks (there's no remote store). The chat bubble shows a compact
    // 📎×N marker instead of dumping the whole file.
    const fileBlock = attachedFiles.length
      ? '\n\n' +
        attachedFiles
          .map((f) => `[Attached file: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\``)
          .join('\n\n')
      : '';
    const fallback = attachedImages.length ? 'Take a look at this image' : attachedFiles.length ? 'Take a look at this file' : '';
    // ⟦cmd:..⟧ chips expand to their canned prompt for the agent; ⟦tool:..⟧ tokens
    // stay as markers (the agent calls that tool). The bubble shows /name.
    const agentText = expandCommandTokens(text);
    // Chat with page: the first send of a given pinned set embeds the read
    // instruction (tab list + get_page_text format:"markdown") and shows
    // quote cards; follow-ups ride on history where the content already lives.
    let pageBlock = '';
    let pageRefs: PageRef[] | undefined;
    if (chatPages.length > 0) {
      const key = chatPages.map((p) => `${p.tabId}:${p.url}`).join('|');
      if (sentPagesKey.current !== key) {
        sentPagesKey.current = key;
        pageBlock = '\n\n' + buildPageChatBlock(chatPages);
        pageRefs = chatPages.slice();
      }
    }
    const sendText = (agentText || fallback) + pageBlock + fileBlock;
    const marks = [
      tokensToDisplay(text),
      attachedImages.length ? `📷×${attachedImages.length}` : '',
      attachedFiles.length ? `📎×${attachedFiles.length}` : '',
    ].filter(Boolean);
    startRun(sendText, mode, attachedImages.length ? attachedImages : undefined, {
      displayText: marks.join(' ') || fallback,
      ...(pageRefs ? { pageRefs } : {}),
    });
    setAttachedFiles([]);
    // /plan is a one-shot force-a-plan for THIS task; /explore is a session mode
    // (resumes the trace across turns), so only reset plan.
    if (mode === 'plan') setMode('chat');
  }

  /** Open the 🌐 page-action menu: capture the user's active tab NOW so the
   * menu can show which page the actions will target. */
  async function openPageMenu(): Promise<void> {
    if (running || !apiReady) return;
    setPageMenu({ tab: await getUserActiveTab() });
  }

  /** T2 quick-action (page menu → Summarize this page). The target tab was locked when the
   * menu opened — the prompt embeds tabId/url so the agent never re-resolves the
   * active tab (a tab switch mid-run must not retarget the summary). Runs in
   * direct-execute regardless of the selected mode. */
  function onSummarizePage(tab: PageRef): void {
    if (running || !apiReady) return;
    startRun(
      `Please summarize this web page: ${tab.title ? `"${tab.title}"` : ''}\n${tab.url}\n\n` +
        `Use get_page_text(tab_id=${tab.tabId}) to fetch the body (the target page is locked — do NOT call get_active_tab again); ` +
        `if that tab was closed or the fetch failed, use get_page_text(url="${tab.url}") to reopen and fetch it. ` +
        `Then give a concise bullet-point summary (title + key content + main takeaways).`,
      'chat',
      undefined,
      { displayText: 'Summarize this page', pageRefs: [tab] },
    );
  }

  /** Chat with page: enter the mode and pin a page as context (chip above input). */
  function addChatPage(tab: PageRef): void {
    setPageChatMode(true);
    setChatPages((cur) => (cur.some((p) => samePage(p, tab)) ? cur : [...cur, tab]));
  }

  function toggleChatPage(tab: PageRef): void {
    setChatPages((cur) =>
      cur.some((p) => samePage(p, tab)) ? cur.filter((p) => !samePage(p, tab)) : [...cur, tab],
    );
  }

  /** Explicit exit for chat-with-page — removing every chip does NOT exit (the user
   * may just be swapping tabs); only this ✕ (or New chat / switch session) leaves it. */
  function exitPageChat(): void {
    setPageChatMode(false);
    setChatPages([]);
    setTabPicker(null);
  }

  /** Open the "+ Tabs" picker with every readable open tab (multi-select). */
  async function openTabPicker(): Promise<void> {
    const own = chrome.runtime.getURL('');
    let tabs: PageRef[] = [];
    try {
      tabs = (await chrome.tabs.query({}))
        .filter(
          (t) =>
            typeof t.id === 'number' &&
            !!t.url &&
            !t.url.startsWith(own) &&
            canReadPage(t.url),
        )
        .map((t) => ({
          tabId: t.id!,
          title: t.title ?? '',
          url: t.url ?? '',
          favIconUrl: t.favIconUrl,
        }));
    } catch {
      /* keep empty list */
    }
    setTabPicker(tabs);
  }

  /** Show a transient composer notice for a few seconds. */
  function flashAttachNote(msg: string): void {
    setAttachNote(msg);
    setTimeout(() => setAttachNote((cur) => (cur === msg ? null : cur)), 4000);
  }

  /** Max plain-text file size accepted for inline read (200 KB). Bigger files
   * would bloat the prompt; there's no remote store to offload to. */
  const MAX_TEXT_FILE_BYTES = 200 * 1024;

  /** Read a File as a base64 data URL (images) or UTF-8 text (text files). */
  function readFileAs(file: File, as: 'dataURL' | 'text'): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error ?? new Error('read failed'));
      if (as === 'dataURL') r.readAsDataURL(file);
      else r.readAsText(file);
    });
  }

  /** Handle files picked via the 📎 upload button. Images need a vision model
   * (else warn); other files must be plain text under the size cap and are read
   * inline (recorded as name + content, openable in an in-app viewer). */
  async function onUploadFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/');
      const isText =
        file.type.startsWith('text/') ||
        file.type === 'application/json' ||
        /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|ini|toml)$/i.test(file.name);
      if (isImage) {
        if (!hasVision) {
          flashAttachNote('The current config has no vision model, so images can\'t be uploaded. Configure a vision model under "LLM config → Model assignments".');
          continue;
        }
        try {
          const url = await readFileAs(file, 'dataURL');
          setAttachedImages((cur) => [...cur, url]);
        } catch {
          flashAttachNote(`Failed to read image: ${file.name}`);
        }
      } else if (isText) {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          flashAttachNote(`File too large (max ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB): ${file.name}`);
          continue;
        }
        try {
          const content = await readFileAs(file, 'text');
          setAttachedFiles((cur) => [...cur, { name: file.name, content }]);
        } catch {
          flashAttachNote(`Failed to read file: ${file.name}`);
        }
      } else {
        flashAttachNote(`Only images and plain-text files are supported: ${file.name}`);
      }
    }
  }

  /** Screenshot (region select): dim the user's page, drag a region (crosshair), annotate it
   * on the page (toolbar under the selection), then ✓ attaches the result to the
   * composer as an image to chat about. */
  async function onCaptureRegion(): Promise<void> {
    if (capturing) return; // guard re-entry — stacking overlays dim the page each click
    setCapturing(true);
    try {
      const url = await captureRegion(); // select + annotate in-page; null = cancelled
      if (url) setAttachedImages((cur) => [...cur, url]);
    } catch (e) {
      setTurns((cur) => [
        ...cur,
        {
          role: 'system',
          text: `Screenshot failed: ${e instanceof Error ? e.message : String(e)} (this page may not allow screenshots, e.g. chrome:// pages)`,
          level: 'error',
          ts: Date.now(),
        },
      ]);
    } finally {
      setCapturing(false);
    }
  }

  /** Abort an in-progress screenshot from the composer overlay: dispatch Esc into the
   * active tab so the in-page selector resolves null (captureRegion returns null
   * and onCaptureRegion's finally clears `capturing`). */
  async function cancelCapture(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const id = tabs[0]?.id;
      if (typeof id === 'number') {
        await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () =>
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
        });
      }
    } catch {
      /* ignore — the page Esc key also cancels */
    }
  }

  /** A workflow (or legacy shortcut) is a quick way to INSERT a reusable prompt
   * recipe into the composer (its text may embed ⟦tool:..⟧ chips). It no longer
   * runs on its own — the user edits/sends. Legacy tool-shortcuts insert an
   * adapter command chip. */
  function runShortcut(s: Shortcut): void {
    if (s.kind === 'tool' && s.tool) {
      composerApi.current?.insertCommand('tool', s.tool, s.tool);
      return;
    }
    if (s.text) composerApi.current?.insertTextWithTokens(s.text);
  }

  function onAbort(): void {
    // Clear progress + running immediately for instant visual feedback —
    // don't depend on a SW round-trip. SW will also fire SESSION_DONE
    // (reason: user_abort) which renders the "Stopped" system message; we
    // don't append it here to avoid duplication.
    setProgress(null);
    setRunning(false);
    setStreaming(null);
    setRunStats(null);
    if (!sessionId) return;
    clearSessionPendings(sessionId);
    const req: AbortSessionReq = { type: 'ABORT_SESSION', sessionId };
    void chrome.runtime.sendMessage(req).catch(() => {});
  }

  /** Multi-session: leaving a RUNNING conversation on screen no longer aborts
   * it — the SW keeps driving it; the session strip tracks it as background. */
  function detachCurrentIfRunning(): void {
    const sid = sessionId;
    if (!sid || !running) return;
    setBgSessions((cur) => {
      const next = new Map(cur);
      next.set(sid, { updatedAt: Date.now() });
      return next;
    });
  }

  /* Invariant: the foreground session is NEVER also a background pill. The mount
   * discovery seeds bgSessions from activeSessionIds before sessionIdRef is set,
   * so the soon-to-be-current session can land there and render twice. Whenever
   * the current session id changes, evict it from bgSessions (root fix for the
   * duplicate "check my 知乎 home page / check my 知乎 home page just now" chips). */
  useEffect(() => {
    if (!sessionId) return;
    setBgSessions((cur) => (cur.has(sessionId) ? mapWithout(cur, sessionId) : cur));
  }, [sessionId]);

  function onNewChat(): void {
    detachCurrentIfRunning(); // keep a running conversation alive in background
    setSessionId(null);
    sessionIdRef.current = null;
    setTurns([]);
    setProgress(null);
    setPlan(null);
    setLanes([]);
    setRunning(false);
    setAutoMode(false); // auto mode is per-conversation
    setExploreAdapters([]);
    setStreaming(null);
    setRunStats(null);
    setPageChatMode(false); // chat-with-page mode + pinned context are per-conversation
    setChatPages([]);
    sentPagesKey.current = '';
  }

  /** Load a session into the panel WITHOUT touching whatever runs elsewhere:
   * turns come from IDB (every engine step is persisted), live events then
   * continue on top; `running` comes from the SW's activeSessions (truthful,
   * unlike the persisted status which can go stale on SW death). */
  async function switchToSession(id: string): Promise<void> {
    if (id === sessionId) return;
    detachCurrentIfRunning();
    try {
      const [sessResp, stateResp] = await Promise.all([
        chrome.runtime.sendMessage({
          type: 'GET_SESSION',
          sessionId: id,
        } satisfies GetSessionReq) as Promise<GetSessionResp | undefined>,
        chrome.runtime.sendMessage({
          type: 'GET_SESSION_STATE',
        } satisfies GetSessionStateReq) as Promise<{ activeSessionIds?: string[] } | undefined>,
      ]);
      const s = (sessResp?.session as SessionState | null) ?? null;
      if (!s) return;
      const isActive = (stateResp?.activeSessionIds ?? []).includes(id);
      setSessionId(s.id);
      // Sync the ref NOW — the state effect runs a render later, and events
      // for the target session arriving in between must not be dropped.
      sessionIdRef.current = s.id;
      setTurns(historyToUiTurns(s.history));
      setPlan(s.plan ?? null);
      setExploreAdapters(s.exploreAdapters ?? []);
      setProgress(null);
      setStreaming(null);
      setRunStats(null);
      setLanes([]);
      setRunning(isActive);
      setAutoMode(!!s.autoApprove);
      setPageChatMode(false);
      setChatPages([]);
      sentPagesKey.current = '';
      setBgSessions((cur) => (cur.has(id) ? mapWithout(cur, id) : cur)); // now foreground
    } catch {
      /* ignore */
    }
  }

  // Download a complete debug bundle: the full chat session (UI turns + the raw
  // LLM apiMessages + plan + explore binding), every referenced trace
  // (actions/network/state), and the synthesized adapters (source + verify
  // results). One JSON file to hand over for diagnosing synthesis/verify quality.
  async function onExportBundle(): Promise<void> {
    if (!sessionId) return;
    let session: unknown = null;
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'GET_SESSION',
        sessionId,
      } satisfies GetSessionReq)) as GetSessionResp | undefined;
      session = resp?.session ?? null;
    } catch {
      /* fall through with null session */
    }
    // Collect every trace this session references (card adapters + the resume
    // binding), de-duped.
    const traceIds = new Set<string>();
    for (const a of exploreAdapters) if (a.traceId) traceIds.add(a.traceId);
    const boundTrace = (session as { explore?: { traceId?: string } } | null)?.explore?.traceId;
    if (boundTrace) traceIds.add(boundTrace);
    const traces: unknown[] = [];
    for (const tid of traceIds) {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'GET_TRACE',
          traceId: tid,
        } satisfies GetTraceReq)) as GetTraceResp | undefined;
        if (r?.trace) traces.push(r.trace);
      } catch {
        /* skip a trace we can't read */
      }
    }
    // Prefer the live card state; fall back to the copy persisted on the session
    // (survives a panel reload / dismissed card) so the bundle always has sources.
    const sessAdapters = (session as { exploreAdapters?: ExploreAdapter[] } | null)
      ?.exploreAdapters;
    const adapters = exploreAdapters.length ? exploreAdapters : (sessAdapters ?? []);
    const bundle = {
      kind: 'web-agent-session-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      sessionId,
      turns, // human-readable UI turns
      session, // full SessionState: apiMessages (the real LLM convo), plan, explore
      adapters, // synthesized source + verify (test-run) results
      traces, // full traces: actions / network (with bodies) / DOM snapshots
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `web-agent-session-${sessionId}.json`;
    el.click();
    URL.revokeObjectURL(url);
  }

  // API readiness: input gates on whether the user has configured an API key.
  const apiReady = !!llmConfig.apiKey;
  const apiLabel = llmConfig.model || llmConfig.provider;
  const inputBlocked = !apiReady;
  // Multi-session: the current session's pending prompts (others badge on the
  // strip), and the strip's background entries (most recent first).
  const curConfirmQueue = (sessionId ? pendingConfirms.get(sessionId) : undefined) ?? [];
  // Takeover to render: current session's first, else ANY session's (③a — a
  // bridge run's 'bridge' id never matches the viewed chat; never hide it).
  const displayedTakeover =
    (sessionId ? pendingTakeovers.get(sessionId) : undefined) ??
    [...pendingTakeovers.values()][0] ??
    null;
  const curPendingPlan = (sessionId ? pendingPlans.get(sessionId) : undefined) ?? null;
  const sessionNeedsInput = (id: string): boolean =>
    (pendingConfirms.get(id)?.length ?? 0) > 0 || pendingTakeovers.has(id) || pendingPlans.has(id);
  // Never render the foreground session as a background pill. The mount-time
  // discovery (GET_SESSION_STATE) filters by sessionIdRef.current, which is
  // still null on first mount — so the session about to be restored as current
  // can slip into bgSessions and show up TWICE (once as the current tab, once
  // as an orange "just now" pill). Belt-and-suspenders to the invariant effect below.
  const stripEntries = [...bgSessions.entries()]
    .filter(([id]) => id !== sessionId)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const currentStripLabel =
    (turns.find((t) => t.role === 'user')?.text ?? '').slice(0, 14) ||
    (sessionId ? 'Current chat' : 'New chat');
  // Live "what's happening now" text for the ongoing indicator.
  const inProgressStep = plan?.steps.find((s) => s.status === 'in_progress');
  const activeText =
    inProgressStep?.activeForm ||
    inProgressStep?.title ||
    (mode === 'plan' ? 'Planning…' : mode === 'explore' ? 'Exploring…' : 'Running…');
  // Claude Code-style plan housing: while any step is still pending/in_progress
  // the checklist stays pinned at the bottom of the flow (watch where the run
  // is); once EVERY step reaches a terminal state it returns to its natural
  // place — the last update_plan/submit_plan row renders as the checklist card.
  // planAnchor < 0 also covers the fallback (settled but no anchor turn, e.g.
  // an explore-seeded plan that never saw an update_plan): keep it at the
  // bottom rather than lose it.
  const planSettled =
    !!plan && plan.steps.length > 0 && plan.steps.every((s) => isTerminal(s.status));
  const planAnchor = planSettled ? lastToolTurnIndex(turns, PLAN_ANCHOR_TOOLS) : -1;
  // The Explore-results card lives in the flow like any other step, anchored after the last
  // synthesize_adapter row; bottom fallback for import/card-repair flows whose
  // results arrive without a synthesis turn in this session.
  const exploreAnchor =
    exploreAdapters.length > 0 ? lastToolTurnIndex(turns, EXPLORE_ANCHOR_TOOLS) : -1;
  const exploreCard =
    exploreAdapters.length > 0 ? (
      <RenderBoundary label="ExploreAdaptersCard">
        <ExploreAdaptersCard
          adapters={exploreAdapters}
          open={exploreOpen}
          sessionId={sessionId}
          installOrigin={
            healTarget?.origin.type === 'marketplace'
              ? ({ type: 'manual', healedFrom: 'marketplace' } as const)
              : healTarget && healTarget.origin.type !== 'explore'
                ? ({ type: 'manual' } as const)
                : ({ type: 'explore' } as const)
          }
          onToggle={() => setExploreOpen((o) => !o)}
          onUpdate={(a) => setExploreAdapters((list) => mergeAdapter(list, a))}
        />
      </RenderBoundary>
    ) : null;

  return (
    <ToastContext.Provider value={showToast}>
      {toastMsg && (
        <div class="toast" role="status">
          {toastMsg}
        </div>
      )}
      <header>
        <span class="brand-row">
          <span
            class={`status-pill ${apiReady ? 'ok' : 'warn'}`}
            onClick={() => setView('backend')}
            title={apiReady ? 'Click to open settings' : 'Click to configure API Key'}
          >
            <span class="dot" />
            {apiReady ? apiLabel : 'API not configured'}
          </span>
        </span>
        <span class="header-actions">
          {/* External access: icon-only status (the labeled pill fought the model pill
           * for width in a ~360px panel) — the amber plug + tooltip carries it. */}
          {bridgeConnected && (
            <span
              class="status-pill bridge compact"
              title="External access connected (an external AI agent can drive the browser) — click to manage/disable"
              aria-label="External access connected"
              onClick={() => setView('bridge')}
            >
              <IconPlug size={13} class="plug-icon" />
            </span>
          )}
          {/* Low-frequency actions (theme / open-in-tab) live in the ≡ menu —
           * the header keeps only status + New chat + Menu. */}
          <button class="ghost-btn round" title="Start a new chat" onClick={onNewChat}>
            <IconPlus size={18} />
          </button>
          <span class="menu-anchor">
            <button
              class={`ghost-btn round ${view === 'menu' ? 'active' : ''}`}
              title="Menu"
              onClick={() => setView((v) => (v === 'menu' ? 'closed' : 'menu'))}
            >
              <IconMenu size={18} />
            </button>
            {view === 'menu' && (
              <MenuDropdown
                onPick={(target) => setView(target)}
                theme={theme}
                onToggleTheme={() => {
                  toggleTheme();
                  setView('closed');
                }}
                onOpenInTab={
                  isFullPage
                    ? undefined
                    : () => {
                        openInTab();
                        setView('closed');
                      }
                }
              />
            )}
          </span>
        </span>
      </header>

      {stripEntries.length > 0 && (
        <div class="session-strip" role="tablist" aria-label="Parallel sessions">
          <button class="session-tab current" role="tab" aria-selected title="Current chat">
            <span class={`session-dot ${running ? 'running' : 'idle'}`} />
            <span class="session-tab-label">{currentStripLabel}</span>
          </button>
          {stripEntries.map(([id, info]) => {
            const needsInput = sessionNeedsInput(id);
            const label = (sessionMeta.get(id) ?? '').slice(0, 14) || 'Chat';
            return (
              <button
                key={id}
                class="session-tab"
                role="tab"
                title={`${sessionMeta.get(id) ?? id}\n${needsInput ? 'Waiting for your confirmation' : 'Running in background'} · click to switch (without interrupting the run)`}
                onClick={() => void switchToSession(id)}
              >
                <span class="session-dot running" />
                <span class="session-tab-label">{label}</span>
                {/* Same first message ⇒ same label — the start-time suffix is
                 * what tells two such sessions apart (parallel tests often use the same message). */}
                <span class="session-tab-time">{relativeTime(info.updatedAt)}</span>
                {needsInput && <span class="session-badge input">Input needed</span>}
              </button>
            );
          })}
        </div>
      )}

      {adapterUpdateNote && (
        <div class="adapter-update-toast" onClick={() => setAdapterUpdateNote(null)}>
          <IconRefresh size={14} />
          <span>{adapterUpdateNote}</span>
        </div>
      )}
      {[...brokenAlerts.values()].map((evt) => (
        <div class="broken-alert" key={evt.id}>
          <IconRefresh size={14} class="broken-alert-icon" />
          <span class="broken-alert-text">
            Tool <span class="mono">{evt.tool}</span> keeps failing — it may be broken
          </span>
          <button class="btn sm heal" onClick={() => void healFromAlert(evt)}>
            Repair
          </button>
          {evt.origin.type === 'marketplace' && (
            <button
              class="ghost-btn sm"
              title="File a breakage report to the marketplace (GitHub issue)"
              onClick={() => reportFromAlert(evt)}
            >
              Report
            </button>
          )}
          <button class="ghost-btn sm" onClick={() => dismissAlert(evt.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {schedNotices.map((n) => (
        <div
          class="sched-notice"
          key={n.sessionId}
          role="button"
          tabIndex={0}
          title="Click to open this run's session (won't be shown again)"
          onClick={() => {
            setSchedNotices((cur) => cur.filter((x) => x.sessionId !== n.sessionId));
            void removeScheduleNotice(n.sessionId);
            void switchToSession(n.sessionId);
          }}
        >
          <IconClock size={14} class="sched-notice-icon" />
          <span class="sched-notice-text">
            Scheduled task "{n.label}" {n.ok ? 'finished' : 'failed'} · {relativeTime(n.ts)} · click to view
          </span>
          <button
            class="ghost-btn sm"
            title="Dismiss (don't show again)"
            onClick={(e) => {
              e.stopPropagation();
              setSchedNotices((cur) => cur.filter((x) => x.sessionId !== n.sessionId));
              void removeScheduleNotice(n.sessionId);
            }}
          >
            <IconX size={12} />
          </button>
        </div>
      ))}

      <div class="messages" ref={messagesRef}>
        {turns.length === 0 && !running && (
          <>
            <WelcomeCard />
            {lastSessionId && (
              <button class="resume-link" onClick={() => void resumeLastSession()}>
                ↩ Resume last session
              </button>
            )}
          </>
        )}
        {turns.map((t, i) => {
          const kind = classifyTurn(turns, i);
          return (
            <Fragment key={i}>
              {i === planAnchor && plan ? (
                <PlanChecklist
                  plan={plan}
                  open={planOpen}
                  onToggle={() => setPlanOpen((o) => !o)}
                />
              ) : (
                <TurnView
                  turn={t}
                  kind={kind}
                  showDone={kind === 'answer' && hadToolActivityBefore(turns, i)}
                  onImage={setLightbox}
                />
              )}
              {i === exploreAnchor && exploreCard}
            </Fragment>
          );
        })}
        {streaming !== null && (
          <div class="msg assistant">
            <Markdown text={streaming || '…'} cite />
          </div>
        )}
        {plan && plan.steps.length > 0 && planAnchor < 0 && (
          <PlanChecklist plan={plan} open={planOpen} onToggle={() => setPlanOpen((o) => !o)} />
        )}
        {running && streaming === null && <ActiveHeader text={activeText} />}
        <SubagentLanes lanes={lanes} />
        {curConfirmQueue.length > 0 && (
          <WriteConfirmCard
            req={curConfirmQueue[0]}
            queueLen={curConfirmQueue.length}
            onDecide={onDecideWrite}
          />
        )}
        {displayedTakeover && (
          <HumanTakeoverCard
            req={displayedTakeover}
            onDecide={(resume) => onDecideTakeover(displayedTakeover, resume)}
          />
        )}
        {exploreAnchor < 0 && exploreCard}
      </div>

      {curPendingPlan && (
        <>
          {/* Pinned over the conversation (NOT inside the scrollable message
           * list, where it sat off-screen below the fold — §10.22). The backdrop
           * dims the rest so the required approve/modify/cancel decision can't be
           * scrolled away or ignored. */}
          <div class="plan-pin-backdrop" />
          <div class="plan-pin">
            <RenderBoundary label="PlanApprovalCard">
              <PlanApprovalCard req={curPendingPlan} onDecide={onDecidePlan} />
            </RenderBoundary>
          </div>
        </>
      )}

      <footer>
        {running && runStats && (
          <div class="run-stats">
            <span>Step {runStats.step}</span>
            <span>Context ~{fmtTok(runStats.promptTokens)} tok</span>
            <span>Output ~{fmtTok(runStats.completionTokens)} tok</span>
          </div>
        )}
        {shortcuts.length > 0 && (
          <ShortcutBar
            shortcuts={shortcuts}
            onRunShortcut={runShortcut}
            onManageShortcuts={() => setView('shortcuts')}
          />
        )}
        <div class="composer-wrap">
          {capturing && (
            <div class="capturing-overlay">
              <span>◉ Drag to select a screenshot region on the page…</span>
              <button class="capturing-cancel" onClick={() => void cancelCapture()}>
                Cancel
              </button>
            </div>
          )}
          <div class={`composer-card ${inputBlocked && !running ? 'disabled' : ''}`}>
            {pageChatMode && (
              <div class="page-chips">
                {chatPages.map((p) => (
                  <span class="page-chip" key={p.tabId ?? p.url} title={p.url}>
                    <PageFavicon src={p.favIconUrl} url={p.url} />
                    <span class="page-chip-title">{p.title || hostOf(p.url)}</span>
                    <button
                      class="composer-thumb-x"
                      title="Remove from chat"
                      aria-label="Remove from chat"
                      onClick={() => toggleChatPage(p)}
                    >
                      <IconX size={11} />
                    </button>
                  </span>
                ))}
                <span class="tab-picker-anchor">
                  <button
                    class="page-chip add"
                    title="Add more open tabs to the chat"
                    aria-expanded={!!tabPicker}
                    onClick={() => void openTabPicker()}
                  >
                    <IconPlus size={12} />
                    <span>Tabs</span>
                  </button>
                  {tabPicker && (
                    <>
                      {/* Backdrop closes on any outside click/tap (input box
                       * included) — no explicit Done button needed. */}
                      <div class="mode-backdrop" onClick={() => setTabPicker(null)} />
                      <div class="mode-menu tab-picker" role="menu">
                        <div class="tab-picker-head">
                          <span class="tab-picker-head-title">Tabs added to the chat</span>
                          <button
                            class="tab-picker-mini"
                            disabled={tabPicker.length === 0}
                            onClick={() =>
                              setChatPages((cur) => {
                                const merged = [...cur];
                                for (const t of tabPicker) {
                                  if (!merged.some((p) => samePage(p, t))) merged.push(t);
                                }
                                return merged;
                              })
                            }
                          >
                            Select all
                          </button>
                          <button
                            class="tab-picker-mini"
                            disabled={chatPages.length === 0}
                            onClick={() => setChatPages([])}
                          >
                            Clear
                          </button>
                        </div>
                        <div class="tab-picker-list">
                          {tabPicker.length === 0 && (
                            <div class="page-menu-note">No readable web-page tabs</div>
                          )}
                          {tabPicker.map((t) => {
                            const on = chatPages.some((p) => samePage(p, t));
                            return (
                              <label class="tab-picker-row" key={t.tabId ?? t.url} title={t.url}>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() => toggleChatPage(t)}
                                />
                                <PageFavicon src={t.favIconUrl} url={t.url} />
                                <span class="tab-picker-title">
                                  {t.title || hostOf(t.url) || t.url}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </span>
              </div>
            )}
            {(attachedImages.length > 0 || attachedFiles.length > 0) && (
              <div class="composer-attachments">
                {attachedImages.map((src, i) => (
                  <div key={`img-${i}`} class="composer-thumb">
                    <img src={src} alt={`Screenshot ${i + 1}`} />
                    <button
                      class="composer-thumb-x"
                      title="Remove"
                      aria-label="Remove"
                      onClick={() => setAttachedImages((cur) => cur.filter((_, j) => j !== i))}
                    >
                      <IconX size={11} />
                    </button>
                  </div>
                ))}
                {attachedFiles.map((f, i) => (
                  <div key={`file-${i}`} class="composer-file-chip" title={`View ${f.name}`}>
                    <button
                      class="composer-file-open"
                      onClick={() => setFileViewer(f)}
                      title={`View ${f.name}`}
                    >
                      <IconFile size={13} />
                      <span class="composer-file-name">{f.name}</span>
                    </button>
                    <button
                      class="composer-thumb-x"
                      title="Remove"
                      aria-label="Remove"
                      onClick={() => setAttachedFiles((cur) => cur.filter((_, j) => j !== i))}
                    >
                      <IconX size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachNote && <div class="composer-attach-note">{attachNote}</div>}
            <CommandEditor
              apiRef={composerApi}
              disabled={inputBlocked}
              placeholder={
                !apiReady
                  ? 'First add an API Key in the top-right menu → LLM backend…'
                  : running
                    ? 'Chime in to steer… (without interrupting the task) · type / to call a command'
                    : pageChatMode
                      ? chatPages.length === 0
                        ? 'First tap "+ Tabs" above to pick at least one page…'
                        : `Ask anything about ${chatPages.length > 1 ? 'these pages' : 'this page'}…`
                      : turns.length > 0
                        ? 'Reply… · type / to call a command'
                        : 'Ask me anything · type / to call a workflow/tool'
              }
              getCommands={() => gatherCommands(shortcuts, getPaletteTools(), skills, { builtins: true })}
              onChange={setInput}
              onEnter={() => void onSend()}
              onSetMode={(mode) => setMode(mode)}
            />
            <div class="composer-bar">
              <button
                class={`auto-toggle ${autoMode ? 'on' : ''}`}
                aria-pressed={autoMode}
                title={
                  autoMode
                    ? 'Auto-execute is ON: write ops (posting/commenting/etc.) no longer confirmed one by one — you can close the panel and wait for a notification · click to turn off'
                    : 'Auto-execute: when on, write ops are no longer confirmed one by one · click to turn on'
                }
                onClick={() => setAutoMode((v) => !v)}
              >
                <span class="auto-dot" />
                Auto
              </button>
              {mode !== 'chat' && (
                <button
                  class="mode-badge"
                  title={
                    mode === 'plan' ? 'Draft a plan for your approval first · click to cancel' : 'Explore mode · click to exit'
                  }
                  onClick={() => setMode('chat')}
                >
                  {mode === 'plan' ? <IconHand size={13} /> : <IconSearch size={13} />}
                  <span>{mode === 'plan' ? 'Plan first' : 'Explore'}</span>
                  <IconX size={11} />
                </button>
              )}
              {!isFullPage && (
                <>
                  {/* In chat-with-page mode the 🌐 button becomes the mode badge
                   * ("Page chat ✕", click = exit) — same idiom as the
                   * plan/explore mode-badge next to it. */}
                  {pageChatMode ? (
                    <button
                      class="mode-badge"
                      title="Chat-with-page mode: messages are answered from the selected tabs' content · click to exit"
                      aria-label="Exit chat-with-page mode"
                      onClick={exitPageChat}
                    >
                      <IconChat size={13} />
                      <span>Page chat</span>
                      <IconX size={11} />
                    </button>
                  ) : (
                    <span class="page-menu-anchor">
                      <button
                        class={`composer-icon-btn ${pageMenu ? 'active' : ''}`}
                        title="Page actions: summarize current page…"
                        aria-label="Page actions"
                        aria-expanded={!!pageMenu}
                        disabled={running || !apiReady}
                        onClick={() => void openPageMenu()}
                      >
                        <IconGlobe size={16} />
                      </button>
                      {pageMenu && (
                        <>
                          <div class="mode-backdrop" onClick={() => setPageMenu(null)} />
                          <div class="mode-menu page-menu" role="menu">
                            {pageMenu.tab ? (
                              <div class="page-menu-head">
                                <PageRefCard page={pageMenu.tab} flat />
                                {!canReadPage(pageMenu.tab.url) && (
                                  <div class="page-menu-note">
                                    This page can't be read (only http/https pages are supported)
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div class="page-menu-note">No readable web-page tabs</div>
                            )}
                            <button
                              class="mode-opt compact"
                              role="menuitem"
                              disabled={!pageMenu.tab || !canReadPage(pageMenu.tab.url)}
                              onClick={() => {
                                const t = pageMenu.tab;
                                setPageMenu(null);
                                if (t) onSummarizePage(t);
                              }}
                            >
                              <IconList size={15} class="mode-opt-icon" />
                              <span class="mode-opt-title">Summarize this page</span>
                            </button>
                            <button
                              class="mode-opt compact"
                              role="menuitem"
                              disabled={!pageMenu.tab || !canReadPage(pageMenu.tab.url)}
                              onClick={() => {
                                const t = pageMenu.tab;
                                setPageMenu(null);
                                if (t) addChatPage(t);
                              }}
                            >
                              <IconChat size={15} class="mode-opt-icon" />
                              <span class="mode-opt-title">Chat with page</span>
                            </button>
                          </div>
                        </>
                      )}
                    </span>
                  )}
                  <button
                    class="composer-icon-btn"
                    title="Screenshot (region select)"
                    aria-label="Screenshot"
                    disabled={capturing}
                    onClick={() => void onCaptureRegion()}
                  >
                    <IconCamera size={16} />
                  </button>
                </>
              )}
              <button
                class="composer-icon-btn"
                title={hasVision ? 'Upload image / text file' : 'Upload text file (images need a vision model configured first)'}
                aria-label="Upload"
                onClick={() => uploadInput.current?.click()}
              >
                <IconPaperclip size={16} />
              </button>
              <input
                ref={uploadInput}
                type="file"
                multiple
                accept="image/*,text/*,.txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.html,.htm,.ini,.toml"
                style="display:none"
                onChange={(e) => {
                  const t = e.target as HTMLInputElement;
                  void onUploadFiles(t.files);
                  t.value = '';
                }}
              />
              <button
                class="composer-icon-btn"
                title="Export chat (debug bundle)"
                aria-label="Export chat"
                disabled={!sessionId}
                onClick={() => void onExportBundle()}
              >
                <IconUpload size={16} />
              </button>
              <div class="composer-bar-right">
                {running ? (
                  <>
                    {input.trim() && (
                      <button
                        class="send-btn"
                        onClick={onSend}
                        title="Chime in to steer (without interrupting the session)"
                        aria-label="Chime in"
                      >
                        <IconArrowUp size={16} />
                      </button>
                    )}
                    <button
                      class="send-btn stop"
                      onClick={onAbort}
                      title="Stop generating"
                      aria-label="Stop"
                    >
                      <IconStop size={12} />
                    </button>
                  </>
                ) : (
                  <button
                    class="send-btn"
                    onClick={onSend}
                    disabled={
                      (!input.trim() &&
                        attachedImages.length === 0 &&
                        attachedFiles.length === 0) ||
                      (pageChatMode && (chatPages.length === 0 || !input.trim())) ||
                      inputBlocked
                    }
                    title={
                      pageChatMode && chatPages.length === 0
                        ? 'Chat-with-page mode: pick at least one tab first'
                        : 'Send (Enter)'
                    }
                    aria-label="Send"
                  >
                    <IconArrowUp size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </footer>

      {/* Top-level menu pages. History owns its own overlay because it has a
       * sub-page (one session's detail). The other three are plain content,
       * wrapped in the standard PageOverlay (title + close X). */}
      {view === 'backend' && (
        <PageOverlay title={PAGE_LABELS.backend} onClose={() => setView('closed')}>
          <LlmBackendSection config={llmConfig} onSave={(c) => setLlmConfig(c)} />
        </PageOverlay>
      )}
      {view === 'adapters' && (
        <PageOverlay title={PAGE_LABELS.adapters} onClose={() => setView('closed')}>
          <AdaptersSection
            onReference={(tools) => {
              for (const t of tools) composerApi.current?.insertCommand('tool', t, t);
              setView('closed');
            }}
            onHeal={(task, label, ht) => {
              // H1-P2: seed an explore run to re-derive a drifted adapter. Reuses
              // the normal agent-run launch (explore mode); the seeded source +
              // error go to the agent, a clean "🔧 Repair X" label shows in the chat.
              // healTarget makes the resulting install overwrite the original.
              if (running) {
                showToast('Finish the current task before repairing');
                return;
              }
              setView('closed');
              startRun(task, 'explore', undefined, { displayText: label, healTarget: ht });
            }}
          />
        </PageOverlay>
      )}
      {view === 'shortcuts' && (
        <PageOverlay title={PAGE_LABELS.shortcuts} onClose={() => setView('closed')}>
          <ShortcutsSection
            shortcuts={shortcuts}
            onRun={(s) => {
              runShortcut(s);
              setView('closed');
            }}
            getCommands={() => gatherCommands(shortcuts, getPaletteTools())}
          />
        </PageOverlay>
      )}
      {view === 'skills' && (
        <PageOverlay title={PAGE_LABELS.skills} onClose={() => setView('closed')}>
          <SkillsSection
            skills={skills}
            onInsert={(sk) => {
              composerApi.current?.insertTextWithTokens(sk.body);
              setView('closed');
            }}
            getCommands={() => gatherCommands(shortcuts, getPaletteTools(), skills)}
          />
        </PageOverlay>
      )}
      {view === 'bridge' && (
        <PageOverlay title={PAGE_LABELS.bridge} onClose={() => setView('closed')}>
          <BridgeSection />
        </PageOverlay>
      )}
      {view === 'secrets' && (
        <PageOverlay title={PAGE_LABELS.secrets} onClose={() => setView('closed')}>
          <SecretsSection />
          <RedactionSection />
        </PageOverlay>
      )}
      {view === 'history' && (
        <HistoryPage
          currentSessionId={sessionId}
          onClose={() => setView('closed')}
          onOpen={async (id) => {
            await switchToSession(id);
            setView('closed');
          }}
          onDelete={(id) => {
            const req: DeleteSessionReq = { type: 'DELETE_SESSION', sessionId: id };
            chrome.runtime.sendMessage(req).catch(() => {});
            // Drop panel-side tracking too (the SW aborts + deletes the row).
            setBgSessions((cur) => (cur.has(id) ? mapWithout(cur, id) : cur));
            clearSessionPendings(id);
            if (id === sessionId) {
              setSessionId(null);
              setTurns([]);
              setProgress(null);
            }
          }}
        />
      )}
      {view === 'memory' && (
        <PageOverlay title={PAGE_LABELS.memory} onClose={() => setView('closed')}>
          <MemorySection />
        </PageOverlay>
      )}
      {view === 'siteScripts' && (
        <PageOverlay title={PAGE_LABELS.siteScripts} onClose={() => setView('closed')}>
          <SiteScriptsSection />
        </PageOverlay>
      )}
      {view === 'notes' && (
        <PageOverlay title={PAGE_LABELS.notes} onClose={() => setView('closed')}>
          <NotesSection />
        </PageOverlay>
      )}
      {view === 'schedules' && (
        <PageOverlay title={PAGE_LABELS.schedules} onClose={() => setView('closed')}>
          <SchedulesSection
            onOpenWorkflows={() => setView('shortcuts')}
            getCommands={() => gatherCommands(shortcuts, getPaletteTools())}
          />
        </PageOverlay>
      )}
      {view === 'seltoolbar' && <SelToolbarPage onClose={() => setView('closed')} />}
      {lightbox && (
        <div class="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="screenshot" />
        </div>
      )}
      {fileViewer && (
        <div class="file-viewer" onClick={() => setFileViewer(null)}>
          <div class="file-viewer-card" onClick={(e) => e.stopPropagation()}>
            <div class="file-viewer-head">
              <IconFile size={14} />
              <span class="file-viewer-name">{fileViewer.name}</span>
              <button
                class="ghost-btn round"
                onClick={() => setFileViewer(null)}
                aria-label="Close"
                title="Close"
              >
                <IconX size={16} />
              </button>
            </div>
            <pre class="file-viewer-body">{fileViewer.content}</pre>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

type BarItem = { key: string; shortcut: Shortcut };

/** Quick-insert strip above the composer. The bar shows AS MANY workflow chips as fit
 * in ONE row (no horizontal scroll) — measured against an invisible full-width
 * mirror that always holds every chip, so trimming the visible strip never loses
 * the widths needed to re-measure on resize. The ⌃ button on the right pops the
 * FULL list (scrollable) plus a Manage button. */
function ShortcutBar(props: {
  shortcuts: Shortcut[];
  onRunShortcut: (s: Shortcut) => void;
  onManageShortcuts: () => void;
}): preact.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  // How many chips fit one row. Infinity → "show all" (pre-measure); slice and
  // hidden-count both treat Infinity correctly, so no flash before the first
  // (pre-paint) measure trims it.
  const [visible, setVisible] = useState(Infinity);
  const [open, setOpen] = useState(false);

  const items: BarItem[] = useMemo(
    () => props.shortcuts.map((s) => ({ key: `s:${s.id}`, shortcut: s })),
    [props.shortcuts],
  );
  // Labels drive chip widths → re-measure when the set or any label changes.
  const sig = items.map((it) => it.shortcut.label).join('');

  useLayoutEffect(() => {
    const bar = barRef.current;
    const mirror = mirrorRef.current;
    if (!bar || !mirror) return;
    const recompute = (): void => {
      const avail = bar.clientWidth;
      let n = 0;
      for (const chip of Array.from(mirror.children) as HTMLElement[]) {
        if (chip.offsetLeft + chip.offsetWidth <= avail) n++;
        else break;
      }
      setVisible((prev) => (prev === n ? prev : n));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [sig]);

  function renderChip(
    it: BarItem,
    onPick: (() => void) | undefined,
    measure: boolean,
  ): preact.JSX.Element {
    const tab = measure ? -1 : undefined;
    const s = it.shortcut;
    return (
      <button
        key={it.key}
        class="shortcut-chip"
        tabIndex={tab}
        title={`Insert into the input: ${s.kind === 'prompt' ? s.text : (s.tool ?? '')}`}
        onClick={onPick}
      >
        {s.kind === 'tool' ? <IconTerminal size={12} /> : <IconType size={12} />}
        <span class="shortcut-chip-label">{s.label}</span>
      </button>
    );
  }

  function pick(it: BarItem): void {
    props.onRunShortcut(it.shortcut);
    setOpen(false);
  }

  return (
    <div class="shortcut-bar-row">
      <div class="shortcut-bar" ref={barRef}>
        {items.slice(0, visible).map((it) => renderChip(it, () => pick(it), false))}
      </div>
      {/* Invisible mirror: every chip on one un-clipped row, measured only. */}
      <div class="shortcut-bar shortcut-bar-mirror" ref={mirrorRef} aria-hidden="true">
        {items.map((it) => renderChip(it, undefined, true))}
      </div>
      <div class="bar-manage-anchor">
        <button
          class={`shortcut-chip bar-manage ${open ? 'active' : ''}`}
          title="All workflows"
          aria-label="Show all workflows"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <IconChevronUp size={16} />
        </button>
        {open && (
          <>
            <div class="mode-backdrop" onClick={() => setOpen(false)} />
            <div class="menu-dropdown bar-popup" role="menu">
              <div class="bar-popup-chips">
                {items.map((it) => renderChip(it, () => pick(it), false))}
              </div>
              <div class="bar-popup-actions">
                <button
                  class="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    props.onManageShortcuts();
                  }}
                >
                  <IconBranch size={15} class="menu-icon" />
                  <span>Manage workflows</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Menu items as a lucide-icon + label list, in four groups: history first
 * (most-reached), then the operator's "kit" (adapters / workflows / site scripts /
 * scheduled tasks), then system surfaces, then the low-frequency
 * window actions relocated OUT of the header (Open in new tab / Toggle theme — the
 * ~360px header keeps only status + New chat + Menu). The dropdown anchors to its
 * parent (`.menu-anchor`); clicking outside the menu OR a menu item closes it. */
function MenuDropdown({
  onPick,
  theme,
  onToggleTheme,
  onOpenInTab,
}: {
  onPick: (target: View) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  /** Absent in the full-page view (it IS the tab already). */
  onOpenInTab?: () => void;
}): preact.JSX.Element {
  return (
    <div class="menu-dropdown" role="menu">
      <button class="menu-item" role="menuitem" onClick={() => onPick('history')}>
        <IconClock size={16} class="menu-icon" />
        <span>History</span>
      </button>
      <div class="menu-divider" />
      <button class="menu-item" role="menuitem" onClick={() => onPick('adapters')}>
        <IconPlug size={16} class="menu-icon" />
        <span>Adapters</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('shortcuts')}>
        <IconBranch size={16} class="menu-icon" />
        <span>Workflows</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('skills')}>
        <IconFile size={16} class="menu-icon" />
        <span>Skills</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('siteScripts')}>
        <IconSparkle size={16} class="menu-icon" />
        <span>Site scripts</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('schedules')}>
        <IconClock size={16} class="menu-icon" />
        <span>Scheduled tasks</span>
      </button>
      <div class="menu-divider" />
      <button class="menu-item" role="menuitem" onClick={() => onPick('backend')}>
        <IconCog size={16} class="menu-icon" />
        <span>LLM config</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('bridge')}>
        <IconTerminal size={16} class="menu-icon" />
        <span>External access</span>
      </button>
      {/* Credentials / My memory / My notes — hidden in the product build (FEATURES). */}
      {FEATURES.secrets && (
        <button class="menu-item" role="menuitem" onClick={() => onPick('secrets')}>
          <IconKey size={16} class="menu-icon" />
          <span>Credentials</span>
        </button>
      )}
      {FEATURES.memory && (
        <button class="menu-item" role="menuitem" onClick={() => onPick('memory')}>
          <IconBrain size={16} class="menu-icon" />
          <span>My memory</span>
        </button>
      )}
      {FEATURES.notes && (
        <button class="menu-item" role="menuitem" onClick={() => onPick('notes')}>
          <IconNote size={16} class="menu-icon" />
          <span>My notes</span>
        </button>
      )}
      {/* Selection toolbar — hidden in the product build (FEATURES.selectionToolbar). */}
      {FEATURES.selectionToolbar && (
        <button class="menu-item" role="menuitem" onClick={() => onPick('seltoolbar')}>
          <IconType size={16} class="menu-icon" />
          <span>Selection toolbar</span>
        </button>
      )}
      <div class="menu-divider" />
      {onOpenInTab && (
        <button class="menu-item" role="menuitem" onClick={onOpenInTab}>
          <IconMaximize size={16} class="menu-icon" />
          <span>Open in new tab</span>
        </button>
      )}
      <button class="menu-item" role="menuitem" onClick={onToggleTheme}>
        <span class="menu-icon theme-icon-menu">{theme === 'dark' ? '☀' : '☾'}</span>
        <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
      </button>
    </div>
  );
}

/** Selection toolbar — two-level page like HistoryPage: settings (default) ↔ highlight manager
 * sub-page (← back). */
function SelToolbarPage({ onClose }: { onClose: () => void }): preact.JSX.Element {
  const [sub, setSub] = useState<'main' | 'highlights'>('main');
  if (sub === 'highlights') {
    return (
      <PageOverlay title="Highlights" onClose={onClose} onBack={() => setSub('main')}>
        <HighlightManager />
      </PageOverlay>
    );
  }
  return (
    <PageOverlay title={PAGE_LABELS.seltoolbar} onClose={onClose}>
      <SelToolbarSection onOpenHighlights={() => setSub('highlights')} />
    </PageOverlay>
  );
}

/** Selection-toolbar settings — master switch, trigger mode, site BLACKLIST (enabled ⇒
 * every site minus these), and the editable LLM quick-action list (Highlight/Ask
 * are built-in and fixed at the two ends of the toolbar). Every change saves
 * immediately; open tabs re-configure live via storage.onChanged. */
function SelToolbarSection({
  onOpenHighlights,
}: {
  onOpenHighlights: () => void;
}): preact.JSX.Element {
  const [s, setS] = useState<SelToolbarSettings | null>(null);
  const [newHost, setNewHost] = useState('');
  const showToast = useContext(ToastContext);

  useEffect(() => {
    void loadSelSettings().then(setS);
  }, []);

  if (!s) return <div class="hist-empty">Loading…</div>;

  function save(next: SelToolbarSettings): void {
    setS(next);
    void saveSelSettings(next);
  }

  function addHost(raw: string): void {
    const host = normalizeBlacklistEntry(raw);
    if (!host) {
      showToast('Invalid site (enter a domain, e.g. example.com)');
      return;
    }
    if (s!.blacklist.includes(host)) {
      showToast('Already in the blacklist');
      return;
    }
    save({ ...s!, blacklist: [...s!.blacklist, host] });
    setNewHost('');
  }

  async function addCurrentSite(): Promise<void> {
    const tab = await getUserActiveTab();
    if (!tab || !canReadPage(tab.url)) {
      showToast('The current tab is not a normal web page');
      return;
    }
    addHost(tab.url);
  }

  function patchAction(id: string, patch: Partial<SelAction>): void {
    save({
      ...s!,
      actions: s!.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    });
  }

  function moveAction(id: string, dir: -1 | 1): void {
    const i = s!.actions.findIndex((a) => a.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s!.actions.length) return;
    const next = s!.actions.slice();
    [next[i], next[j]] = [next[j], next[i]];
    save({ ...s!, actions: next });
  }

  return (
    <div class="selset">
      <div class="selset-note">
        Select text on a page to pop up a quick toolbar: highlight (kept across refreshes), LLM actions like translate/explain (single call, instant), and
        "Ask" brings the selection back into the side-panel chat.
      </div>

      {/* Highlights first — it's the user's DATA (their highlights); the config
       * knobs live below it. */}
      <button class="selset-row selset-nav" onClick={onOpenHighlights}>
        <span class="selset-main">
          <span class="selset-title">Highlights</span>
          <span class="selset-hint">
            View/delete persistent highlights across all pages; you can also have the agent use them (e.g. "summarize all my highlights by category")
          </span>
        </span>
        <span class="selset-nav-arrow">›</span>
      </button>

      <label class="selset-row">
        <span class="selset-main">
          <span class="selset-title">Enable selection toolbar</span>
          <span class="selset-hint">
            Once on, it works on <b>all sites</b> (except the blacklisted ones below); already-open pages take effect immediately, no refresh needed
          </span>
        </span>
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => save({ ...s, enabled: (e.target as HTMLInputElement).checked })}
        />
      </label>

      {/* Config knobs only matter while the feature is on — hide them when the
        * master switch is off (Highlights above stays: the data outlives the
        * toggle). */}
      {s.enabled && (
        <>
          <div class="selset-row">
            <span class="selset-main">
              <span class="selset-title">Trigger</span>
              <span class="selset-hint">Too intrusive? Switch to show only while holding Alt/⌥</span>
            </span>
            <select
              class="selset-select"
              value={s.trigger}
              onChange={(e) =>
                save({ ...s, trigger: (e.target as HTMLSelectElement).value === 'alt' ? 'alt' : 'auto' })
              }
            >
              <option value="auto">Show automatically on selection</option>
              <option value="alt">Show only when selecting with Alt/⌥ held</option>
            </select>
          </div>

          <div class="selset-group">
            <div class="selset-title">Site blacklist</div>
            <div class="selset-hint">The toolbar won't show on these sites; example.com also covers its subdomains</div>
            {s.blacklist.length > 0 && (
              <div class="selset-chips">
                {s.blacklist.map((h) => (
                  <span class="page-chip" key={h} title={h}>
                    <span class="page-chip-title">{h}</span>
                    <button
                      class="composer-thumb-x"
                      title="Remove from blacklist"
                      aria-label="Remove from blacklist"
                      onClick={() => save({ ...s, blacklist: s.blacklist.filter((x) => x !== h) })}
                    >
                      <IconX size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div class="selset-addrow">
              <input
                class="shortcut-name-input"
                type="text"
                placeholder="example.com or a full URL"
                value={newHost}
                onInput={(e) => setNewHost((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addHost(newHost);
                }}
              />
              <button class="btn sm outline" onClick={() => addHost(newHost)}>
                Add
              </button>
              <button class="btn sm outline" onClick={() => void addCurrentSite()}>
                + Current site
              </button>
            </div>
          </div>

          <div class="selset-group">
            <div class="selset-title">Quick actions</div>
            <div class="selset-hint">
              "Highlight" and "Ask" are built in and fixed at the two ends; the LLM actions below show in order and can be added/edited/removed.
              The prompt describes "what to do with the selected text", and the selection is appended automatically.
            </div>
            <div class="selset-actions">
              {s.actions.map((a, i) => (
                <div class="selset-action" key={a.id}>
                  <div class="selset-action-head">
                    <input
                      class="shortcut-name-input selset-label-input"
                      type="text"
                      value={a.label}
                      maxLength={6}
                      title="Button label (2-4 chars recommended)"
                      onChange={(e) =>
                        patchAction(a.id, { label: (e.target as HTMLInputElement).value.trim() || a.label })
                      }
                    />
                    <label
                      class="selset-min"
                      title="Hide this button when the selection is shorter than this many chars (0 = always show). E.g. 'Summarize' only makes sense for longer selections"
                    >
                      ≥
                      <input
                        class="shortcut-name-input selset-min-input"
                        type="number"
                        min={0}
                        step={10}
                        value={a.minChars ?? 0}
                        onChange={(e) => {
                          const n = Math.max(
                            0,
                            Math.floor(Number((e.target as HTMLInputElement).value) || 0),
                          );
                          patchAction(a.id, { minChars: n });
                        }}
                      />
                      chars
                    </label>
                    <span class="spacer" />
                    <button
                      class="ghost-btn sm"
                      title="Move up"
                      disabled={i === 0}
                      onClick={() => moveAction(a.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      class="ghost-btn sm"
                      title="Move down"
                      disabled={i === s.actions.length - 1}
                      onClick={() => moveAction(a.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      class="ghost-btn sm danger"
                      title="Delete this action"
                      onClick={() => save({ ...s, actions: s.actions.filter((x) => x.id !== a.id) })}
                    >
                      Delete
                    </button>
                  </div>
                  <textarea
                    class="selset-prompt"
                    rows={2}
                    value={a.prompt}
                    placeholder="What to do with the selected text, e.g.: translate the selection into English…"
                    onChange={(e) => patchAction(a.id, { prompt: (e.target as HTMLTextAreaElement).value })}
                  />
                </div>
              ))}
            </div>
            <button
              class="btn sm outline"
              disabled={s.actions.length >= 8}
              onClick={() =>
                save({
                  ...s,
                  actions: [
                    ...s.actions,
                    {
                      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                      label: 'New action',
                      prompt: '',
                    },
                  ],
                })
              }
            >
              + New action
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Highlights — every page's persistent highlights, grouped by page: open the
 * page / delete one / clear the page. Deletions propagate to open tabs via the
 * content script's storage watcher. */
function HighlightManager(): preact.JSX.Element {
  const [groups, setGroups] = useState<PageHighlights[] | null>(null);

  const refresh = useCallback(() => {
    void listAllHighlights().then(setGroups);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (groups === null) return <div class="hist-empty">Loading…</div>;
  if (groups.length === 0) {
    return <div class="selset-hint">No highlights yet — select text on a page → Highlight, and it will show up here.</div>;
  }

  return (
    <div class="selset-hl-list">
      {groups.map((g) => {
        const title = g.entries.find((e) => e.title)?.title || hostOf(g.url) || g.url;
        return (
          <div class="selset-hl-page" key={g.key}>
            <div class="selset-hl-head">
              <button
                class="selset-hl-title"
                title={`Open ${g.url}`}
                onClick={() => void chrome.tabs.create({ url: g.url })}
              >
                {title}
              </button>
              <span class="selset-hl-count">{g.entries.length}</span>
              <button
                class="ghost-btn sm danger"
                title="Delete all highlights on this page"
                onClick={() => {
                  void clearPageHighlights(g.key).then(refresh);
                }}
              >
                Clear
              </button>
            </div>
            {g.entries
              .slice()
              .sort((a, b) => b.ts - a.ts)
              .map((e) => (
                <div class="selset-hl-row" key={e.id} title={e.exact}>
                  <span class="selset-hl-quote">
                    {e.exact.length > 80 ? `${e.exact.slice(0, 80)}…` : e.exact}
                  </span>
                  <span class="selset-hl-time">{relativeTime(e.ts)}</span>
                  <button
                    class="composer-thumb-x"
                    title="Delete this highlight"
                    aria-label="Delete this highlight"
                    onClick={() => {
                      void removeHighlight(g.key, e.id).then(refresh);
                    }}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** Full-surface overlay that fades a backdrop on top of the chat panel and
 * slides a panel in from the right.
 *
 * Two header shapes by props:
 *  - Default (top-level menu page): title on the left, [X] on the right. No
 *    back arrow — the page has no parent to return to (Esc / backdrop click
 *    / X all close it).
 *  - Sub-page (drill-down, e.g. one session detail): pass `onBack` to put a
 *    ← arrow on the left that pops back to the parent page. Pass
 *    `rightActions` to render custom buttons (e.g. [Open] [Delete]) instead of
 *    the default X.
 *
 * Esc always invokes `onClose` (or `onBack` for sub-pages — whichever the
 * caller wants to mean "leave this view"); backdrop click does the same. */
function PageOverlay({
  title,
  onClose,
  onBack,
  rightActions,
  children,
}: {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  rightActions?: preact.ComponentChildren;
  children: preact.ComponentChildren;
}): preact.JSX.Element {
  // Sub-page Esc bubbles to its own back action; top-level Esc closes.
  const escTarget = onBack ?? onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') escTarget();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [escTarget]);
  // Full-cover second-level page: a back arrow (top-left) returns to the chat
  // (top-level) or to the parent list (sub-page). Esc does the same.
  return (
    <div class="page-overlay">
      <div class="page">
        <div class="page-header">
          <button class="ghost-btn round" onClick={escTarget} aria-label="Back" title="Back">
            <IconChevronLeft size={18} />
          </button>
          <span class="page-title">{title}</span>
          <span class="page-actions">{rightActions}</span>
        </div>
        <div class="page-body">{children}</div>
      </div>
    </div>
  );
}

/** Live "ongoing" indicator at the active edge of the timeline — a spinning
 * sparkle + the current high-level task (Claude-for-Chrome style). */
function ActiveHeader({ text }: { text: string }): preact.JSX.Element {
  return (
    <div class="tl-active-head">
      <IconSparkle size={18} class="tl-sparkle" />
      <span>{text}</span>
    </div>
  );
}

/** Live parallel-subagent lanes (parallel-execution v2) — one row per fanned-out
 * subagent with truthful per-lane status. */
function SubagentLanes({ lanes }: { lanes: SubagentLane[] }): preact.JSX.Element | null {
  if (lanes.length === 0) return null;
  const running = lanes.filter((l) => l.status === 'running').length;
  return (
    <div class="subagent-lanes">
      <div class="subagent-lanes-head">
        🧵 Parallel subagents{running > 0 ? ` · ${running} running` : ` · ${lanes.length} done`}
      </div>
      {lanes.map((l) => (
        <div key={l.id} class={`subagent-lane ${l.status}`}>
          <span class="subagent-lane-dot" />
          <span class="subagent-lane-task">{l.task}</span>
          <span class="subagent-lane-status">
            {l.status === 'running'
              ? 'Running…'
              : l.status === 'failed'
                ? 'Failed'
                : `${l.digestChars ?? 0} chars${
                    l.durationMs != null ? ` · ${(l.durationMs / 1000).toFixed(1)}s` : ''
                  }`}
          </span>
        </div>
      ))}
    </div>
  );
}


/** Upsert one adapter row by id, preserving panel-only flags (installed is
 * sticky — set by the user, never unset by a streaming SW emit). Pure. */
function mergeAdapter(list: ExploreAdapter[], a: ExploreAdapter): ExploreAdapter[] {
  const i = list.findIndex((x) => x.id === a.id);
  if (i === -1) return [...list, a];
  const prev = list[i];
  const next = list.slice();
  next[i] = { ...prev, ...a, installed: a.installed || prev.installed };
  return next;
}

const ADAPTER_STATUS_META: Record<ExploreAdapter['status'], { label: string; color: string }> = {
  synthesizing: { label: '⏳ Synthesizing…', color: 'var(--accent)' },
  untested: { label: '• Untested', color: 'var(--muted)' },
  verifying: { label: '⏳ Testing…', color: 'var(--accent)' },
  passed: { label: '✓ Verified', color: 'var(--ok)' },
  failed: { label: '✗ Test failed', color: 'var(--err)' },
};

/** Initial test-run form values: arg names from the schema (or testArgs keys),
 * pre-filled with the synthesizer's example values. */
/** Persistent, toggle-able Explore-results card: one row per synthesized adapter.
 * Survives across turns in an explore session; status streams in live. */
function ExploreAdaptersCard({
  adapters,
  open,
  sessionId,
  installOrigin,
  onToggle,
  onUpdate,
}: {
  adapters: ExploreAdapter[];
  open: boolean;
  sessionId: string | null;
  installOrigin: { type: 'manual' | 'explore'; healedFrom?: 'marketplace' };
  onToggle: () => void;
  onUpdate: (a: ExploreAdapter) => void;
}): preact.JSX.Element {
  const passed = adapters.filter((a) => a.status === 'passed').length;
  const working = adapters.some((a) => a.status === 'synthesizing' || a.status === 'verifying');
  return (
    <div class="msg assistant explore-card">
      <div
        style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;"
        onClick={onToggle}
      >
        <span style="font-weight:600;">🔍 Explore results</span>
        <span style="opacity:.7;font-size:12px;">
          {passed}/{adapters.length} usable{working ? ' · in progress…' : ''}
        </span>
        <IconChevronDown size={13} class={`tl-chev ${open ? 'open' : ''}`} />
      </div>
      {open && (
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:10px;">
          {adapters.map((a) => (
            <AdapterRow
              key={a.id}
              a={a}
              sessionId={sessionId}
              installOrigin={installOrigin}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One synthesized-adapter row: status badge + editable-args test-run (auto-saved
 * on pass, no install button) / repair / source / trace download. */
function AdapterRow({
  a,
  sessionId,
  installOrigin,
  onUpdate,
}: {
  a: ExploreAdapter;
  sessionId: string | null;
  installOrigin: { type: 'manual' | 'explore'; healedFrom?: 'marketplace' };
  onUpdate: (a: ExploreAdapter) => void;
}): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [repaired, setRepaired] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [argVals, setArgVals] = useState<Record<string, string>>(() =>
    initArgVals(a.args, a.testArgs),
  );

  const tool = a.tool ?? (a.site && a.name ? `${a.site}__${a.name}` : '');
  const linkBtn =
    'background:none;border:none;cursor:pointer;opacity:.75;text-decoration:underline;font-size:12px;';
  const meta = ADAPTER_STATUS_META[a.status];
  const inProgress = a.status === 'synthesizing' || a.status === 'verifying';

  /** Test-run passed → auto-save (Explore-generated tab). The install button is gone:
   * passing verification keeps it, and the user deletes unwanted ones under
   * "Adapters → Explore-generated". Idempotent (reinstalling the same id just refreshes the row). */
  async function persistPassed(rows?: number): Promise<boolean> {
    if (!a.source) return false;
    const r = await installAdapterFromSource(a.source, installOrigin);
    if (!r.ok) {
      setErr(r.error ?? 'Save failed');
      return false;
    }
    const id = r.id ?? (a.site && a.name ? `${a.site}/${a.name}` : tool);
    void chrome.runtime
      .sendMessage({
        type: 'SET_ADAPTER_VERIFY',
        id,
        status: 'passed',
        note: typeof rows === 'number' ? `${rows} rows` : 'OK',
      } satisfies SetAdapterVerifyReq)
      .catch(() => {});
    return true;
  }

  /** Test-run failed: if this adapter was already saved (auto-persisted / last pass),
   * honestly flip its stored verify status to failed — don't save a new one. The id is
   * derived by origin (explore-saved adapters are re-homed into the `my-` namespace;
   * heal/manual keep the original site, docs §15); the SW no-ops on a nonexistent id. */
  function syncVerifyFailed(error?: string): void {
    if (!a.site || !a.name) return;
    const id =
      installOrigin.type === 'explore'
        ? `${toExploredSite(a.site)}/${a.name}`
        : `${a.site}/${a.name}`;
    void chrome.runtime
      .sendMessage({
        type: 'SET_ADAPTER_VERIFY',
        id,
        status: 'failed',
        note: error ?? 'Failed',
      } satisfies SetAdapterVerifyReq)
      .catch(() => {});
  }

  async function onRun(): Promise<void> {
    if (!tool) return;
    setBusy(true);
    setErr(null);
    const argsObj = buildArgs(a.args, argVals);
    let resp = await runTool(tool, argsObj);
    // Session registrations die with the SW, and import/backstop rows were never
    // registered — re-register the source for this session (no persist) + retry.
    if (!resp.ok && /not found/i.test(resp.error ?? '') && a.source) {
      const reg = await registerSessionAdapter(a.source);
      if (reg.ok) resp = await runTool(tool, argsObj);
      else if (reg.error) setErr(reg.error);
    }
    const persisted = resp.ok ? await persistPassed(resp.rows) : false;
    // Only a REAL execution failure demotes the stored verify status — a policy
    // refusal (write adapters don't auto-run) or a still-unregistered tool says
    // nothing about whether the adapter works (both strings from handleRunTool).
    // NOTE: the 'no auto test-run' fragment MUST stay identical to the message
    // produced in background/explore-driver.ts:728 (write ops don't auto-test-run).
    const refused = /not found|no auto test-run/i.test(resp.error ?? '');
    if (!resp.ok && !refused) syncVerifyFailed(resp.error);
    setBusy(false);
    onUpdate({
      ...a,
      status: resp.ok ? 'passed' : 'failed',
      ...(persisted ? { installed: true } : {}),
      verify: { ok: resp.ok, rows: resp.rows, preview: resp.preview, error: resp.error },
    });
  }

  function onRepair(): void {
    if (!a.source || !sessionId) return;
    void chrome.runtime
      .sendMessage({
        type: 'EXPLORE_REPAIR',
        sessionId,
        traceId: a.traceId,
        prevSource: a.source,
        error: a.verify?.error ?? a.error ?? 'The run returned empty or incorrect results',
      } satisfies ExploreRepairReq)
      .catch(() => {});
    setRepaired(true);
  }

  async function onDownloadTrace(): Promise<void> {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: 'GET_TRACE',
        traceId: a.traceId,
      } satisfies GetTraceReq)) as GetTraceResp | undefined;
      const blob = new Blob([JSON.stringify(resp?.trace ?? null, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const el = document.createElement('a');
      el.href = url;
      el.download = `${a.traceId}.json`;
      el.click();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }

  return (
    <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <code style="font-size:12px;">{tool || a.name || '(synthesizing)'}</code>
        <span style={`color:${meta.color};font-size:12px;`}>
          {meta.label}
          {a.status === 'passed' && typeof a.verify?.rows === 'number'
            ? ` (${a.verify.rows} rows)`
            : ''}
        </span>
        {a.installed ? (
          <span style="font-size:11px;opacity:.6;" title="Saved to 'Adapters → Explore-generated' — manage/delete it there">
            Saved
          </span>
        ) : null}
      </div>
      {a.summary ? <div style="opacity:.8;font-size:12px;margin-top:2px;">{a.summary}</div> : null}
      {a.status === 'failed' && (a.verify?.error || a.error) ? (
        <div style="color:var(--err);font-size:12px;margin-top:2px;">{a.verify?.error ?? a.error}</div>
      ) : null}

      {!inProgress && (a.source || tool) ? (
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:6px;">
          {tool ? (
            <button onClick={() => setShowForm((s) => !s)} style={linkBtn}>
              {showForm ? 'Hide test-run' : 'Test-run'}
            </button>
          ) : null}
          {a.status === 'failed' && !repaired ? (
            <button onClick={onRepair} style={linkBtn}>
              Repair from the error
            </button>
          ) : null}
          {repaired ? <span style="opacity:.7;font-size:12px;">Repair requested…</span> : null}
          {a.source ? (
            <button onClick={() => setShowSource((s) => !s)} style={linkBtn}>
              {showSource ? 'Hide source' : 'View source'}
            </button>
          ) : null}
          <button onClick={onDownloadTrace} style={linkBtn}>
            Download trace
          </button>
        </div>
      ) : null}

      {err ? <div style="color:var(--err);font-size:12px;margin-top:4px;">{err}</div> : null}

      {showForm && tool ? (
        <ArgsForm
          args={a.args}
          values={argVals}
          onChange={setArgVals}
          onRun={onRun}
          busy={busy}
          runLabel="Test-run"
        />
      ) : null}

      {a.verify?.preview ? (
        <CopyableBlock title="Test-run result" text={a.verify.preview} maxHeight={260} />
      ) : null}
      {showSource && a.source ? (
        <CopyableBlock title="Adapter source" text={a.source} maxHeight={340} />
      ) : null}
    </div>
  );
}

function WriteConfirmCard({
  req,
  queueLen,
  onDecide,
}: {
  req: WriteConfirmReq;
  queueLen: number;
  onDecide: (approved: boolean) => void;
}) {
  const argsJson = useMemo(() => {
    try {
      return JSON.stringify(req.args ?? {}, null, 2);
    } catch {
      return String(req.args);
    }
  }, [req.args]);
  // Mode-switch ask (enter_explore_mode) rides the write-confirm channel but
  // reads as its own thing — no scary write-op copy, no args JSON.
  if (req.tool === 'enter_explore_mode') {
    return (
      <div class="write-confirm">
        <div class="title">🔍 Enter Explore mode?</div>
        {req.description && <div class="desc">{req.description}</div>}
        <div class="desc">
          Explore mode records page actions and network traffic in a dedicated tab, used to synthesize / modify site adapters.
        </div>
        <div class="actions">
          <button class="primary" onClick={() => onDecide(true)}>
            Enter Explore mode
          </button>
          <button class="secondary" onClick={() => onDecide(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="write-confirm">
      <div class="title">⚠️ Write operation needs confirmation</div>
      <div class="tool-name">
        <code>{req.tool}</code>
      </div>
      {req.description && <div class="desc">{req.description}</div>}
      <pre class="args">{argsJson}</pre>
      {queueLen > 1 && <div class="queued">{queueLen - 1} more write op(s) queued</div>}
      <div class="actions">
        <button class="primary" onClick={() => onDecide(true)}>
          Confirm & run
        </button>
        <button class="secondary" onClick={() => onDecide(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Human-takeover prompt (H9-P1): a tool hit a login/auth wall the agent can't
 * pass, but the user (right here at the browser) can. The SW already focused the
 * tab; ask the user to log in / solve it there, then Continue (retry) or Give up.
 * Reuses the .write-confirm card styling. */
function HumanTakeoverCard({
  req,
  onDecide,
}: {
  req: HumanTakeoverReq;
  onDecide: (resume: boolean) => void;
}) {
  const focusTab = (): void => {
    const id = req.tabId;
    if (typeof id !== 'number') return;
    chrome.tabs.update(id, { active: true }).catch(() => {});
    chrome.tabs
      .get(id)
      .then((t) => {
        if (typeof t.windowId === 'number') {
          void chrome.windows.update(t.windowId, { focused: true });
        }
      })
      .catch(() => {});
  };
  return (
    <div class="write-confirm">
      <div class="title">{req.message ? '🙋 Need a hand with one step' : '🔐 Need you to take over login / verification'}</div>
      <div class="desc">
        {req.message ? (
          <>
            {req.message}
            <br />
            I've switched to the relevant tab for you — once you're done in the browser, click "I'm done, continue".
          </>
        ) : (
          <>
            Tool <code>{req.tool}</code> hit a login wall / verification on{req.domain ? <b> {req.domain} </b> : ' some site '}.
            I've switched to the relevant tab for you — please log in or verify in the browser, then click "Continue".
          </>
        )}
        {req.autoResume && (
          <>
            <br />
            <span style={{ opacity: 0.7 }}>
              ✨ Once you're done I'll auto-detect the page change and resume — or just click the button below.
            </span>
          </>
        )}
      </div>
      <div class="actions">
        <button class="primary" onClick={() => onDecide(true)}>
          I'm done, continue
        </button>
        {typeof req.tabId === 'number' && (
          <button class="secondary" onClick={focusTab}>
            Back to tab
          </button>
        )}
        <button class="secondary" onClick={() => onDecide(false)}>
          Give up
        </button>
      </div>
    </div>
  );
}

/** Workflow management page (formerly Shortcuts, T5): create / edit / list / insert /
 * delete prompt recipes. A workflow is a reusable prompt recipe describing a whole
 * flow in natural language (it may embed ⟦tool:..⟧); the agent runs it flexibly.
 * Stored as prompt shortcuts (kind 'prompt'); tool shortcuts are legacy (created
 * from the Adapters Run panel). Mutations persist via the store; the parent stays
 * in sync via storage.onChanged. */
function ShortcutsSection({
  shortcuts,
  onRun,
  getCommands,
}: {
  shortcuts: Shortcut[];
  onRun: (s: Shortcut) => void;
  getCommands: () => { shortcuts: CommandItem[]; tools: CommandItem[] };
}): preact.JSX.Element {
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const promptApi = useRef<CommandEditorHandle | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  // Text to seed the editor with when the (lazily-mounted) form opens. The
  // editor isn't in the DOM until formOpen flips true, so we can't populate it
  // synchronously from startEdit — an effect does it once the editor mounts.
  const pendingText = useRef('');

  useEffect(() => {
    if (!formOpen) return;
    promptApi.current?.clear();
    if (pendingText.current) promptApi.current?.insertTextWithTokens(pendingText.current);
    formRef.current?.scrollIntoView({ block: 'nearest' });
    promptApi.current?.focus();
  }, [formOpen, editingId]);

  function resetForm(): void {
    setEditingId(null);
    setFormOpen(false);
    setLabel('');
    setText('');
    pendingText.current = '';
    promptApi.current?.clear();
  }

  function openNew(): void {
    setEditingId(null);
    setLabel('');
    setText('');
    pendingText.current = '';
    setFormOpen(true);
  }

  function startEdit(s: Shortcut): void {
    if (s.kind !== 'prompt') return;
    setEditingId(s.id);
    setLabel(s.label);
    setText(s.text ?? '');
    pendingText.current = s.text ?? '';
    setFormOpen(true);
  }

  async function save(): Promise<void> {
    const t = (promptApi.current?.getValue() ?? text).trim();
    const name = label.trim();
    if (!name || !t) return;
    await saveShortcut({ id: editingId ?? makeShortcutId(), label: name, kind: 'prompt', text: t });
    resetForm();
  }

  /** One-line, token-cleaned preview of a shortcut for the collapsed row. */
  function preview(s: Shortcut): string {
    if (s.kind !== 'prompt') return s.tool ?? '';
    return tokensToDisplay(s.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return (
    <div class="memory-section">
      <p class="page-intro">
        A <b>workflow</b> is a reusable <b>prompt recipe</b>
        — write out the whole flow (what to do, which tools/adapters to call, how to organize the results); click "Insert" to fill it into the input box and let
        the AI run it flexibly (you can keep editing before sending); it can also run on a schedule as a scheduled task. Use <code>/</code> in the recipe to insert
        <b>tools / adapters</b>.
      </p>

      {!formOpen && shortcuts.length > 0 && (
        <button class="add-btn" onClick={openNew}>
          <IconPlus size={15} /> New workflow
        </button>
      )}

      {formOpen && (
        <div class="shortcut-new" ref={formRef}>
          {editingId && <div class="shortcut-edit-tag">Editing "{label || '…'}"</div>}
          <input
            class="shortcut-name-input"
            placeholder="Name (required, search it with /)"
            value={label}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          />
          <div class="shortcut-prompt-field big">
            <CommandEditor
              apiRef={promptApi}
              placeholder="Recipe content, e.g.: scrape the hackernews front page, sort by popularity, open the details of the top 5 and write a one-line comment on each (type / to insert tools/adapters)"
              getCommands={() => {
                const all = getCommands();
                return { shortcuts: [], tools: all.tools };
              }}
              onChange={setText}
            />
          </div>
          <div class="shortcut-form-actions">
            <button
              class="btn primary"
              disabled={!label.trim() || !text.trim()}
              onClick={() => void save()}
            >
              {editingId ? 'Save changes' : 'Add'}
            </button>
            <button class="btn outline" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {shortcuts.length === 0
        ? !formOpen && (
            <div class="empty-state">
              <div class="empty-glyph">
                <IconFastForward size={22} />
              </div>
              <div class="empty-title">No workflows yet</div>
              <div class="empty-hint">
                Turn a flow you use often into a prompt recipe — one click to use it, or summon it with / in the input box, or run it on a schedule.
              </div>
              <button class="btn tonal" onClick={openNew}>
                <IconPlus size={14} /> New workflow
              </button>
            </div>
          )
        : (
            <ul class="item-list">
              {shortcuts.map((s) => {
                const open = expandedId === s.id;
                const isTool = s.kind === 'tool';
                return (
                  <li key={s.id} class={`item-card ${open ? 'open' : ''}`}>
                    <button
                      class="item-head"
                      onClick={() => setExpandedId(open ? null : s.id)}
                      aria-expanded={open}
                    >
                      <span class="item-glyph">
                        {isTool ? <IconTerminal size={16} /> : <IconType size={16} />}
                      </span>
                      <span class="item-main">
                        <span class="item-title">{s.label}</span>
                        <span class="item-sub">
                          <span class="item-sub-text">{preview(s) || '(empty)'}</span>
                        </span>
                      </span>
                      {isTool && <span class="item-meta">Tool</span>}
                      <IconChevronDown size={16} class="item-chevron" />
                    </button>
                    {open && (
                      <div class="item-body">
                        <div class="item-text">
                          {s.kind === 'prompt'
                            ? tokensToDisplay(s.text ?? '').trim() || '(empty)'
                            : `${s.tool} ${JSON.stringify(s.args ?? {})}`}
                        </div>
                        <div class="item-actions">
                          <button class="btn sm tonal" onClick={() => onRun(s)}>
                            <IconCornerDownLeft size={14} /> Insert
                          </button>
                          {s.kind === 'prompt' && (
                            <button class="btn sm outline" onClick={() => startEdit(s)}>
                              <IconPencil size={13} /> Edit
                            </button>
                          )}
                          <button
                            class="btn sm danger spacer"
                            onClick={() => {
                              if (s.id === editingId) resetForm();
                              void deleteShortcut(s.id);
                            }}
                          >
                            <IconTrash size={13} /> Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
    </div>
  );
}

function BridgeSection(): preact.JSX.Element {
  const [status, setStatus] = useState<{
    enabled: boolean;
    connected: boolean;
    port: number;
    allowWrites: boolean;
    denySites: string[];
  } | null>(null);
  const [port, setPort] = useState('8787');
  const [log, setLog] = useState<BridgeCall[]>([]);
  const [denyInput, setDenyInput] = useState('');

  async function refresh(): Promise<void> {
    const r = (await chrome.runtime.sendMessage({
      type: 'GET_BRIDGE_STATUS',
    } satisfies GetBridgeStatusReq)) as GetBridgeStatusResp | undefined;
    if (r) {
      setStatus({
        enabled: r.enabled,
        connected: r.connected,
        port: r.port,
        allowWrites: r.allowWrites,
        denySites: r.denySites,
      });
      setPort(String(r.port));
    }
    try {
      const lr = (await chrome.runtime.sendMessage({
        type: 'GET_BRIDGE_LOG',
      } satisfies GetBridgeLogReq)) as GetBridgeLogResp | undefined;
      setLog(lr?.calls ?? []);
    } catch {
      /* best-effort */
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, []);

  async function set(patch: {
    enabled?: boolean;
    allowWrites?: boolean;
    writeDenySites?: string[];
  }): Promise<void> {
    await chrome.runtime.sendMessage({
      type: 'SET_BRIDGE_ENABLED',
      enabled: patch.enabled ?? status?.enabled ?? false,
      port: Number(port) || 8787,
      allowWrites: patch.allowWrites ?? status?.allowWrites ?? true,
      writeDenySites: patch.writeDenySites ?? status?.denySites ?? [],
    } satisfies SetBridgeEnabledReq);
    void refresh();
  }

  function denySet(next: string[]): void {
    void set({ writeDenySites: next });
  }

  const dotClass = status?.enabled ? (status.connected ? '' : 'err') : 'warn';
  const statusText = status?.enabled
    ? status.connected
      ? `Connected · 127.0.0.1:${status.port}`
      : 'Enabled, not connected (bridge not running?)'
    : 'Disabled';

  return (
    <div class="memory-section">
      <p class="page-intro">
        Turn your logged-in browser into an <b>AI tool base</b>: more capable external agents (Claude Code / Cursor /
        Codex) drive the browser on this machine — the one you're logged into — using ready-made deterministic adapters to scrape data, automate actions, even
        explore and build adapters on the fly. Faster and more reliable than raw computer-use (deterministic adapters), no re-login (your real session), local-
        first (127.0.0.1 only, no internet). Once the skill is installed the AI starts the bridge and connects on its own — all you do here is enable a port.
      </p>

      <div class="status-card">
        <span class={`dot ${dotClass}`} />
        <div style="flex:1;min-width:0">
          <div class="label">Status</div>
          <div class="value">{statusText}</div>
        </div>
        {status?.enabled ? (
          <button class="btn sm danger outline" onClick={() => void set({ enabled: false })}>
            Disable
          </button>
        ) : (
          <button class="btn sm tonal" onClick={() => void set({ enabled: true })}>
            Enable
          </button>
        )}
      </div>

      <div class="bridge-row">
        <label class="bridge-label">Port</label>
        <input
          class="bridge-port"
          value={port}
          onInput={(e) => setPort((e.target as HTMLInputElement).value)}
        />
        {status && port.trim() && String(status.port) !== port.trim() && (
          <button class="btn sm tonal" onClick={() => void set({})}>
            Save
          </button>
        )}
      </div>

      <label class="bridge-toggle">
        <input
          type="checkbox"
          checked={status?.allowWrites ?? true}
          onChange={(e) => void set({ allowWrites: (e.target as HTMLInputElement).checked })}
        />
        <span>Allow external write operations (posting / commenting / etc.; confirmed one by one on the AI-editor side)</span>
      </label>

      {(status?.allowWrites ?? true) && (
        <div class="bridge-deny">
          <div class="bridge-deny-title">
            Sites where external writes are never allowed (even with the toggle above on, write ops on these sites are always rejected)
          </div>
          {(status?.denySites ?? []).length > 0 && (
            <div class="bridge-deny-chips">
              {(status?.denySites ?? []).map((siteName) => (
                <span class="bridge-deny-chip" key={siteName}>
                  {siteName}
                  <button
                    title="Remove"
                    onClick={() => denySet((status?.denySites ?? []).filter((x) => x !== siteName))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div class="bridge-deny-add">
            <input
              class="bridge-port"
              placeholder="Site key, e.g. weibo"
              value={denyInput}
              onInput={(e) => setDenyInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const v = denyInput.trim();
                const cur = status?.denySites ?? [];
                if (v && !cur.includes(v)) denySet([...cur, v]);
                setDenyInput('');
              }}
            />
            <button
              class="btn sm tonal"
              disabled={!denyInput.trim()}
              onClick={() => {
                const v = denyInput.trim();
                const cur = status?.denySites ?? [];
                if (v && !cur.includes(v)) denySet([...cur, v]);
                setDenyInput('');
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div class="bridge-guide">
        <div class="bridge-guide-title">Connect an AI editor in three steps</div>
        <ol class="bridge-guide-steps">
          <li>
            Install the <b>skill</b> (either way):
            <ul>
              <li>
                <code>npx skills add whitefoxx/web-agent-skills -g</code>
              </li>
              <li>
                Or send the repo URL <code>github.com/whitefoxx/web-agent-skills</code> to the AI and have it install it.
              </li>
            </ul>
          </li>
          <li>
            <b>Enable</b> a port above (default 8787).
          </li>
          <li>
            Just tell the AI to "open / scrape / operate … with my browser" or "make an adapter for site X". Once it reads the skill
            it starts the bridge, connects, and calls tools; <b>ask it directly for more ways to use it</b>.
          </li>
        </ol>
        <div class="bridge-guide-note">Write ops like posting / commenting require the "Allow external write operations" checkbox above.</div>
      </div>

      {log.length > 0 && (
        <div class="bridge-log">
          <div class="bridge-log-title">External-operation log (latest {log.length}, live)</div>
          <ul class="bridge-log-list">
            {log.map((c, i) => (
              <li key={`${c.ts}-${i}`} class={`bridge-log-item ${c.ok ? '' : 'fail'}`}>
                <span class={`bridge-log-dot ${c.ok ? 'ok' : 'fail'}`} />
                <span class="bridge-log-tool mono">{c.tool}</span>
                {c.write && <span class="bridge-log-write">write</span>}
                {!c.ok && c.error && (
                  <span class="bridge-log-err" title={c.error}>
                    {c.error}
                  </span>
                )}
                <span class="bridge-log-time">{new Date(c.ts).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SchedulesSection({
  onOpenWorkflows,
  getCommands,
}: {
  onOpenWorkflows: () => void;
  /** The `/` palette groups (shortcuts + tools/adapters) for the prompt editor. */
  getCommands: () => { shortcuts: CommandItem[]; tools: CommandItem[] };
}): preact.JSX.Element {
  const [list, setList] = useState<Schedule[]>([]);
  // Workflows = reusable prompt recipes (stored as prompt shortcuts) the task can run.
  const [recipes, setRecipes] = useState<Shortcut[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  // What to run: a saved workflow (its current recipe text) or an inline prompt —
  // both run as a full agent session, as if the user sent it in a new chat.
  const [taskKind, setTaskKind] = useState<'workflow' | 'prompt'>('workflow');
  const [scId, setScId] = useState('');
  const [promptText, setPromptText] = useState('');
  // The inline-prompt field is a CommandEditor (so `/` inserts tools/adapters);
  // its serialized value (with ⟦tool:..⟧ tokens) IS promptText. Seed it on
  // open/edit via the imperative handle (it mounts only in prompt mode).
  const promptApi = useRef<CommandEditorHandle | null>(null);
  const pendingPrompt = useRef('');
  // Repeat rule (iPhone-reminder-ish): once / daily / weekly-on-days / monthly-on-Nth / every-N.
  const [repeat, setRepeat] = useState<'once' | 'daily' | 'weekly' | 'monthly' | 'interval'>(
    'daily',
  );
  const [timeStr, setTimeStr] = useState('08:00');
  const [dateStr, setDateStr] = useState('');
  const [weekDays, setWeekDays] = useState<Set<number>>(() => new Set([1]));
  const [monthDay, setMonthDay] = useState('1');
  const [everyN, setEveryN] = useState('6');
  const [everyUnit, setEveryUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  // Editing an existing schedule reuses the add form (pre-filled); null = new.
  const [editingId, setEditingId] = useState<string | null>(null);
  const showToast = useContext(ToastContext);

  async function refresh(): Promise<void> {
    const r = (await chrome.runtime.sendMessage({ type: 'LIST_SCHEDULES' })) as
      | SchedulesResp
      | undefined;
    setList(r?.schedules ?? []);
    try {
      setRecipes((await listShortcuts()).filter((s) => s.kind === 'prompt'));
    } catch {
      setRecipes([]);
    }
  }
  useEffect(() => {
    void refresh();
    // Live row status (Running… → result): the runner updates the schedule row at
    // start and at completion — watch the store instead of polling.
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'local' && SCHEDULES_KEY in changes) void refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Seed the prompt CommandEditor when it (re)mounts in prompt mode — with the
  // schedule being edited, or empty for a fresh task.
  useEffect(() => {
    if (!addOpen || taskKind !== 'prompt') return;
    promptApi.current?.clear();
    if (pendingPrompt.current) promptApi.current?.insertTextWithTokens(pendingPrompt.current);
  }, [addOpen, taskKind]);

  async function save(sch: Schedule): Promise<void> {
    const r = (await chrome.runtime.sendMessage({
      type: 'SAVE_SCHEDULE',
      schedule: sch,
    } satisfies SaveScheduleReq)) as SchedulesResp | undefined;
    if (r) setList(r.schedules);
  }

  function parseTime(): { hour: number; minute: number } {
    const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
    return m
      ? { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) }
      : { hour: 8, minute: 0 };
  }

  function buildCadence(): Cadence | null {
    const { hour, minute } = parseTime();
    switch (repeat) {
      case 'daily':
        return { kind: 'daily', hour, minute };
      case 'weekly': {
        if (weekDays.size === 0) {
          showToast('Pick at least one day per week');
          return null;
        }
        return { kind: 'weekly', days: [...weekDays], hour, minute };
      }
      case 'monthly':
        return {
          kind: 'monthly',
          day: Math.min(31, Math.max(1, Number(monthDay) || 1)),
          hour,
          minute,
        };
      case 'once': {
        const at = new Date(`${dateStr}T${timeStr || '08:00'}`).getTime();
        if (!dateStr || Number.isNaN(at)) {
          showToast('Please pick a date and time');
          return null;
        }
        if (at <= Date.now()) {
          showToast('That time has passed — pick a time in the future');
          return null;
        }
        return { kind: 'once', at };
      }
      default: {
        const n = Math.max(1, Number(everyN) || 1);
        const minutes = everyUnit === 'days' ? n * 1440 : everyUnit === 'hours' ? n * 60 : n;
        return { kind: 'interval', minutes };
      }
    }
  }

  function resetForm(): void {
    setAddOpen(false);
    setEditingId(null);
    setLabel('');
    setNote('');
    setScId('');
    setPromptText('');
    pendingPrompt.current = '';
    promptApi.current?.clear();
  }

  /** Pre-fill the add form from an existing schedule (edit). */
  function openEdit(sch: Schedule): void {
    setEditingId(sch.id);
    setLabel(sch.label);
    setNote(sch.note ?? '');
    setTaskKind(sch.shortcutId ? 'workflow' : 'prompt');
    setScId(sch.shortcutId ?? '');
    setPromptText(sch.prompt ?? '');
    pendingPrompt.current = sch.prompt ?? ''; // the seed effect fills the editor
    const c = sch.cadence;
    if (c.kind === 'interval') {
      setRepeat('interval');
      if (c.minutes % 1440 === 0) {
        setEveryN(String(c.minutes / 1440));
        setEveryUnit('days');
      } else if (c.minutes % 60 === 0) {
        setEveryN(String(c.minutes / 60));
        setEveryUnit('hours');
      } else {
        setEveryN(String(c.minutes));
        setEveryUnit('minutes');
      }
    } else if (c.kind === 'once') {
      setRepeat('once');
      const d = new Date(c.at);
      setDateStr(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate(),
        ).padStart(2, '0')}`,
      );
      setTimeStr(
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      );
    } else {
      setRepeat(c.kind);
      setTimeStr(`${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`);
      if (c.kind === 'weekly') setWeekDays(new Set(c.days));
      if (c.kind === 'monthly') setMonthDay(String(c.day));
    }
    setAddOpen(true);
  }

  async function create(): Promise<void> {
    if (!label.trim()) return;
    const cadence = buildCadence();
    if (!cadence) return;
    const rec = recipes.find((s) => s.id === scId);
    if (taskKind === 'workflow' && !rec) return;
    if (taskKind === 'prompt' && !promptText.trim()) return;
    // Editing keeps identity + run bookkeeping; the object is built FRESH (not
    // spread) so switching task kind clears the other kind's fields.
    const prior = editingId ? list.find((s) => s.id === editingId) : undefined;
    await save({
      id: prior?.id ?? makeScheduleId(),
      label: label.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(taskKind === 'prompt'
        ? { prompt: promptText.trim() }
        : { shortcutId: rec!.id, shortcutLabel: rec!.label }),
      cadence,
      enabled: prior?.enabled ?? true,
      createdAt: prior?.createdAt ?? Date.now(),
      ...(prior?.lastRun != null
        ? { lastRun: prior.lastRun, lastStatus: prior.lastStatus, lastSummary: prior.lastSummary }
        : {}),
    });
    resetForm();
  }

  async function del(id: string): Promise<void> {
    const r = (await chrome.runtime.sendMessage({
      type: 'DELETE_SCHEDULE',
      id,
    } satisfies DeleteScheduleReq)) as SchedulesResp | undefined;
    if (r) setList(r.schedules);
  }

  async function runNow(id: string): Promise<void> {
    // Instant feedback: flip the row to Running optimistically, then confirm via
    // the (now-immediate) response + the storage watcher. The runner refuses a
    // second start while one is in flight, so double-clicks are safe anyway.
    setList((cur) =>
      cur.map((s) =>
        s.id === id
          ? { ...s, lastStatus: 'running', lastRun: Date.now(), lastSummary: 'Running…' }
          : s,
      ),
    );
    const r = (await chrome.runtime.sendMessage({
      type: 'RUN_SCHEDULE_NOW',
      id,
    } satisfies RunScheduleNowReq)) as RunScheduleNowResp | undefined;
    if (r && !r.ok) {
      showToast(r.error ?? 'Cannot run');
      void refresh();
      return;
    }
    showToast('Started — the session appears in History (⏰ tag); you will be notified when it finishes');
  }

  const canCreate = !!label.trim() && (taskKind === 'prompt' ? !!promptText.trim() : !!scId);

  return (
    <div class="memory-page">
      <p class="page-intro">
        Automatically run a <b>workflow</b> or a <b>prompt</b> on schedule in the background
        (equivalent to opening a new session and sending it for you). Each run is recorded as a
        <b> ⏰ Scheduled task </b>-tagged <b>History</b> entry
        (open it to keep asking follow-ups); when it finishes you get a desktop notification, and a top banner if the side panel is open.
      </p>

      {!addOpen && (
        <button class="add-btn" onClick={() => setAddOpen(true)}>
          <IconPlus size={15} /> New scheduled task
        </button>
      )}
      {addOpen && (
        <div class="memory-add">
          <input
            class="memory-input note-title-input"
            placeholder="Task name, e.g. 'Morning brief'"
            value={label}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          />
          <input
            class="memory-input note-title-input"
            placeholder="Note (optional)"
            value={note}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
          <div class="sched-cadence">
            <select
              class="memory-input note-title-input"
              value={taskKind}
              onChange={(e) =>
                setTaskKind((e.target as HTMLSelectElement).value as 'workflow' | 'prompt')
              }
            >
              <option value="workflow">Run a workflow</option>
              <option value="prompt">Run a prompt</option>
            </select>
          </div>
          {taskKind === 'workflow' ? (
            <>
              <select
                class="memory-input note-title-input"
                value={scId}
                onChange={(e) => setScId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Choose a workflow…</option>
                {recipes.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <div class="sched-newwf">
                <button class="link-btn" title="Go to the Workflows page to create one" onClick={onOpenWorkflows}>
                  + New workflow
                </button>
              </div>
            </>
          ) : (
            <div class="shortcut-prompt-field">
              <CommandEditor
                apiRef={promptApi}
                placeholder="The task to run on schedule, e.g.: scrape HN headlines and the 知乎 hot list, pick out AI-related items and write a summary (type / to insert tools/adapters)"
                getCommands={() => {
                  const all = getCommands();
                  return { shortcuts: [], tools: all.tools };
                }}
                onChange={setPromptText}
              />
            </div>
          )}
          <div class="sched-cadence">
            <select
              class="memory-input note-title-input sched-repeat"
              value={repeat}
              onChange={(e) =>
                setRepeat(
                  (e.target as HTMLSelectElement).value as
                    | 'once'
                    | 'daily'
                    | 'weekly'
                    | 'monthly'
                    | 'interval',
                )
              }
            >
              <option value="once">Once</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="interval">Every</option>
            </select>
            {(repeat === 'daily' || repeat === 'weekly' || repeat === 'monthly') && (
              <span class="sched-cadence-fields">
                {repeat === 'monthly' && (
                  <>
                    <input
                      class="bridge-port"
                      type="number"
                      min={1}
                      max={31}
                      value={monthDay}
                      onInput={(e) => setMonthDay((e.target as HTMLInputElement).value)}
                    />
                    of the month
                  </>
                )}
                <input
                  class="bridge-port sched-time"
                  type="time"
                  value={timeStr}
                  onInput={(e) => setTimeStr((e.target as HTMLInputElement).value)}
                />
              </span>
            )}
            {repeat === 'interval' && (
              <span class="sched-cadence-fields">
                <input
                  class="bridge-port"
                  type="number"
                  min={1}
                  value={everyN}
                  onInput={(e) => setEveryN((e.target as HTMLInputElement).value)}
                />
                <select
                  class="memory-input note-title-input sched-unit"
                  value={everyUnit}
                  onChange={(e) =>
                    setEveryUnit(
                      (e.target as HTMLSelectElement).value as 'minutes' | 'hours' | 'days',
                    )
                  }
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </span>
            )}
          </div>
          {/* Native date+time pickers are too wide to share half a row — the
           * once fields get their own full-width row (50/50 date/time). */}
          {repeat === 'once' && (
            <div class="sched-cadence">
              <span class="sched-cadence-fields">
                <input
                  class="bridge-port sched-date"
                  type="date"
                  value={dateStr}
                  onInput={(e) => setDateStr((e.target as HTMLInputElement).value)}
                />
                <input
                  class="bridge-port sched-time"
                  type="time"
                  value={timeStr}
                  onInput={(e) => setTimeStr((e.target as HTMLInputElement).value)}
                />
              </span>
            </div>
          )}
          {repeat === 'weekly' && (
            <div class="sched-days">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                <button
                  key={i}
                  class={`sched-day ${weekDays.has(i) ? 'on' : ''}`}
                  onClick={() =>
                    setWeekDays((cur) => {
                      const next = new Set(cur);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                >
                  {d}
                </button>
              ))}
            </div>
          )}
          <div class="shortcut-form-actions">
            <button class="btn primary" disabled={!canCreate} onClick={() => void create()}>
              {editingId ? 'Save' : 'Add'}
            </button>
            <button class="btn outline" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div class="empty-state">
          <div class="empty-glyph">
            <IconClock size={22} />
          </div>
          <div class="empty-title">No scheduled tasks yet</div>
          <div class="empty-hint">
            Put a workflow or a prompt on a schedule and it runs automatically in the background, with results going into History.
          </div>
        </div>
      ) : (
        <ul class="memory-list">
          {list.map((sch) => {
            const running = sch.lastStatus === 'running';
            const promptPreview = tokensToDisplay(sch.prompt ?? '');
            const taskText = sch.shortcutId
              ? `Workflow: ${sch.shortcutLabel ?? ''}`
              : `Prompt: ${promptPreview.slice(0, 24)}${promptPreview.length > 24 ? '…' : ''}`;
            return (
              <li class="memory-item sched-item" key={sch.id}>
                <div class="sched-main">
                  <div class="sched-title">
                    <input
                      type="checkbox"
                      checked={sch.enabled}
                      onChange={() => void save({ ...sch, enabled: !sch.enabled })}
                    />
                    <span class={sch.enabled ? '' : 'sched-off'}>{sch.label}</span>
                  </div>
                  <div class="sched-sub">
                    {taskText} · {cadenceLabel(sch.cadence)}
                    {sch.note && <span> · {sch.note}</span>}
                    {sch.lastRun != null && (
                      <span class={`sched-last ${sch.lastStatus === 'fail' ? 'fail' : ''}`}>
                        {' · last '}
                        {new Date(sch.lastRun).toLocaleString()} {sch.lastSummary ?? ''}
                      </span>
                    )}
                  </div>
                </div>
                <div class="sched-actions">
                  <button
                    class="btn sm tonal"
                    disabled={running}
                    onClick={() => void runNow(sch.id)}
                  >
                    <IconPlay size={13} /> {running ? 'Running' : 'Run now'}
                  </button>
                  <button class="btn sm outline" title="Edit" onClick={() => openEdit(sch)}>
                    <IconPencil size={13} />
                  </button>
                  <button class="btn sm danger outline" onClick={() => void del(sch.id)}>
                    <IconTrash size={13} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Credentials (Secrets) — user-supplied sensitive values (API keys / tokens) adapters
 * & tools need at call time but the model NEVER sees. Values are write-only here:
 * stored in chrome.storage.local, injected late in the SW (env for func adapters
 * reading `process.env.NAME`, or `{{secret:NAME}}` placeholder substitution in
 * tool args), and redacted out of results. See secret-store.ts /
 * docs/adapter-secrets.md. The list endpoint returns names+metadata only, so the
 * value can't be re-read here — editing replaces it (blank = keep). */
function SecretsSection(): preact.JSX.Element {
  const [items, setItems] = useState<SecretInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [scope, setScope] = useState('');
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const showToast = useContext(ToastContext);

  async function reload(): Promise<void> {
    try {
      setItems(await listSecretInfos());
    } catch {
      setItems([]);
    }
    setLoading(false);
  }
  useEffect(() => {
    void reload();
  }, []);

  function openAdd(): void {
    setEditing(null);
    setName('');
    setValue('');
    setNote('');
    setScope('');
    setErr('');
    setFormOpen(true);
  }
  function openEdit(info: SecretInfo): void {
    setEditing(info.name);
    setName(info.name);
    setValue(''); // never prefilled (we don't expose the value) — blank = keep
    setNote(info.note ?? '');
    setScope((info.scope ?? []).join(', '));
    setErr('');
    setFormOpen(true);
  }

  async function submit(): Promise<void> {
    const nm = name.trim();
    if (!isValidSecretName(nm)) {
      setErr('The name must be a valid env-var name (letters/digits/underscore, not starting with a digit), e.g. WEREAD_API_KEY');
      return;
    }
    const orig = editing;
    const scopeArr = scope
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const meta = { scope: scopeArr, note: note.trim() || undefined };
    // Renaming: the name IS the storage key, so a changed name means delete-old +
    // write-new. Block landing on a name that already exists.
    if (orig !== null && nm !== orig && items.some((i) => i.name === nm)) {
      setErr(`A credential named ${nm} already exists`);
      return;
    }
    try {
      if (orig !== null && nm !== orig) {
        // name changed → rename. renameSecret carries the existing value over (no
        // re-entry); if a NEW value was also typed, write fresh + drop the old.
        if (value.trim()) {
          await saveSecret(nm, { value: value.trim(), ...meta });
          await deleteSecret(orig);
        } else {
          await renameSecret(orig, nm, meta);
        }
      } else if (orig !== null && !value.trim()) {
        // same name, value blank → scope/note only, keep the key.
        await updateSecretMeta(nm, meta);
      } else {
        if (!value.trim()) {
          setErr('Please enter a value');
          return;
        }
        await saveSecret(nm, { value: value.trim(), ...meta });
      }
      setFormOpen(false);
      setValue('');
      await reload();
      showToast(editing ? 'Credential updated' : 'Credential saved');
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }

  async function del(nm: string): Promise<void> {
    try {
      await deleteSecret(nm);
    } catch {
      /* ignore — UI removes it regardless */
    }
    setConfirmDel(null);
    setItems((cur) => cur.filter((i) => i.name !== nm));
  }

  return (
    <div class="memory-page">
      <p class="page-intro">
        Sensitive credentials (API keys, tokens…) that adapters / tools need at runtime. Stored only on this machine in{' '}
        <code>chrome.storage.local</code>, and <b>never enter the model context</b> —
        they're injected in the background at call time, and auto-masked if echoed back in results. An adapter reading <code>process.env.NAME</code>{' '}
        gets the matching credential injected automatically; writing <code>{'{{secret:NAME}}'}</code> in a tool arg substitutes it before execution.
      </p>

      {!formOpen && (
        <div class="page-actions">
          <button class="add-btn" onClick={openAdd}>
            <IconPlus size={15} /> Add credential
          </button>
        </div>
      )}

      {formOpen && (
        <div class="memory-add secret-form">
          <label class="secret-field">
            <span>Name{editing ? ' (renaming keeps the existing value)' : ''}</span>
            <input
              class="secret-input"
              placeholder="WEREAD_API_KEY"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="secret-field">
            <span>Value{editing ? ' (leave blank to keep unchanged)' : ''}</span>
            <input
              class="secret-input"
              type="password"
              autocomplete="off"
              placeholder={editing ? '•••••• (leave blank to keep)' : 'Paste key / token'}
              value={value}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="secret-field">
            <span>Note (optional)</span>
            <input
              class="secret-input"
              placeholder="微信读书 Agent key"
              value={note}
              onInput={(e) => setNote((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="secret-field">
            <span>Restrict to sites (optional, comma-separated; blank = any adapter referencing it)</span>
            <input
              class="secret-input"
              placeholder="weread-official, weread*"
              value={scope}
              onInput={(e) => setScope((e.target as HTMLInputElement).value)}
            />
          </label>
          {err && <div class="secret-err">{err}</div>}
          <div class="shortcut-form-actions">
            <button class="btn primary" onClick={() => void submit()}>
              {editing ? 'Save' : 'Add'}
            </button>
            <button
              class="btn outline"
              onClick={() => {
                setFormOpen(false);
                setValue('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? null : items.length === 0 ? (
        !formOpen && (
          <div class="empty-state">
            <div class="empty-glyph">
              <IconKey size={22} />
            </div>
            <div class="empty-title">No credentials yet</div>
            <div class="empty-hint">
              Save an API key / token and an adapter (like 微信读书) can use it without ever exposing it to the model.
            </div>
            <button class="btn tonal" onClick={openAdd}>
              <IconPlus size={14} /> Add credential
            </button>
          </div>
        )
      ) : (
        <div class="secret-list">
          {items.map((it) => (
            <div class="secret-card" key={it.name}>
              <div class="secret-card-main">
                <div class="secret-name">
                  <IconKey size={14} /> {it.name}
                </div>
                {it.note && <div class="secret-note">{it.note}</div>}
                <div class="secret-meta">
                  <span class="secret-set">•••••• Set</span>
                  {it.scope && it.scope.length > 0 && (
                    <span class="secret-scope">Limited to {it.scope.join(', ')}</span>
                  )}
                </div>
              </div>
              <div class="secret-card-actions">
                <button class="icon-btn" title="Edit" onClick={() => openEdit(it)}>
                  <IconPencil size={14} />
                </button>
                {confirmDel === it.name ? (
                  <>
                    <button class="btn danger sm" onClick={() => void del(it.name)}>
                      Delete
                    </button>
                    <button class="btn outline sm" onClick={() => setConfirmDel(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button class="icon-btn" title="Delete" onClick={() => setConfirmDel(it.name)}>
                    <IconTrash size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
/** Masking rules (⑦, page-agent transformPageContent) — user regexes scrubbed from
 * tool results before the model sees them. Lives on the Credentials page since both
 * control what reaches the LLM. Applied in the dispatcher's redaction pass
 * alongside the secret-value scrub. */
function RedactionSection(): preact.JSX.Element {
  const [items, setItems] = useState<RedactPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('gi');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const showToast = useContext(ToastContext);

  async function reload(): Promise<void> {
    try {
      setItems(await loadRedactPatterns());
    } catch {
      setItems([]);
    }
    setLoading(false);
  }
  useEffect(() => {
    void reload();
  }, []);

  function openAdd(): void {
    setEditing(null);
    setPattern('');
    setFlags('gi');
    setLabel('');
    setErr('');
    setFormOpen(true);
  }
  function openEdit(p: RedactPattern): void {
    setEditing(p.id);
    setPattern(p.pattern);
    setFlags(p.flags);
    setLabel(p.label);
    setErr('');
    setFormOpen(true);
  }

  async function submit(): Promise<void> {
    const pat = pattern.trim();
    if (!pat) {
      setErr('Please enter a regex');
      return;
    }
    if (!isValidRegex(pat, flags)) {
      setErr('Invalid regex (check the syntax)');
      return;
    }
    try {
      await saveRedactPattern({
        id: editing ?? makeRedactId(),
        pattern: pat,
        flags: flags.trim() || 'gi',
        label: label.trim() || 'redacted',
        enabled: editing ? (items.find((x) => x.id === editing)?.enabled ?? true) : true,
      });
      setFormOpen(false);
      await reload();
      showToast(editing ? 'Masking rule updated' : 'Masking rule added');
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }
  async function toggle(p: RedactPattern): Promise<void> {
    await saveRedactPattern({ ...p, enabled: !p.enabled }).catch(() => {});
    await reload();
  }
  async function del(id: string): Promise<void> {
    await deleteRedactPattern(id).catch(() => {});
    setItems((cur) => cur.filter((x) => x.id !== id));
  }

  return (
    <div class="redact-section">
      <div class="settings-subhead">Masking rules</div>
      <p class="page-intro">
        Before tool results reach the model, your regexes replace matches with <code>«label»</code> (e.g. emails, phone numbers, employee IDs). Applies to all tool results, sharing the same background masking pass as "Credentials" above.
      </p>
      {!formOpen && (
        <div class="page-actions">
          <button class="add-btn" onClick={openAdd}>
            <IconPlus size={15} /> Add rule
          </button>
        </div>
      )}
      {formOpen && (
        <div class="memory-add secret-form">
          <label class="secret-field">
            <span>Regex (without the surrounding slashes)</span>
            <input
              class="secret-input"
              placeholder="[\w.+-]+@[\w-]+\.[\w.-]+"
              value={pattern}
              onInput={(e) => setPattern((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="secret-field">
            <span>flags (default gi)</span>
            <input
              class="secret-input"
              placeholder="gi"
              value={flags}
              onInput={(e) => setFlags((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="secret-field">
            <span>Replacement label</span>
            <input
              class="secret-input"
              placeholder="email"
              value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
            />
          </label>
          {err && <div class="secret-err">{err}</div>}
          <div class="shortcut-form-actions">
            <button class="btn primary" onClick={() => void submit()}>
              {editing ? 'Save' : 'Add'}
            </button>
            <button class="btn outline" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!loading && items.length > 0 && (
        <div class="secret-list">
          {items.map((p) => (
            <div class={`secret-card${p.enabled ? '' : ' redact-off'}`} key={p.id}>
              <div class="secret-card-main">
                <div class="secret-name">
                  <code>
                    /{p.pattern}/{p.flags}
                  </code>
                </div>
                <div class="secret-meta">
                  <span class="secret-scope">→ «{p.label}»</span>
                  {!p.enabled && <span>Disabled</span>}
                </div>
              </div>
              <div class="secret-card-actions">
                <button class="btn outline sm" onClick={() => void toggle(p)}>
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="icon-btn" title="Edit" onClick={() => openEdit(p)}>
                  <IconPencil size={14} />
                </button>
                <button class="icon-btn" title="Delete" onClick={() => void del(p.id)}>
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Site scripts management page (persistent ad-block/enhance): list persistent per-site rules
 * with enable/disable + delete — the user's visibility + control surface for what
 * they or the agent registered. Mirrors the unified item-card pattern. */
function SiteScriptsSection(): preact.JSX.Element {
  const [items, setItems] = useState<SiteScript[]>([]);
  const [runnable, setRunnable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [fLabel, setFLabel] = useState('');
  const [fMatches, setFMatches] = useState('');
  const [fSelectors, setFSelectors] = useState('');
  const [fCss, setFCss] = useState('');
  const [fJs, setFJs] = useState('');
  const [formErr, setFormErr] = useState('');
  const showToast = useContext(ToastContext);

  async function reload(): Promise<void> {
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'LIST_SITE_SCRIPTS',
      } satisfies ListSiteScriptsReq)) as ListSiteScriptsResp | undefined;
      setItems(r?.scripts ?? []);
      setRunnable(r?.runnable ?? true);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }
  useEffect(() => {
    void reload();
  }, []);

  function toggle(id: string, enabled: boolean): void {
    setItems((cur) => cur.map((s) => (s.id === id ? { ...s, enabled } : s)));
    void chrome.runtime
      .sendMessage({
        type: 'SET_SITE_SCRIPT_ENABLED',
        id,
        enabled,
      } satisfies SetSiteScriptEnabledReq)
      .catch(() => {});
  }
  function del(id: string): void {
    setItems((cur) => cur.filter((s) => s.id !== id));
    void chrome.runtime
      .sendMessage({ type: 'DELETE_SITE_SCRIPT', id } satisfies DeleteSiteScriptReq)
      .catch(() => {});
  }

  const splitLines = (t: string): string[] =>
    t
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);
  function resetForm(): void {
    setAddOpen(false);
    setAdvOpen(false);
    setFLabel('');
    setFMatches('');
    setFSelectors('');
    setFCss('');
    setFJs('');
    setFormErr('');
  }
  async function submitAdd(): Promise<void> {
    setFormErr('');
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'CREATE_SITE_SCRIPT',
        input: {
          label: fLabel.trim() || undefined,
          matches: splitLines(fMatches),
          hideSelectors: splitLines(fSelectors),
          css: fCss.trim() || undefined,
          js: fJs.trim() || undefined,
        },
      } satisfies CreateSiteScriptReq)) as SiteScriptMutResp | undefined;
      if (!r?.script) {
        setFormErr(r?.error || 'Creation failed');
        return;
      }
      resetForm();
      await reload();
      showToast('Site script created');
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    }
  }
  function doExport(): void {
    downloadText(
      `web-site-scripts-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(items, null, 2),
    );
  }
  async function doImport(file: File): Promise<void> {
    try {
      const parsed = JSON.parse(await file.text());
      const scripts = Array.isArray(parsed) ? parsed : [parsed];
      const r = (await chrome.runtime.sendMessage({
        type: 'IMPORT_SITE_SCRIPTS',
        scripts,
      } satisfies ImportSiteScriptsReq)) as ImportSiteScriptsResp | undefined;
      await reload();
      showToast(`Imported ${r?.imported ?? 0}${r?.failed ? `, ${r.failed} failed` : ''}`);
    } catch {
      showToast('Import failed: the file is not valid JSON');
    }
  }

  return (
    <div class="ss-page">
      <p class="page-intro">
        Persistent site scripts: on every visit to a matching site, automatically <b>hide</b> the elements you specify (ad-block / de-noise). Created by you, or by the agent (say "block ads on site X").
        This is cosmetic hiding — it doesn't block network requests or save bandwidth; you can disable / delete it here anytime.
      </p>

      {!addOpen && (
        <div class="page-actions">
          <button class="add-btn" onClick={() => setAddOpen(true)}>
            <IconPlus size={15} /> New rule
          </button>
          {items.length > 0 && (
            <button class="btn outline" onClick={doExport}>
              <IconDownload size={14} /> Export
            </button>
          )}
          <label class="btn outline" style={{ cursor: 'pointer' }}>
            <IconUpload size={14} /> Import
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) void doImport(f);
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </label>
        </div>
      )}

      {addOpen && (
        <div class="memory-add">
          <input
            class="memory-input"
            placeholder="Rule name (optional), e.g. '知乎 ad-block'"
            value={fLabel}
            onInput={(e) => setFLabel((e.target as HTMLInputElement).value)}
          />
          <textarea
            class="memory-input"
            rows={2}
            placeholder="Match sites (one per line), e.g. https://*.zhihu.com/*"
            value={fMatches}
            onInput={(e) => setFMatches((e.target as HTMLTextAreaElement).value)}
          />
          <textarea
            class="memory-input"
            rows={3}
            placeholder="CSS selectors to hide (one per line), e.g. .ad-banner"
            value={fSelectors}
            onInput={(e) => setFSelectors((e.target as HTMLTextAreaElement).value)}
          />
          <button class="link-btn" onClick={() => setAdvOpen((v) => !v)}>
            {advOpen ? 'Hide advanced' : 'Advanced: inject CSS / JS'}
          </button>
          {advOpen && (
            <>
              <textarea
                class="memory-input"
                rows={2}
                placeholder="Raw CSS (optional, restyle/dark-mode, e.g. html{filter:invert(1)})"
                value={fCss}
                onInput={(e) => setFCss((e.target as HTMLTextAreaElement).value)}
              />
              <textarea
                class="memory-input"
                rows={2}
                placeholder="⚠️ Raw JS (optional, high-risk, runs on every visit)"
                value={fJs}
                onInput={(e) => setFJs((e.target as HTMLTextAreaElement).value)}
              />
            </>
          )}
          {formErr && <div style={{ color: '#c0392b', fontSize: 13 }}>{formErr}</div>}
          <div class="page-actions">
            <button class="btn tonal" onClick={() => void submitAdd()}>
              Save & enable
            </button>
            <button class="btn outline" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!runnable && (
        <div
          style={{
            margin: '0 0 12px',
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(245,166,35,0.14)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          You need to turn on this extension's "Allow user scripts" toggle in <code>chrome://extensions</code> for the rules to take effect.
        </div>
      )}
      {loading ? (
        <div class="empty-state">
          <div class="empty-title">Loading…</div>
        </div>
      ) : items.length === 0 ? (
        <div class="empty-state">
          <div class="empty-glyph">
            <IconSparkle size={22} />
          </div>
          <div class="empty-title">No site scripts yet</div>
          <div class="empty-hint">
            Ask the agent to "block ads on a site" to create a persistent rule; view / disable / delete it here.
          </div>
        </div>
      ) : (
        <ul class="item-list">
          {items.map((s) => {
            const open = openId === s.id;
            const hideCount = s.hideSelectors?.length ?? 0;
            return (
              <li
                key={s.id}
                class={`item-card ${open ? 'open' : ''} ${s.enabled ? '' : 'disabled'}`}
              >
                <button
                  class="item-head"
                  onClick={() => setOpenId(open ? null : s.id)}
                  aria-expanded={open}
                >
                  <span class="item-glyph">
                    <IconSparkle size={16} />
                  </span>
                  <span class="item-main">
                    <span class="item-title">{s.label}</span>
                    <span class="item-sub">
                      <span class="item-sub-text">{s.matches.join(', ')}</span>
                    </span>
                  </span>
                  <span class="item-meta">
                    {s.enabled ? '' : 'Disabled · '}
                    Hide {hideCount}
                    {s.css ? ' · CSS' : ''}
                    {s.js ? ' · JS' : ''}
                  </span>
                  <IconChevronDown size={16} class="item-chevron" />
                </button>
                {open && (
                  <div class="item-body">
                    <div class="item-text">
                      {[
                        hideCount > 0 ? `Hide selectors:\n${s.hideSelectors!.join('\n')}` : '',
                        s.css ? `CSS:\n${s.css}` : '',
                        s.js ? `⚠️ JS:\n${s.js}` : '',
                      ]
                        .filter(Boolean)
                        .join('\n\n') || '(empty)'}
                    </div>
                    <div class="item-actions">
                      <button class="btn sm tonal" onClick={() => toggle(s.id, !s.enabled)}>
                        {s.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button class="btn sm danger spacer" onClick={() => del(s.id)}>
                        <IconTrash size={13} /> Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Long-term memory management page (R4): list + delete saved user facts. */
function MemorySection(): preact.JSX.Element {
  const [state, setState] = useState<MemoryState>({ enabled: true, content: '', updatedAt: 0 });
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const showToast = useContext(ToastContext);

  function apply(s: MemoryState | null): void {
    if (!s) return;
    setState(s);
    setDraft(s.content);
    setDirty(false);
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'GET_MEMORY',
        } satisfies GetMemoryReq)) as MemoryStateResp | undefined;
        if (alive && r?.state) apply(r.state);
      } catch {
        /* keep defaults */
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function toggleEnabled(enabled: boolean): Promise<void> {
    setState((s) => ({ ...s, enabled }));
    const r = (await chrome.runtime
      .sendMessage({ type: 'SET_MEMORY_ENABLED', enabled } satisfies SetMemoryEnabledReq)
      .catch(() => null)) as MemoryStateResp | null;
    if (r?.state) apply(r.state);
  }

  async function saveDraft(): Promise<void> {
    const r = (await chrome.runtime
      .sendMessage({ type: 'SET_MEMORY', content: draft } satisfies SetMemoryReq)
      .catch(() => null)) as MemoryStateResp | null;
    if (r?.state) {
      apply(r.state);
      showToast('Memory saved');
    }
  }

  async function runInstruction(): Promise<void> {
    const instr = instruction.trim();
    if (!instr || busy) return;
    setBusy(true);
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'EDIT_MEMORY_LLM',
        instruction: instr,
      } satisfies EditMemoryLlmReq)) as EditMemoryLlmResp | undefined;
      if (r?.state) {
        apply(r.state);
        setInstruction('');
        showToast('Memory updated');
      } else {
        showToast(r?.error ?? 'Update failed, please retry');
      }
    } catch {
      showToast('Update failed, please retry');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="memory-page">
      <p class="page-intro">
        A single-document <b>long-term memory</b> about you, injected as context at the start of every conversation. You can edit it directly, or use one sentence below to have
        the AI "add / update" it for you.
      </p>

      <label class="memory-enable">
        <span class="memory-enable-label">
          <b>Enable memory</b>
          <span class="memory-enable-sub">When off, it's neither injected as context nor written to</span>
        </span>
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => void toggleEnabled((e.target as HTMLInputElement).checked)}
        />
      </label>

      {loading ? (
        <div class="memory-empty">Loading…</div>
      ) : (
        <>
          <textarea
            class="memory-input big"
            rows={16}
            disabled={!state.enabled}
            placeholder="Write down what you'd like me to remember long-term, e.g.: 'I live in Hangzhou', 'keep answers concise', 'I'm building a product called X'…"
            value={draft}
            onInput={(e) => {
              setDraft((e.target as HTMLTextAreaElement).value);
              setDirty(true);
            }}
          />
          <div class="memory-doc-actions">
            <button class="btn primary sm" disabled={!dirty} onClick={() => void saveDraft()}>
              Save
            </button>
            {dirty && (
              <button
                class="btn sm outline"
                onClick={() => {
                  setDraft(state.content);
                  setDirty(false);
                }}
              >
                Revert
              </button>
            )}
            <button
              class="btn sm outline spacer"
              disabled={!state.content.trim()}
              title="Export as Markdown"
              onClick={() => {
                downloadText(
                  `web-memory-${new Date().toISOString().slice(0, 10)}.md`,
                  renderMemoryExport(state),
                );
                showToast('Memory exported');
              }}
            >
              <IconDownload size={14} /> Export
            </button>
          </div>

          <div class="memory-addupdate">
            <textarea
              class="memory-instruction"
              rows={2}
              disabled={!state.enabled || busy}
              placeholder="Add or update — one sentence to have the AI update your memory, e.g. 'remember I switched to Beijing time'"
              value={instruction}
              onInput={(e) => setInstruction((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  void runInstruction();
                }
              }}
            />
            <button
              class="btn primary sm"
              disabled={!state.enabled || busy || !instruction.trim()}
              onClick={() => void runInstruction()}
            >
              {busy ? 'Updating…' : 'Let AI update'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Skills page — CRUD for single-file markdown skills. Each skill has a name + a
 * one-line description + a body edited in the shared `/`-palette CommandEditor
 * (tools / adapters / workflows insertable via ⟦tool:..⟧). Skills are advertised
 * to the agent (name+description) and loaded on demand via use_skill; also
 * insertable into the composer here. Mirrors ShortcutsSection. */
function SkillsSection({
  skills,
  onInsert,
  getCommands,
}: {
  skills: Skill[];
  onInsert: (s: Skill) => void;
  getCommands: () => { shortcuts: CommandItem[]; skills: CommandItem[]; tools: CommandItem[] };
}): preact.JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const bodyApi = useRef<CommandEditorHandle | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  // The editor isn't mounted until formOpen flips true, so seed its content from
  // an effect once it mounts (same pattern as ShortcutsSection).
  const pendingBody = useRef('');

  useEffect(() => {
    if (!formOpen) return;
    bodyApi.current?.clear();
    if (pendingBody.current) bodyApi.current?.insertTextWithTokens(pendingBody.current);
    formRef.current?.scrollIntoView({ block: 'nearest' });
  }, [formOpen, editingId]);

  function resetForm(): void {
    setEditingId(null);
    setFormOpen(false);
    setName('');
    setDescription('');
    setBody('');
    pendingBody.current = '';
    bodyApi.current?.clear();
  }

  function openNew(): void {
    setEditingId(null);
    setName('');
    setDescription('');
    setBody('');
    pendingBody.current = '';
    setFormOpen(true);
  }

  function startEdit(s: Skill): void {
    setEditingId(s.id);
    setName(s.name);
    setDescription(s.description);
    setBody(s.body);
    pendingBody.current = s.body;
    setFormOpen(true);
  }

  async function save(): Promise<void> {
    const b = (bodyApi.current?.getValue() ?? body).trim();
    const n = name.trim();
    if (!n || !b) return;
    await saveSkill({
      id: editingId ?? makeSkillId(),
      name: n,
      description: description.trim(),
      body: b,
    });
    resetForm();
  }

  return (
    <div class="memory-section">
      <p class="page-intro">
        A <b>skill</b> is a reusable single-file playbook (like a Claude Code skill): spell out "how to handle a certain kind of task".
        The AI sees each skill's <b>name + purpose</b> and auto-loads the body to follow it when relevant; you can also click "Insert" to fill the body into the input box. Use
        <code>/</code> in the body to insert <b>tools / adapters / workflows</b>.
      </p>

      {!formOpen && skills.length > 0 && (
        <button class="add-btn" onClick={openNew}>
          <IconPlus size={15} /> New skill
        </button>
      )}

      {formOpen && (
        <div class="shortcut-new" ref={formRef}>
          {editingId && <div class="shortcut-edit-tag">Editing "{name || '…'}"</div>}
          <input
            class="shortcut-name-input"
            placeholder="Skill name (required, search it with /)"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <input
            class="shortcut-name-input"
            placeholder="One-line purpose (tell the AI when to use it)"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
          />
          <div class="shortcut-prompt-field big">
            <CommandEditor
              apiRef={bodyApi}
              placeholder="Skill body (markdown), spell out the steps; type / to insert tools/adapters/workflows"
              getCommands={() => {
                const all = getCommands();
                return { shortcuts: all.shortcuts, skills: [], tools: all.tools };
              }}
              onChange={setBody}
            />
          </div>
          <div class="shortcut-form-actions">
            <button
              class="btn primary"
              disabled={!name.trim() || !body.trim()}
              onClick={() => void save()}
            >
              {editingId ? 'Save changes' : 'Add'}
            </button>
            <button class="btn outline" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {skills.length === 0
        ? !formOpen && (
            <div class="empty-state">
              <div class="empty-glyph">
                <IconFile size={22} />
              </div>
              <div class="empty-title">No skills yet</div>
              <div class="empty-hint">
                Write "how to handle a certain kind of task" into a playbook; the AI auto-loads and follows it when relevant — or summon it with / in the input box.
              </div>
              <button class="btn tonal" onClick={openNew}>
                <IconPlus size={14} /> New skill
              </button>
            </div>
          )
        : (
            <ul class="item-list">
              {skills.map((s) => {
                const open = expandedId === s.id;
                return (
                  <li key={s.id} class={`item-card ${open ? 'open' : ''}`}>
                    <button
                      class="item-head"
                      onClick={() => setExpandedId(open ? null : s.id)}
                      aria-expanded={open}
                    >
                      <span class="item-glyph">
                        <IconFile size={16} />
                      </span>
                      <span class="item-main">
                        <span class="item-title">{s.name}</span>
                        <span class="item-sub">
                          <span class="item-sub-text">
                            {s.description ||
                              tokensToDisplay(s.body).replace(/\s+/g, ' ').trim() ||
                              '(empty)'}
                          </span>
                        </span>
                      </span>
                      <IconChevronDown size={16} class="item-chevron" />
                    </button>
                    {open && (
                      <div class="item-body">
                        <div class="item-text">{tokensToDisplay(s.body).trim() || '(empty)'}</div>
                        <div class="item-actions">
                          <button class="btn sm tonal" onClick={() => onInsert(s)}>
                            <IconCornerDownLeft size={14} /> Insert
                          </button>
                          <button class="btn sm outline" onClick={() => startEdit(s)}>
                            <IconPencil size={13} /> Edit
                          </button>
                          <button
                            class="btn sm danger spacer"
                            onClick={() => {
                              if (s.id === editingId) resetForm();
                              void deleteSkill(s.id);
                            }}
                          >
                            <IconTrash size={13} /> Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
    </div>
  );
}

/** Trigger a text-file download from the panel (notes / memory export). */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const NOTE_SOURCE_LABEL: Record<Note['source'], string> = {
  user: 'Manual',
  agent: 'Agent',
  reply: 'Saved reply',
};

function NotesSection(): preact.JSX.Element {
  const [items, setItems] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [query, setQuery] = useState('');
  const showToast = useContext(ToastContext);
  const sel = useSelection();

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'LIST_NOTES',
        } satisfies ListNotesReq)) as ListNotesResp | undefined;
        if (alive) setItems(r?.notes ?? []);
      } catch {
        if (alive) setItems([]);
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  function del(id: string): void {
    void chrome.runtime
      .sendMessage({ type: 'DELETE_NOTE', id } satisfies DeleteNoteReq)
      .catch(() => {});
    setItems((cur) => cur.filter((n) => n.id !== id));
  }

  async function saveNote(id: string, title: string, content: string): Promise<void> {
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'UPDATE_NOTE',
        id,
        title,
        content,
      } satisfies UpdateNoteReq)) as NoteMutResp | undefined;
      if (r?.note) setItems((cur) => cur.map((n) => (n.id === id ? r.note! : n)));
    } catch {
      /* ignore — leave list as-is */
    }
  }

  async function add(): Promise<void> {
    const content = draftContent.trim();
    if (!content) return;
    try {
      const r = (await chrome.runtime.sendMessage({
        type: 'ADD_NOTE',
        title: draftTitle.trim() || undefined,
        content,
        source: 'user',
      } satisfies AddNoteReq)) as NoteMutResp | undefined;
      if (r?.note) {
        setItems((cur) => [r.note!, ...cur]);
        setDraftTitle('');
        setDraftContent('');
        setAddOpen(false);
      }
    } catch {
      /* ignore */
    }
  }

  const shown = matchNotes(items, query);

  return (
    <div class="memory-page">
      <p class="page-intro">
        Notes are stored and rendered as <b>Markdown</b> and are <b>never injected</b> into the conversation context —
        the agent only reads/writes notes when you explicitly ask (tool: <b>notes</b>). "Save as note" under a reply also stores here.
      </p>

      {!addOpen && !sel.selMode && (
        <div class="page-actions">
          <button class="add-btn" onClick={() => setAddOpen(true)}>
            <IconPlus size={15} /> Add note
          </button>
          {items.length > 0 && (
            <button
              class="btn outline export-btn"
              title="Select and export (Markdown)"
              onClick={() => sel.setSelMode(true)}
            >
              <IconDownload size={14} /> Export
            </button>
          )}
        </div>
      )}
      {sel.selMode && (
        <ExportSelectBar
          total={items.length}
          selectedCount={sel.selected.size}
          onToggleAll={() =>
            sel.selected.size >= items.length ? sel.clear() : sel.selectIds(items.map((n) => n.id))
          }
          onExport={() => {
            const chosen = items.filter((n) => sel.selected.has(n.id));
            if (!chosen.length) return;
            downloadText(
              `web-notes-${new Date().toISOString().slice(0, 10)}.md`,
              renderNotesExport(chosen),
            );
            showToast(`Exported ${chosen.length} note(s)`);
            sel.exit();
          }}
          onCancel={sel.exit}
        />
      )}
      {addOpen && (
        <div class="memory-add">
          <input
            class="memory-input note-title-input"
            placeholder="Title (optional; taken from the first line if omitted)"
            value={draftTitle}
            onInput={(e) => setDraftTitle((e.target as HTMLInputElement).value)}
          />
          <textarea
            class="memory-input"
            rows={12}
            autoFocus
            placeholder="Body, Markdown supported (plain text; use link syntax ![](url) for images)…"
            value={draftContent}
            onInput={(e) => setDraftContent((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add();
            }}
          />
          <div class="shortcut-form-actions">
            <button class="btn primary" disabled={!draftContent.trim()} onClick={() => void add()}>
              Add
            </button>
            <button
              class="btn outline"
              onClick={() => {
                setAddOpen(false);
                setDraftTitle('');
                setDraftContent('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {items.length > 0 && !sel.selMode && (
        <div class="history-search">
          <IconSearch size={15} class="history-search-icon" />
          <input
            class="history-search-input"
            type="search"
            placeholder="Search notes…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
      )}

      {loading ? (
        <div class="memory-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div class="empty-state">
          <div class="empty-glyph">
            <IconNote size={22} />
          </div>
          <div class="empty-title">No notes yet</div>
          <div class="empty-hint">
            Add one manually, have the agent jot it down ("save this to my notes"), or use the "Save as note" button under a reply.
          </div>
          <button class="btn tonal" onClick={() => setAddOpen(true)}>
            <IconPlus size={14} /> Add note
          </button>
        </div>
      ) : shown.length === 0 ? (
        <div class="empty-state">
          <div class="empty-glyph">
            <IconSearch size={22} />
          </div>
          <div class="empty-title">No matching notes</div>
          <div class="empty-hint">Try a different keyword.</div>
        </div>
      ) : sel.selMode ? (
        <ul class="memory-list select-mode">
          {items.map((n) => (
            <li
              key={n.id}
              class={`memory-item note-item selectable ${sel.selected.has(n.id) ? 'selected' : ''}`}
              onClick={() => sel.toggle(n.id)}
            >
              <span class="sel-check">{sel.selected.has(n.id) && <IconCheck size={13} />}</span>
              <div class="note-head">
                <div class="note-title">{n.title}</div>
                <div class="note-meta">{noteExcerpt(n.content, 80)}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul class="memory-list">
          {shown.map((n) => (
            <NoteRow key={n.id} n={n} query={query} onSave={saveNote} onDelete={del} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One note card. Collapsed: title + meta + plain-text excerpt (search keywords
 * highlighted via <mark>). Expanded: the full body rendered as Markdown. Tap the
 * title/excerpt (or Expand) to toggle. Edit/Delete reuse the memory card's action overlay,
 * revealed on hover, when the card is expanded, AND always on touch (see
 * .memory-hover-actions) — so it's never hover-only on the narrow panel. */
function NoteRow({
  n,
  query,
  onSave,
  onDelete,
}: {
  n: Note;
  query: string;
  onSave: (id: string, title: string, content: string) => Promise<void> | void;
  onDelete: (id: string) => void;
}): preact.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(n.title);
  const [draftContent, setDraftContent] = useState(n.content);

  function startEdit(): void {
    setDraftTitle(n.title);
    setDraftContent(n.content);
    setEditing(true);
  }
  async function save(): Promise<void> {
    const content = draftContent.trim();
    if (!content) return;
    setEditing(false);
    await onSave(n.id, draftTitle.trim(), content);
  }

  if (editing) {
    return (
      <li class="memory-item editing">
        <input
          class="memory-input note-title-input"
          placeholder="Title"
          value={draftTitle}
          onInput={(e) => setDraftTitle((e.target as HTMLInputElement).value)}
        />
        <textarea
          class="memory-input"
          rows={12}
          value={draftContent}
          autoFocus
          onInput={(e) => setDraftContent((e.target as HTMLTextAreaElement).value)}
        />
        <div class="shortcut-form-actions">
          <button
            class="btn primary sm"
            disabled={!draftContent.trim()}
            onClick={() => void save()}
          >
            Save
          </button>
          <button class="btn sm outline" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li class={`memory-item note-item ${expanded ? 'expanded' : ''}`}>
      <div class="note-head" onClick={() => setExpanded((v) => !v)}>
        <div class="note-title">{highlightMatches(n.title, query)}</div>
        <div class="note-meta">
          {new Date(n.updatedAt).toLocaleDateString()} · {NOTE_SOURCE_LABEL[n.source] ?? n.source}
        </div>
      </div>
      {expanded ? (
        <Markdown text={n.content} className="note-body" />
      ) : (
        <div class="memory-text clamp" style="cursor:pointer" onClick={() => setExpanded(true)}>
          {highlightMatches(noteExcerpt(n.content, 240), query)}
        </div>
      )}
      <button class="memory-expand" onClick={() => setExpanded((v) => !v)}>
        <IconChevronDown size={13} class="memory-chevron" />
        {expanded ? 'Collapse' : 'Expand'}
      </button>
      <div class="memory-hover-actions">
        <button class="memory-act" title="Edit" onClick={startEdit}>
          <IconPencil size={14} />
        </button>
        <button class="memory-act danger" title="Delete" onClick={() => onDelete(n.id)}>
          <IconTrash size={14} />
        </button>
      </div>
    </li>
  );
}

/** Catch a render throw in `children` and show the error inline instead of
 * silently failing (a throw in PlanApprovalCard would otherwise leave the card
 * invisible and freeze the whole tree). Kept around the approval card — a
 * required interaction — so a future render bug surfaces visibly, not silently. */
class RenderBoundary extends Component<
  { label: string; children: preact.ComponentChildren },
  { err: string | null }
> {
  state = { err: null as string | null };
  static getDerivedStateFromError(err: unknown): { err: string } {
    return { err: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  }
  componentDidCatch(err: unknown): void {
    console.error('[web:panel] render error in', this.props.label, err);
  }
  render(): preact.ComponentChildren {
    if (this.state.err) {
      return (
        <div
          style={{
            border: '1px solid var(--err)',
            background: '#fdecea',
            color: '#900',
            borderRadius: 8,
            padding: 10,
            margin: '4px 0',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          ⚠️ {this.props.label} render error: {this.state.err}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Plan-approval card (Phase 2 plan mode). Mirrors WriteConfirmCard. Shows the
 * proposed goal + steps (editable, one per line) and approve / cancel. */
function PlanApprovalCard({
  req,
  onDecide,
}: {
  req: PlanDecisionReq;
  onDecide: (decision: 'approve' | 'reject', editedSteps?: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const original = req.plan.steps.map((s) => s.title);
  const [text, setText] = useState(original.join('\n'));
  const edited = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const changed = edited.length !== original.length || edited.some((l, i) => l !== original[i]);
  const sites = planSites([req.plan.goal ?? '', ...original].join(' '));
  return (
    <div class="plan-card">
      <div class="plan-card-head">
        <IconList size={16} />
        <span>Plan</span>
      </div>
      <div class="plan-card-body">
        {req.plan.goal && <div class="plan-goal">{req.plan.goal}</div>}
        {sites.length > 0 && (
          <>
            <div class="plan-sec">Sites involved</div>
            <div class="plan-sites">
              {sites.map((s) => (
                <span key={s} class="plan-site">
                  <IconGlobe size={13} />
                  {s}
                </span>
              ))}
            </div>
          </>
        )}
        <div class="plan-sec">Steps</div>
        {editing ? (
          <textarea
            class="plan-edit"
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            rows={Math.max(3, edited.length)}
            title="One step per line"
          />
        ) : (
          <ol class="plan-steps">
            {req.plan.steps.map((s, i) => (
              <li key={i}>
                <span class="plan-num">{i + 1}</span>
                <span>{s.title}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div class="plan-actions">
        {editing ? (
          <>
            <button
              class="plan-btn primary"
              disabled={edited.length === 0}
              onClick={() => onDecide('approve', changed ? edited : undefined)}
            >
              Run with the edited plan
            </button>
            <button class="plan-btn" onClick={() => setEditing(false)}>
              Back
            </button>
          </>
        ) : (
          <>
            <button class="plan-btn primary" onClick={() => onDecide('approve')}>
              Approve<span class="kbd">⏎</span>
            </button>
            <button class="plan-btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button class="plan-btn ghost" onClick={() => onDecide('reject')}>
              Cancel
            </button>
          </>
        )}
      </div>
      <div class="plan-foot">Only the items listed above will be used; you'll be asked again before visiting other sites / write operations.</div>
    </div>
  );
}

/** Live plan/todo checklist (Phase 1). Re-renders in place on every PLAN_UPDATED
 * event. Persistent + toggle-able (the user can collapse it anytime, the agent
 * keeps it as its running plan). Inline-styled so it needs no CSS additions. */
function PlanChecklist({
  plan,
  open,
  onToggle,
}: {
  plan: PlanState;
  open: boolean;
  onToggle: () => void;
}): preact.JSX.Element {
  const completed = plan.steps.filter((s) => s.status === 'completed').length;
  const skipped = plan.steps.filter((s) => s.status === 'skipped').length;
  const failed = plan.steps.filter((s) => s.status === 'failed').length;
  const extra = [skipped ? `${skipped} skipped` : '', failed ? `${failed} failed` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    // .msg.assistant: same bubble bg as the final answer (and the Explore-results card)
    // — the plan is agent output, visually distinct from the flat timeline rows.
    <div class="msg assistant plan-checklist">
      <div
        style={{
          fontWeight: 600,
          marginBottom: open ? 4 : 0,
          opacity: 0.85,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={onToggle}
      >
        <span>
          📋 Plan {completed}/{plan.steps.length}
          {extra ? ` (${extra})` : ''}
          {plan.goal ? ` · ${plan.goal}` : ''}
        </span>
        <IconChevronDown size={13} class={`tl-chev ${open ? 'open' : ''}`} />
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: open ? 'block' : 'none' }}>
        {plan.steps.map((s, i) => {
          // Truthful per-step state: done / skipped / failed / in_progress /
          // pending are each visually distinct. docs/agent-harness.md §10.15.
          // in_progress gets a real animated spinner (same look as .tl-spin)
          // instead of a static glyph.
          const dim = s.status === 'completed' || s.status === 'skipped';
          const mark =
            s.status === 'completed'
              ? '✓'
              : s.status === 'skipped'
                ? '⊘'
                : s.status === 'failed'
                  ? '✗'
                  : '○';
          const label =
            s.status === 'in_progress' && s.activeForm
              ? s.activeForm
              : (s.status === 'skipped' || s.status === 'failed') && s.activeForm
                ? `${s.title} — ${s.activeForm}`
                : s.title;
          return (
            <li
              key={i}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                opacity: dim ? 0.55 : 1,
                color: s.status === 'failed' ? 'var(--err)' : undefined,
                padding: '1px 0',
              }}
            >
              {s.status === 'in_progress' ? (
                <span style={{ width: 14, flexShrink: 0, alignSelf: 'center' }}>
                  <span class="plan-step-spin" />
                </span>
              ) : (
                <span style={{ width: 14, flexShrink: 0 }}>{mark}</span>
              )}
              <span style={{ textDecoration: dim ? 'line-through' : 'none' }}>{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** ChatGPT-style copy: an icon-only button shown on hover BELOW a message bubble
 * (outside it). IconCopy → IconCheck for 1.2s after a copy. */
function MsgCopyButton({ text }: { text: string }): preact.JSX.Element {
  const [done, setDone] = useState(false);
  const showToast = useContext(ToastContext);
  return (
    <button
      class={`msg-copy ${done ? 'ok' : ''}`}
      title={done ? 'Copied' : 'Copy'}
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            showToast('Copied');
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {});
      }}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/** Save as note — save an assistant reply into the notebook (markdown as-is). */
function MsgSaveNoteButton({ text }: { text: string }): preact.JSX.Element {
  const [done, setDone] = useState(false);
  const showToast = useContext(ToastContext);
  return (
    <button
      class={`msg-copy ${done ? 'ok' : ''}`}
      title={done ? 'Saved as note' : 'Save as note'}
      aria-label="Save as note"
      onClick={() => {
        void chrome.runtime
          .sendMessage({
            type: 'ADD_NOTE',
            title: deriveNoteTitle(text),
            content: text,
            source: 'reply',
          } satisfies AddNoteReq)
          .then(() => {
            setDone(true);
            showToast('Saved as note');
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {});
      }}
    >
      {done ? <IconCheck size={13} /> : <IconNote size={13} />}
    </button>
  );
}

/** The page the USER is looking at (active tab of the last-focused window),
 * excluding the extension's own pages — the panel-side twin of the
 * get_active_tab tool, plus favIconUrl for the quote card. */
async function getUserActiveTab(): Promise<PageRef | null> {
  const own = chrome.runtime.getURL('');
  const pick = (tabs: chrome.tabs.Tab[]): chrome.tabs.Tab | undefined =>
    tabs.find((t) => typeof t.id === 'number' && !(t.url ?? '').startsWith(own));
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = pick(await chrome.tabs.query({ active: true, lastFocusedWindow: true }));
    if (!tab) tab = pick(await chrome.tabs.query({ active: true }));
  } catch {
    return null;
  }
  if (!tab || typeof tab.id !== 'number') return null;
  return { tabId: tab.id, title: tab.title ?? '', url: tab.url ?? '', favIconUrl: tab.favIconUrl };
}

/** Only http(s) pages are readable by the page tools (chrome:// / Web Store /
 * extension pages refuse content-script injection). */
function canReadPage(url: string): boolean {
  return /^https?:\/\//.test(url);
}

/** Immutable Map minus one key (for the per-session pending-prompt maps). */
function mapWithout<K, V>(m: Map<K, V>, k: K): Map<K, V> {
  const next = new Map(m);
  next.delete(k);
  return next;
}

/** Same pinned page: by tabId when both have one, else by url. */
function samePage(a: PageRef, b: PageRef): boolean {
  if (typeof a.tabId === 'number' && typeof b.tabId === 'number') return a.tabId === b.tabId;
  return a.url === b.url;
}

/** The read-instruction block appended to the FIRST message that carries a
 * given pinned-page set (chat with page). tab_ids are locked at pin time; the agent
 * reads via get_page_text format:"markdown" and falls back to re-opening
 * the url if the tab has since been closed. */
function buildPageChatBlock(pages: PageRef[]): string {
  const list = pages
    .map((p, i) => `${i + 1}. ${p.title ? `"${p.title}" ` : ''}${p.url} (tab_id=${p.tabId})`)
    .join('\n');
  return (
    `[Chat with page] The user added the following ${pages.length} open tab(s) to this conversation:\n${list}\n\n` +
    `First use get_page_text(tab_id=…, format="markdown") to read the body of each page above you haven't read yet ` +
    `(if a tab was closed or the read failed, use get_page_text(url=…, format="markdown") to reopen and fetch it), ` +
    `then answer the user's question based on the page content. For follow-ups, use the content already read unless the user asks to refresh the page.`
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function PageFavicon({ src, url }: { src?: string; url: string }): preact.JSX.Element {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    const letter = (hostOf(url).replace(/^www\./, '')[0] ?? '·').toUpperCase();
    return <span class="page-favicon fallback">{letter}</span>;
  }
  return <img class="page-favicon" src={src} alt="" onError={() => setBroken(true)} />;
}

/** Quote card for a page a turn refers to (favicon + title + url), rendered
 * under the user bubble in the Summarize-this-page/Chat-with-page flows and as the page-menu
 * header. Click focuses the original tab if it still exists, else re-opens the
 * url. `flat` = non-interactive (menu header). */
function PageRefCard({ page, flat }: { page: PageRef; flat?: boolean }): preact.JSX.Element {
  async function openPage(): Promise<void> {
    if (typeof page.tabId === 'number') {
      try {
        const tab = await chrome.tabs.get(page.tabId);
        await chrome.tabs.update(page.tabId, { active: true });
        if (typeof tab.windowId === 'number') {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      } catch {
        /* tab closed — fall through to re-open by url */
      }
    }
    if (page.url) void chrome.tabs.create({ url: page.url });
  }
  return (
    <button
      class={`page-ref-card ${flat ? 'flat' : ''}`}
      title={flat ? page.url : `${page.url}\nClick to open this page`}
      onClick={flat ? undefined : () => void openPage()}
    >
      <PageFavicon src={page.favIconUrl} url={page.url} />
      <span class="page-ref-main">
        <span class="page-ref-title">{page.title || hostOf(page.url) || page.url}</span>
        <span class="page-ref-url">{page.url}</span>
      </span>
    </button>
  );
}

function TurnView({
  turn,
  kind,
  showDone,
  onImage,
}: {
  turn: UiTurn;
  kind: TurnKind;
  showDone?: boolean;
  onImage?: (url: string) => void;
}) {
  if (turn.role === 'user') {
    return (
      <div class="msg-block user">
        <div class="msg user">{turn.text}</div>
        {turn.pageRefs?.map((p, i) => (
          <PageRefCard key={`${p.url}-${i}`} page={p} />
        ))}
        <div class="msg-actions">
          <MsgCopyButton text={turn.text} />
        </div>
      </div>
    );
  }
  if (turn.role === 'system') {
    if (turn.text === 'answer complete') return null; // ✓ marker is rendered before the answer instead
    return (
      <div class={`msg system ${turn.level === 'error' ? 'err' : ''}`}>
        <div>{turn.text}</div>
        {turn.detail && (
          <details class="sys-detail">
            <summary>View result</summary>
            <pre>{turn.detail}</pre>
          </details>
        )}
      </div>
    );
  }
  if (turn.role === 'tool') {
    return <TimelineToolRow trace={turn.trace} onImage={onImage} />;
  }
  if (kind === 'reasoning') {
    return <TimelineReasonRow turn={turn} />;
  }
  const looksLikeParseFailure =
    turn.commands.length === 0 &&
    !!turn.rawText &&
    /```[^\n`]*\r?\n[\s\S]*?\r?\n```/.test(turn.rawText);
  return (
    <>
      {showDone && <DoneRow />}
      <div class="msg-block assistant">
        <div class="msg assistant">
          {turn.reasoningText && (
            <details class="reasoning">
              <summary>Reasoning</summary>
              <div class="body">{turn.reasoningText}</div>
            </details>
          )}
          <Markdown text={turn.text || '(no content)'} cite />
          {turn.commands.length > 0 && (
            <details class="parsed-commands" open>
              <summary>
                Parsed {turn.commands.length} command(s)
                <span class="badges">
                  {turn.commands.map((c, i) => (
                    <span key={i} class="badge">
                      {commandLabel(c)}
                    </span>
                  ))}
                </span>
              </summary>
              <ol class="cmd-list">
                {turn.commands.map((c, i) => (
                  <li key={i}>
                    <code>
                      {c.action}
                      {c.tool ? ` ${c.tool}` : ''}
                    </code>
                    {c.args && Object.keys(c.args).length > 0 && (
                      <pre>{JSON.stringify(c.args, null, 2)}</pre>
                    )}
                    {c.action === 'parse_error' && c.message && <pre>{c.message}</pre>}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {looksLikeParseFailure && (
            <div class="warn-banner">
              ⚠️ The reply looks like it has a code block but no agent-command was parsed. Expand "Raw reply" below to compare.
            </div>
          )}
          {turn.rawText && turn.rawText !== turn.text && (
            <details class="raw-text">
              <summary>Raw reply (for debugging)</summary>
              <pre>{turn.rawText}</pre>
            </details>
          )}
        </div>
        {turn.text && (
          <div class="msg-actions">
            <MsgCopyButton text={turn.text} />
            {/* Save as note — only when the My-notes feature is on (hidden in product). */}
            {FEATURES.notes && <MsgSaveNoteButton text={turn.text} />}
          </div>
        )}
      </div>
    </>
  );
}

function commandLabel(c: import('../messages').ParsedCommand): string {
  if (c.action === 'execute_tool') return c.tool ?? 'execute_tool';
  return c.action;
}

/** Completion marker row at the end of an activity timeline. */
function DoneRow(): preact.JSX.Element {
  return (
    <div class="tl-row done">
      <span class="tl-gutter">
        <span class="tl-icon">
          <IconCheckCircle size={15} />
        </span>
      </span>
      <span class="tl-label">Done</span>
    </div>
  );
}

/** A "thinking" step in the activity timeline: the model's rationale for the
 * next move (reasoning_content) and/or its narration. Collapsible like a tool
 * row — collapsed it shows a one-line teaser; expanded it shows the full
 * thinking + narration. Default collapsed so the timeline reads as a clean
 * chain of steps rather than a wall of reasoning. */
function TimelineReasonRow({ turn }: { turn: UiAssistantTurn }): preact.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const reason = turn.text?.trim();
  // Most models emit empty content + tool_calls and put the actual rationale
  // ("why I'm calling this tool next") in reasoning_content → reasoningText.
  const thinking = turn.reasoningText?.trim();
  if (!reason && !thinking) return null;
  // Collapsed label: a one-line teaser (narration preferred, else thinking) so
  // adjacent thinking steps stay distinguishable without expanding each one.
  const preview = (reason || thinking || '').replace(/\s+/g, ' ').trim();
  return (
    <div class="tl-row reason">
      <div class="tl-head" onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer' }}>
        <span class="tl-gutter">
          <span class="tl-icon dot">
            <IconDot size={7} />
          </span>
        </span>
        <span class="tl-main">
          <span class={`tl-label think ${open ? 'open' : ''}`}>{open ? 'Thinking' : preview}</span>
        </span>
        <IconChevronDown size={13} class={`tl-chev ${open ? 'open' : ''}`} />
      </div>
      {open && (
        <div class="tl-reason">
          {thinking && <div class="tl-thinking">{thinking}</div>}
          {reason && <Markdown text={reason} />}
        </div>
      )}
    </div>
  );
}

/** One tool call as an activity-timeline row (Claude-for-Chrome-style): semantic
 * icon + concise label + optional screenshot thumb; click to expand raw
 * args/result/error. */
function TimelineToolRow({
  trace,
  onImage,
}: {
  trace: ToolTrace;
  onImage?: (url: string) => void;
}): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const act = toolActivity(trace);
  const Icon = ACTIVITY_ICON[act.icon];
  const thumb = trace.result !== undefined ? screenshotDataUrl(trace.result) : null;
  const active = trace.status === 'started';
  const failed = trace.status === 'failed';
  const hasArgs = !!trace.args && Object.keys(trace.args).length > 0;
  const hasDetail = hasArgs || trace.result !== undefined || !!trace.error;
  return (
    <div class={`tl-row tool ${active ? 'active' : ''} ${failed ? 'failed' : ''}`}>
      <div
        class="tl-head"
        onClick={() => hasDetail && setOpen((o) => !o)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
      >
        <span class="tl-gutter">
          <span class="tl-icon">
            {active ? <IconSparkle size={15} class="tl-sparkle" /> : <Icon size={15} />}
          </span>
        </span>
        <span class="tl-main">
          <span class="tl-label">
            {act.label}
            {failed ? ' (failed)' : ''}
          </span>
          {trace.tool && <span class="tl-tool">{trace.tool}</span>}
        </span>
        {thumb && (
          <img
            class="tl-thumb"
            src={thumb}
            alt="screenshot"
            onClick={(e) => {
              e.stopPropagation();
              onImage?.(thumb);
            }}
          />
        )}
        {hasDetail && <IconChevronDown size={13} class={`tl-chev ${open ? 'open' : ''}`} />}
      </div>
      {open && (
        <div class="tl-detail">
          {hasArgs && <CopyBox text={JSON.stringify(trace.args, null, 2)} />}
          {trace.error && <pre class="tl-err">{trace.error}</pre>}
          {trace.result !== undefined && !thumb && <CopyBox text={previewResult(trace.result)} />}
        </div>
      )}
    </div>
  );
}

/** A <pre> with a hover copy button in its top-right corner — used for the args
 * and result boxes in an expanded timeline step. */
function CopyBox({ text }: { text: string }): preact.JSX.Element {
  const [copied, setCopied] = useState(false);
  function copy(): void {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }
  return (
    <div class="copybox">
      <button class="copybox-btn" title="Copy" onClick={copy}>
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

// Mirror the LLM-input cap in src/agent/{api-engine,system-prompt}.ts so the
// SidePanel shows ≥ what the model actually received. Keep in sync if either
// engine bumps its `MAX_TOOL_RESULT_CHARS`.
const PREVIEW_MAX_CHARS = 64_000;

function previewResult(r: unknown): string {
  try {
    const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    return s.length > PREVIEW_MAX_CHARS
      ? s.slice(0, PREVIEW_MAX_CHARS) + `\n…[truncated ${s.length - PREVIEW_MAX_CHARS}]`
      : s;
  } catch {
    return String(r);
  }
}

/** Multi-profile LLM backend manager.
 *
 * Two view states:
 *   - 'list' (default): status card + every saved profile as a card with
 *     "Switch / Edit / Delete" + a "+ New profile" button.
 *   - editing (when `editing !== null`): the form, prefilled either with a
 *     blank new profile or an existing profile being edited.
 *
 * Source of truth is the chrome.storage profile store; this component re-loads
 * it after every mutation and pushes the **active** profile up to the parent
 * via `onSave` so the topbar status pill stays current. */
function LlmBackendSection({
  config: _config,
  onSave,
}: {
  config: LlmConfig;
  onSave: (c: LlmConfig) => void;
}) {
  const [store, setStore] = useState<LlmProfileStore>({ profiles: [], slots: {} });
  const [loading, setLoading] = useState(true);
  /** null = list view, 'new' = create form, profile = edit form prefilled. */
  const [editing, setEditing] = useState<LlmProfile | 'new' | null>(null);

  async function refresh(): Promise<void> {
    const s = await loadProfiles();
    setStore(s);
    setLoading(false);
    onSave(await loadLlmConfig());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleSetSlot(cap: Capability, id: string | null): Promise<void> {
    // Never let the user un-assign the required orchestrator while profiles exist.
    if (cap === 'primary' && !id && store.profiles.length > 0) return;
    await setSlot(cap, id);
    await refresh();
  }

  async function handleDelete(p: LlmProfile): Promise<void> {
    if (!confirm(`Delete profile "${p.label}"? This cannot be undone.`)) return;
    await deleteProfile(p.id);
    await refresh();
  }

  async function handleSave(profile: LlmProfile): Promise<void> {
    // upsertProfile auto-assigns the primary slot when none is set yet (the
    // first profile), so a fresh user is runnable without touching model assignments.
    await upsertProfile(profile);
    setEditing(null);
    await refresh();
  }

  if (editing !== null) {
    const isNew = editing === 'new';
    const blank: LlmProfile = {
      id: newProfileId(),
      label: '',
      provider: DEFAULT_CONFIG.provider,
      baseUrl: DEFAULT_CONFIG.baseUrl,
      apiKey: '',
      model: DEFAULT_CONFIG.model,
    };
    return (
      <ProfileEditForm
        initial={isNew ? blank : (editing as LlmProfile)}
        isNew={isNew}
        onSave={(p) => handleSave(p)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const primary = store.profiles.find((p) => p.id === store.slots.primary);
  const ready = !!primary?.apiKey;
  const slotShort: Record<Capability, string> = { primary: 'Main', vision: 'Vision', image: 'Image' };
  const slotsForProfile = (id: string): string[] =>
    CAPABILITIES.filter((c) => store.slots[c.id] === id).map((c) => slotShort[c.id]);

  return (
    <>
      <div class="status-card">
        <span class={`dot ${ready ? '' : 'warn'}`} />
        <div style="flex:1;min-width:0">
          <div class="label">Main model</div>
          <div class="value">{primary ? primary.label : 'Unassigned'}</div>
          {primary && (
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px">
              {providerById(primary.provider)?.label ?? primary.provider} ·{' '}
              {primary.model || '(no model set)'}
            </div>
          )}
        </div>
      </div>

      {store.profiles.length > 0 && (
        <div class="section">
          <h4>Model assignments</h4>
          <p class="section-hint">
            Assign a model to each capability. One model can serve multiple roles (e.g. a multimodal model can be both the main model and the vision model). For unconfigured capabilities, the assistant will prompt you to add one here when a task needs it.
          </p>
          {CAPABILITIES.map((cap) => (
            <div class="field" key={cap.id}>
              <label>
                {cap.label}
                {cap.required && <span style="color:var(--warn)"> *</span>}
              </label>
              <select
                value={store.slots[cap.id] ?? ''}
                onChange={(e) =>
                  void handleSetSlot(cap.id, (e.target as HTMLSelectElement).value || null)
                }
              >
                {/* The required primary keeps a placeholder only until one is
                    picked; once set it can be reassigned but not cleared. */}
                {(!cap.required || !store.slots[cap.id]) && (
                  <option value="" disabled={cap.required}>
                    {cap.required ? 'Choose…' : 'Not configured'}
                  </option>
                )}
                {store.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span class="field-hint">{cap.hint}</span>
            </div>
          ))}
        </div>
      )}

      <div class="section">
        <h4>
          API Keys
          {store.profiles.length > 0 && <span class="muted"> · {store.profiles.length}</span>}
        </h4>
        <p class="section-hint">
          Save multiple keys and assign each capability under "Model assignments" above. Keys are stored only on this machine in chrome.storage.
        </p>
        {loading ? (
          <div style="color:var(--muted);font-size:13px">Loading…</div>
        ) : store.profiles.length === 0 ? (
          <div class="empty-state">
            <div class="empty-glyph">
              <IconCog size={22} />
            </div>
            <div class="empty-title">No API Key yet</div>
            <div class="empty-hint">Add an OpenAI-compatible key to start chatting. Keys are stored only on this machine.</div>
            <button class="btn tonal" onClick={() => setEditing('new')}>
              <IconPlus size={14} /> New profile
            </button>
          </div>
        ) : (
          <div class="profile-list">
            {store.profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                slots={slotsForProfile(p.id)}
                onEdit={() => setEditing(p)}
                onDelete={() => void handleDelete(p)}
              />
            ))}
          </div>
        )}
        <div style="margin-top:14px">
          <button class="btn primary full" onClick={() => setEditing('new')}>
            <IconPlus size={15} /> New profile
          </button>
        </div>
      </div>
    </>
  );
}

function ProfileCard({
  profile,
  slots,
  onEdit,
  onDelete,
}: {
  profile: LlmProfile;
  slots: string[];
  onEdit: () => void;
  onDelete: () => void;
}): preact.JSX.Element {
  const providerLabel = providerById(profile.provider)?.label ?? profile.provider;
  return (
    <div class={`profile-card${slots.length ? ' active' : ''}`}>
      <div class="profile-card-main">
        <div class="profile-card-head">
          {slots.map((s) => (
            <span key={s} class="active-badge">
              {s}
            </span>
          ))}
          <span class="profile-card-label">{profile.label}</span>
        </div>
        <div class="profile-card-meta">
          {providerLabel} · {profile.model || '(no model set)'}
        </div>
        <div class="profile-card-key">{maskApiKey(profile.apiKey)}</div>
      </div>
      <div class="profile-card-actions">
        <button class="btn sm outline" onClick={onEdit} title="Edit this profile">
          Edit
        </button>
        <button class="btn sm outline danger" onClick={onDelete} title="Delete this profile">
          Delete
        </button>
      </div>
    </div>
  );
}

function maskApiKey(key: string): string {
  if (!key) return '(no key set)';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(8)}${key.slice(-4)}`;
}

function ProfileEditForm({
  initial,
  isNew,
  onSave,
  onCancel,
}: {
  initial: LlmProfile;
  isNew: boolean;
  onSave: (p: LlmProfile) => void;
  onCancel: () => void;
}): preact.JSX.Element {
  const [label, setLabel] = useState<string>(initial.label);
  const [provider, setProvider] = useState<string>(initial.provider);
  const [baseUrl, setBaseUrl] = useState<string>(initial.baseUrl);
  const [apiKey, setApiKey] = useState<string>(initial.apiKey);
  const [model, setModel] = useState<string>(initial.model);
  const [maxTokens, setMaxTokens] = useState<string>(
    initial.maxTokens ? String(initial.maxTokens) : '',
  );

  function pickProvider(id: string): void {
    setProvider(id);
    const p = providerById(id);
    if (p && id !== 'custom') {
      setBaseUrl(p.baseUrl);
      setModel(p.defaultModel);
    }
  }

  const maxTokensNum = Math.floor(Number(maxTokens.trim()));
  const trimmed: LlmConfig = {
    provider,
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    ...(maxTokensNum > 0 ? { maxTokens: maxTokensNum } : {}),
  };
  const effectiveLabel = label.trim() || autoLabel(trimmed);
  // Dedicated @ai-sdk/* providers bake in the base URL; only Custom (and unknown
  // legacy ids) require the user to supply one.
  const canSave =
    !!trimmed.apiKey && !!trimmed.model && (!needsBaseUrl(provider) || !!trimmed.baseUrl);

  function save(): void {
    onSave({ id: initial.id, label: effectiveLabel, ...trimmed });
  }

  return (
    <>
      <div class="section">
        <h4>{isNew ? 'New profile' : 'Edit profile'}</h4>
        <p class="section-hint">
          After picking a provider, just fill in the API Key and Model — the Base URL and API adaptation are built into the Vercel AI SDK (only custom endpoints need a Base
          URL). Keys are stored only on this machine in chrome.storage.
        </p>
        <div class="field">
          <label>Label</label>
          <input
            value={label}
            placeholder={autoLabel(trimmed)}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          />
          <span class="field-hint">If left blank, it's auto-generated as "provider · model" to help tell profiles apart in the list.</span>
        </div>
        <div class="field">
          <label>Provider</label>
          <div class="pill-row">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                class={`pill ${provider === p.id ? 'selected' : ''}`}
                onClick={() => pickProvider(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {needsBaseUrl(provider) && (
          <div class="field">
            <label>Base URL</label>
            <input
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            />
          </div>
        )}
        <div class="field">
          <label>API Key</label>
          <input
            type="password"
            value={apiKey}
            placeholder="sk-..."
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <label>Model</label>
          <input
            value={model}
            placeholder="deepseek-chat"
            onInput={(e) => setModel((e.target as HTMLInputElement).value)}
          />
          <span class="field-hint">
            Enter a model name the endpoint actually supports (e.g. deepseek-chat / gpt-4o / glm-4.6v / cogview-4).
            What the model is used for (main / vision / image generation) is assigned under "Model assignments", not here.
          </span>
        </div>
        <div class="field">
          <label>Output limit max_tokens (optional)</label>
          <input
            type="number"
            value={maxTokens}
            placeholder="4096 (default)"
            onInput={(e) => setMaxTokens((e.target as HTMLInputElement).value)}
          />
          <span class="field-hint">
            The output-token cap per reply. Increase it if answers are often cut off (shown as "output reached the limit"); the model itself must support longer output
          </span>
        </div>
      </div>

      <div class="form-footer">
        <div style="display:flex;gap:8px">
          <button class="btn outline" onClick={onCancel} style="flex:1">
            Cancel
          </button>
          <button class="btn primary" disabled={!canSave} onClick={save} style="flex:1">
            {isNew ? 'Create & enable' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}

/** History — two-level navigation:
 *   - List page (default): every persisted session as a clean card. Click → drill.
 *   - Detail sub-page: when `selectedId` is set, render the same PageOverlay
 *     but with `onBack` (← arrow) and `rightActions` ([Open]/[Delete]/[Restore]) in
 *     the header. Backdrop click + Esc pop back to the list, not to the
 *     chat — that's what `onBack` controls in PageOverlay.
 *
 * Detail data is fetched on click (`loadDetail`) — the list summaries don't
 * carry full turn history. Refetch on every drill so updates land. */
function HistoryPage({
  currentSessionId,
  onClose,
  onOpen,
  onDelete,
}: {
  currentSessionId: string | null;
  onClose: () => void;
  onOpen: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}): preact.JSX.Element {
  const [list, setList] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionState | null>(null);
  const [query, setQuery] = useState('');

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const req: ListSessionsReq = { type: 'LIST_SESSIONS' };
      const r = (await chrome.runtime.sendMessage(req)) as ListSessionsResp | undefined;
      // Collapse ⟦tool/cmd:..⟧ tokens to /NAME in the preview (snippet, search,
      // and detail title) — the SW stores the raw text.
      setList((r?.sessions ?? []).map((s) => ({ ...s, preview: tokensToDisplay(s.preview ?? '') })));
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Auto-refresh when SESSION_DONE / ASSISTANT_TURN happens — those are
    // the moments list contents change.
    const handler = (m: unknown) => {
      const t = (m as { type?: string })?.type;
      if (t === 'SESSION_DONE' || t === 'ASSISTANT_TURN') {
        void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  async function drillTo(id: string): Promise<void> {
    setSelectedId(id);
    setDetail(null);
    try {
      const req: GetSessionReq = { type: 'GET_SESSION', sessionId: id };
      const r = (await chrome.runtime.sendMessage(req)) as GetSessionResp | undefined;
      setDetail((r?.session as SessionState | null) ?? null);
    } catch {
      setDetail(null);
    }
  }

  function backToList(): void {
    setSelectedId(null);
    setDetail(null);
  }

  // ── Sub-page: one session detail ──
  if (selectedId) {
    const summary = list.find((s) => s.id === selectedId);
    const isCurrent = selectedId === currentSessionId;
    const title = summary?.preview?.trim() || 'Session details';

    return (
      <PageOverlay
        title={title}
        onClose={onClose}
        onBack={backToList}
        rightActions={
          <>
            <button
              class="btn sm outline"
              disabled={isCurrent}
              title={isCurrent ? 'Already the current session' : 'Load this session into the main chat panel to continue (context preserved)'}
              onClick={() => onOpen(selectedId)}
            >
              Continue
            </button>
            <button
              class="btn sm danger"
              disabled={isCurrent}
              title={isCurrent ? 'Can\'t delete a session in progress — use "+ New chat" first' : 'Permanently delete this session'}
              onClick={() => {
                if (confirm('Delete this history session?')) {
                  onDelete(selectedId);
                  backToList();
                }
              }}
            >
              Delete
            </button>
          </>
        }
      >
        {detail === null ? (
          <div class="hist-empty">Loading details…</div>
        ) : (
          <SessionDetailView summary={summary} session={detail} isCurrent={isCurrent} />
        )}
      </PageOverlay>
    );
  }

  // ── List page ──
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((s) => (s.preview ?? '').toLowerCase().includes(q)) : list;
  return (
    <PageOverlay title={PAGE_LABELS.history} onClose={onClose}>
      <div class="history-search">
        <IconSearch size={15} class="history-search-icon" />
        <input
          class="history-search-input"
          type="search"
          placeholder="Search history…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      {loading ? (
        <div class="hist-empty">Loading…</div>
      ) : list.length === 0 ? (
        <div class="empty-state">
          <div class="empty-glyph">
            <IconClock size={22} />
          </div>
          <div class="empty-title">No history yet</div>
          <div class="empty-hint">Your conversations are saved here automatically — revisit or "continue" anytime.</div>
        </div>
      ) : shown.length === 0 ? (
        <div class="empty-state">
          <div class="empty-glyph">
            <IconSearch size={22} />
          </div>
          <div class="empty-title">No matching sessions</div>
          <div class="empty-hint">Try a different keyword — search matches the session content preview.</div>
        </div>
      ) : (
        <>
          {q && <div class="history-count">{shown.length} matching session(s)</div>}
          <ul class="history-list">
            {shown.map((s) => {
              const isCurrent = s.id === currentSessionId;
              return (
                <li key={s.id}>
                  <button
                    class={`session-card ${isCurrent ? 'current' : ''}`}
                    onClick={() => void drillTo(s.id)}
                  >
                    <div class="row">
                      <span class={`hist-badge ${badgeClass(s.status)}`}>
                        {badgeText(s.status)}
                      </span>
                      {s.scheduleLabel && <span class="hist-badge sched">⏰ Scheduled task</span>}
                      <span class="time">{relativeTime(s.updatedAt)}</span>
                    </div>
                    <div class="preview">{highlightMatches(s.preview || '(no content)', query)}</div>
                    <div class="meta">
                      iter {s.iterations} · {s.turnCount} msgs · {s.toolCallCount} tool calls
                      {isCurrent && <span class="current-tag"> · Current session</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </PageOverlay>
  );
}

function SessionDetailView({
  summary,
  session,
  isCurrent,
}: {
  summary: SessionSummary | undefined;
  session: SessionState;
  isCurrent: boolean;
}): preact.JSX.Element {
  const status = summary?.status ?? 'idle';
  // Reuse the chat's exact turn rendering (TurnView) instead of a bespoke style.
  const uiTurns = historyToUiTurns(session.history);
  // Same plan housing as the live chat, minus the pinning (a record, not a run):
  // the checklist card sits at its last update_plan/submit_plan row, or at the
  // end when no anchor turn exists.
  const [planOpen, setPlanOpen] = useState(true);
  const plan = session.plan?.steps.length ? session.plan : null;
  const planAnchor = plan ? lastToolTurnIndex(uiTurns, PLAN_ANCHOR_TOOLS) : -1;
  const planCard = plan ? (
    <PlanChecklist plan={plan} open={planOpen} onToggle={() => setPlanOpen((o) => !o)} />
  ) : null;
  return (
    <div class="session-detail">
      <div class="meta-row">
        <span class={`hist-badge ${badgeClass(status)}`}>{badgeText(status)}</span>
        {session.schedule && <span class="hist-badge sched">⏰ Scheduled task</span>}
        <span>iter {summary?.iterations ?? '?'}</span>
        <span>·</span>
        <span>{summary?.turnCount ?? session.history.length} msgs</span>
        <span>·</span>
        <span>{summary?.toolCallCount ?? '?'} tool calls</span>
        {isCurrent && (
          <span class="current-tag" style="color:var(--accent);font-weight:600">
            · Current session
          </span>
        )}
      </div>

      <div class="messages">
        {uiTurns.length === 0 ? (
          <div class="hist-empty">(no messages)</div>
        ) : (
          uiTurns.map((t, i) => {
            const kind = classifyTurn(uiTurns, i);
            return i === planAnchor ? (
              <Fragment key={i}>{planCard}</Fragment>
            ) : (
              <TurnView
                key={i}
                turn={t}
                kind={kind}
                showDone={kind === 'answer' && hadToolActivityBefore(uiTurns, i)}
              />
            );
          })
        )}
        {planAnchor < 0 && planCard}
      </div>
    </div>
  );
}

function badgeClass(status: SessionSummary['status']): string {
  switch (status) {
    case 'running':
      return 'pending';
    case 'error':
      return 'err';
    case 'aborted':
      return 'muted';
    default:
      return 'ok';
  }
}

function badgeText(status: SessionSummary['status']): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'error':
      return 'Error';
    case 'aborted':
      return 'Aborted';
    case 'idle':
      return 'Done';
    default:
      return status;
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}


/** Translate the persisted session.history (Turn[]) into the SidePanel's
 * rendering shape (UiTurn[]). The only fiddly bit is the role name:
 * SessionState uses `'tool_trace'` while UiTurn uses `'tool'`. */
function historyToUiTurns(history: Turn[]): UiTurn[] {
  // Persisted history keeps BOTH the 'started' and the terminal snapshot of a
  // tool trace (the engine appends each). Live rendering replaces in place by
  // trace.id (onToolTrace); mirror that here — the first occurrence keeps the
  // position, the last one wins on content — so a reloaded session doesn't show
  // a ghost in-flight row next to every completed one.
  const traceAt = new Map<string, number>();
  const out: UiTurn[] = [];
  for (const t of history) {
    if (t.role === 'user') {
      // Stored text keeps the raw ⟦tool/cmd:..⟧ tokens (the agent sees those);
      // collapse them to /NAME for display, same as the live bubble. Prefer the
      // compact displayText (Summarize this page etc.) — the full prompt stays in `text`.
      out.push({
        role: 'user',
        text: tokensToDisplay(t.displayText ?? t.text),
        ...(t.pageRefs?.length ? { pageRefs: t.pageRefs } : {}),
        ts: t.ts,
      });
    } else if (t.role === 'assistant') {
      out.push({
        role: 'assistant',
        text: t.cleanedText,
        reasoningText: t.reasoningText,
        commands: t.commands,
        iteration: t.iteration,
        ts: t.ts,
      });
    } else {
      // tool_trace → 'tool'
      const at = traceAt.get(t.trace.id);
      const ui: UiTurn = { role: 'tool', trace: t.trace, ts: t.ts };
      if (at !== undefined) {
        out[at] = ui;
      } else {
        traceAt.set(t.trace.id, out.length);
        out.push(ui);
      }
    }
  }
  return out;
}
