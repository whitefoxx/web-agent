# chrome-devtools-mcp vs WebCLI — what to borrow

Reference read of [`ChromeDevTools/chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(Google's official MCP server for Chrome), 2026-07-29. Sibling of
[browseract-comparison.md](./browseract-comparison.md) and
[page-agent-comparison.md](./page-agent-comparison.md); the target of the borrows
here is **WebCLI** (see [webcli.md](./webcli.md)), because that is the shell that
competes in the same slot — "an external coding agent drives a real Chrome".

## §1 Architecture, in one line each

| | chrome-devtools-mcp | WebCLI |
| --- | --- | --- |
| Process | Node MCP server over stdio | the extension itself is the provider |
| Reaches Chrome via | Puppeteer + CDP: **launches** a Chrome, or attaches to `--browser-url` / `--wsEndpoint` / `--autoConnect` (Chrome 144+) | content script / `chrome.scripting` inside the browser it lives in |
| Profile | dedicated profile by default; `--isolated` for a throwaway one | **the user's own profile**, already logged in |
| Setup cost | install a Node package, and either let it launch a Chrome or open a remote-debugging port | install from the Web Store, run the daemon |
| Center of gravity | **debugging a site you are building** — traces, heap, Lighthouse, network, console | **doing a task on sites you are logged into** |
| Tool count | ~40 across 9 categories, most behind flags | 28 (25 when this was written), all on by default — a `core` profile trims the advertised set, §6 ④ |

The two are not really competitors on capability — they are competitors on *which
Chrome the agent ends up talking to*. Their default Chrome is clean and empty; ours
is the one with the user's sessions in it. That asymmetry is the whole product
difference, and it also inverts the security calculus (§4.2).

**What we are ahead on** and should keep saying out loud: real logged-in profile,
no `--remote-debugging-port` and no "Chrome is being controlled" banner on the
generic path, one-click Web Store install, site adapters + marketplace, action
receipts (§2.1), `fetch_url {format:"markdown"}` (no tab at all).

**What they are ahead on**: everything that needs the DevTools protocol at depth
(traces, heap, Lighthouse) — deliberately not our game (§5) — plus a set of
interface-ergonomics decisions that are cheap for us to adopt and listed below.

## §2 Borrow backlog for WebCLI

> **Status (2026-07-29):** ① ② ③ ④ ⑨ are **implemented** — see §6 and
> [webcli.md](./webcli.md) §14. ⑤ ⑥ ⑦ ⑧ ⑩ ⑪ ⑫ ⑬ remain open.

### Tier 1 — cheap, and each one fixes something real

**① Screenshot cost controls — `--screenshotFormat` / `--screenshotQuality` / `--screenshotMaxWidth|Height`.**
An entire flag family exists in their CLI for one reason: a screenshot is the most
expensive thing an agent can put in its context. `screenshot.ts` returns a raw PNG
`dataUrl` with no knobs — a real-machine test measured 56 KB for `example.com`, and
a dense SERP is far worse. Add `format` (`png|jpeg|webp`), `quality`, and
`max_width` (downscale before encoding). Highest token ROI on this list, purely
local, no permissions.

**② `fill_form` — set N fields in one call.**
We only have `type_into`, one field per round-trip; a login or checkout form is
4–6 LLM turns. Their `fill_form {elements: [...]}` is one. This is a low-level DOM
batch, not orchestration, so it passes the "add primitives, not upper-layer tools"
rule ([webcli.md](./webcli.md) §2).

**③ `wait_for {text}` — wait on visible text, not a selector.**
`wait_for_selector` requires the agent to already know the DOM. Waiting for "Order
confirmed" is what an agent actually wants after a click, and it needs no probe
first. Small addition next to the existing waiter.

**④ Tool-set profiles (their `--slim` = 3 tools, plus per-category flags).**
Our 25 descriptions are re-sent on every single request of every external agent's
loop. A `core` profile (open_url / get_page_text / get_interactives / click /
type_into / press_key / scroll_page / close_tab) vs the full set, selected in
`storage.local` or by the daemon, is a pure-config change with a per-call payoff.

**⑤ `list_console_messages` — we have nothing here at all.**
Not because we want their debugging market (§5), but because "the click did
nothing" is usually answered by the page's own error. Worth having with their
ergonomics: `types` filter, `pageIdx`/`pageSize` paging, and a `pattern` regex.
Note it needs a listener installed before the messages happen — a content-script
console hook at `document_start`, or the CDP `Runtime` domain if we accept §2.2's
banner cost.

### Tier 2 — valuable, but there is a real tradeoff

**⑥ Network tools in WebCLI.** We already have `list_network` / `read_network` /
`find_in_network`, but they are **explore-only** (full shell), even though WebCLI
keeps the `debugger` permission. For an external agent, reading the page's own XHR
JSON is strictly better than parsing the rendered DOM — it is the single biggest
capability gap between the two shells. Their interface is worth copying wholesale:
paging (`pageIdx`/`pageSize`), `resourceTypes` filter, `includePreservedRequests`
across navigations, and a separate `get_network_request {reqid}` so bodies are
fetched on demand instead of dumped in the list. **Cost:** CDP attach shows Chrome's
"…is debugging this browser" bar, which our generic path deliberately avoids.

**⑦ `emulate` — viewport / userAgent / geolocation / networkConditions / colorScheme / CPU throttle.**
Real use for us: mobile-only content, region-gated content, and dark-mode pages.
But we run in the user's actual browser, so every emulation is a mutation of
something they are looking at. If adopted, it must be scoped to a tab and reverted,
never left set.

**⑧ Externalize big payloads to files** (their `filePath` on screenshot / trace /
network bodies / heap snapshots). We have a natural place for this that they don't:
the daemon runs on the same machine as the calling agent. Tool returns a path, the
agent reads it with its own file tools, nothing large ever enters the transport.
Needs a design pass on the extension→daemon file channel (downloads permission is
already held).

### Tier 3 — strategic signals

**⑨ WebMCP (`list_webmcp_tools` / `execute_webmcp_tool`) — buy the option, it is cheap.**
This is the most important thing in the repo for us. Chrome is shipping support for
**pages declaring their own agent-callable tools**. If that ecosystem takes, part of
what a site adapter does gets provided by the site itself. Read of the situation:
- Adapters stay valuable for years regardless — WebMCP covers only sites that opt
  in, marketplace covers the existing web.
- But reading a page's tool registry is an `executeScript` away — **no CDP, no new
  permission**. Shipping the pair now costs almost nothing and means we are already
  connected if the standard lands. Same for their `execute_3p_developer_tool`
  (tools a page exposes for its own devtools).

**⑩ URL allow/deny + header redaction (`--allowedUrlPattern`, `--blockedUrlPattern`, `--redactNetworkHeaders`).**
They ship these *and* still warn users not to browse sensitive sites during a
session — from a clean profile. WebCLI hands an external agent a browser that is
**already logged into the user's bank and email**, so our exposure is strictly worse
than theirs and our controls are thinner (write gates in `core/bridge-core.ts`, no
URL policy). A host allow/deny list in `storage.local`, enforced in
`execute-generic.ts` before any tool touches a tab, is the missing piece. This is a
product-level gap, not a nice-to-have.

**⑪ `--autoConnect` (Chrome 144+, discover and attach to the local Chrome after user permission).**
The platform is absorbing "let an agent reach my browser". Our moat is not the
connection — it is what is *behind* it: the real profile, zero launch flags, zero
debugging banner, store distribution. Worth stating explicitly wherever we pitch
WebCLI, because the connection half is becoming free.

**⑫ A generated `docs/tool-reference.md`.** They publish every tool's exact name,
description, and parameters, generated from source. `web-tools-skills` only has the
skill. A generated reference is what a user reads to decide whether to install, and
what an agent reads when the catalog isn't enough. Cheap — the registry is already
structured data, and `tests/webcli-tool-surface.test.ts` already walks it.

**⑬ Failure telemetry, local-only.** They collect tool success rate and latency by
default (`--usageStatistics`). We collect nothing, so `docs/tests/findings.md` is
hand-derived from real-machine runs. A **local, never-uploaded** per-tool
failure counter surfaced in the popup would tell the user *and* us which tool rots
first (SERP selectors are the known candidate). Privacy posture stays "nothing
leaves the machine".

## §3 Already covered — do not re-borrow

- **`includeSnapshot` on every action tool** (return the post-action state so the
  agent skips a re-scan) — we do this better already: `_receipt.ts` returns a *diff*
  (navigation / popup / DOM growth + `new_interactives` with fresh refs) from two
  cheap probes, instead of a full snapshot. Their version is the blunt one.
- **`navigate_page {type: back|forward|reload}`** — `manage_tabs` has all three.
- **`take_snapshot` (a11y tree) as the coordinate system** — we have `get_a11y_tree`
  (explore) and `get_interactives` + `ref`, with iframe semantics already settled
  (f735ed8). Different shape, same job.
- **`select_page` / `list_pages` / `close_page`** — `list_tabs` / `get_active_tab` /
  `close_tab` / `manage_tabs`.
- **`--experimentalPageIdRouting`** (several agents sharing one server) — we solve
  the collision by separate ports and separate installs ([webcli.md](./webcli.md) §13).

## §4 Two observations worth keeping

**4.1 Everything expensive is behind a flag.** Memory (12 tools), extensions (5),
third-party (2), WebMCP (2), vision, screencast — all off by default. A 40-tool
server presents as ~20. That is the same instinct as §2④ and it is the right
default posture for a catalog that grows.

**4.2 Their security warnings are our security requirements.** Read their limitations
section as a checklist written for a *cleaner* threat model than ours: clean profile,
opt-in remote port, redaction flags — and they still warn. Every one of those
warnings applies to WebCLI with the volume turned up, because the profile is the
user's. §2⑩ is the concrete follow-up.

## §5 Explicitly not borrowing

Performance traces + insights, heap snapshots (12 tools), Lighthouse audits,
extension install/reload/uninstall, screencast. These serve "I am building this
site and it is slow" — a real market where an official Google server that already
speaks CDP is the correct answer and we would be a worse copy. WebCLI's job is
"drive the browser I am already logged into". Staying out of this is what keeps the
25-tool catalog small enough to be cheap.

## §6 Implementation log

**2026-07-29, branch `feat/webcli-devtools-borrows`** — the five borrows that need
no CDP beyond what we already used and no new manifest permission. Design detail
lives in [webcli.md](./webcli.md) §14; this is the ledger.

| | Item | Shipped as | Note |
| --- | --- | --- | --- |
| ① | Screenshot cost controls | `format` / `quality` / `max_width` on `screenshot` | Default stayed **png** — a screenshot is mostly text, jpeg's worst case. Knobs are opt-in; the win depends on agents using them |
| ② | Batch form fill | new `fill_form` | Also covers `<select>` and checkbox/radio, which `type_into` never did |
| ③ | Wait on text | `text` arg on `wait_for_selector` | An arg, not a 29th tool — see ④ for why |
| ④ | Tool-set profiles | `core/tool-profile.ts`, `storage.local.toolProfile` | Filters the catalog only; hidden tools stay callable |
| ⑨ | WebMCP | new `list_webmcp_tools` / `call_webmcp_tool` | MAIN world; probe reports which surface answered, and separates "absent" from "present but not enumerable" |

Cost: WebCLI SW **242.3 → 267.7 KB** (+10.5%). Typecheck / lint / 2018 tests / both
builds green. The in-page halves are **not yet real-machine verified** — queued in
[tests/platform.md](./tests/platform.md).

Two things this pass confirmed about the borrow list itself:

- **The cheap items were cheap.** Four of the five are an arg, a config seam, or a
  self-contained in-page function. That is what "Tier 1" was supposed to mean, and
  it held.
- **⑤ console and ⑩ URL policy really are the next tier**, and for the same reason:
  both need something *always on* (a `document_start` hook; a gate in front of every
  tool call) rather than a new leaf. ⑨'s deliberate gap has the same shape — tools
  registered after our probe need that same always-on recorder — so if any one of
  the three gets built, the injection seam should be built once and shared.
