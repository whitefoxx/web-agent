// FULL generic tool set = the lite standalone set (`_generic`) + the tools that
// only make sense in the full extension. Imported by the full service worker
// (src/background/service-worker.ts) AND the SidePanel (src/sidepanel/main.tsx),
// which both need the complete catalog. The LITE bridge shell imports
// `_generic` directly instead. Importing each module triggers its top-level
// cli({...}) registration.

// ── the standalone browser primitives (shared with the lite shell) ──
// open_url, get_page_text (dual-mode url|tab_id), web_search (query → ranked
// results), fetch_url (raw non-rendering HTTP), screenshot, scroll_page,
// close_tab, get_active_tab, list_tabs, manage_tabs (incl. back/forward),
// get_interactives, click (ref|selector|text, button/count), type_into, press_key,
// select_option, hover, drag_and_drop, file_upload, handle_dialog, find_in_page,
// get_html, query_dom, get_dom_outline, wait_for_selector, list_links.
import '@base/tools/generic/_generic';

// ── explore-only authoring tools (full shell only; the lite bridge omits them).
//    They live in ../explore/ now — the source tree mirrors the generic↔explore
//    decoupling. ──
import '../explore/_all';

// ── full-shell-only generic tools ──
// find_in_dom: value→robust-selector reverse lookup — authoring-oriented, low
// value without adapters, so it's here (not in _generic / WebCLI).
// find_in_dom is a shared-base primitive now (via _generic).
// read_more: pages through the oversize stash. That stash is written ONLY by the
// agent loop's history truncation (agent/engine-history.ts), so it is dead in the
// agent-free shell — WebCLI would list a tool whose every call fails ("expired or
// unknown id"), and its transport truncates without a stash id anyway. Full only.
import './read-more';

// ── marketplace / selection tools (full shell only) ──
// Discover site adapters on the marketplace for a task (/find-adapters command;
// also used by the agent to suggest a ready-made tool over slow generic ones).
import './find-adapters';
// Ephemeral loading (the way to use a marketplace adapter): use one THIS session
// by loading it into the registry — find_adapters → load_adapter → call.
import './load-adapter';
// Selection-toolbar highlights, read-only ("categorize and summarize all my highlights").
import './get-highlights';
