# Web Agent

An AI agent that lives in your browser's side panel and drives your **real,
signed-in Chrome** — it reads pages, clicks, fills forms, and works out how to
reach a site it has never seen before.

The point is the session. A headless scraper starts logged out and gets stopped
by the bot wall; this one is already you. Anything you can see, it can read;
anything you can click, it can click — and anything that would post, send or
delete stops for your confirmation first.

You bring the model: any OpenAI-compatible endpoint (DeepSeek, OpenAI, GLM,
Kimi, a self-hosted vLLM…), configured in the panel. There is no key in this
repo and no server of ours anywhere in the path.

> **Status: not released.** The full extension has never been on the Chrome Web
> Store. Its two agent-free siblings have — see below. Build it and load it
> unpacked if you want to run it.

## One base, three shells

The browser primitives are not in this repo. They live in
**[`web-tools`](https://github.com/whitefoxx/web-tools)**, mounted here as a git
submodule and shared by three extensions:

| | what it is | built from |
| --- | --- | --- |
| **Web Agent** | this repo — the base **plus** an agent: side panel, planning, adapters, an explore mode that reverse-engineers a site while you watch | here (`npm run build` → `dist/`) |
| **WebCLI** | headless and agent-free; exposes the same primitives to a CLI agent (Claude Code, Codex, …) over a local daemon | `web-tools` |
| **localmd Connect** | the companion for [localmd.app](https://localmd.app); the base plus knowledge-base capture, highlights, and an in-page toolbar | `web-tools` |

The split is physical: nothing in the base may import the full shell, so a
capability that belongs to everyone gets built once. `@base/*` resolves into the
submodule (`web-tools/src/*`); the alias is declared in `vite.config.ts`,
`tsconfig.json` and `vitest.config.ts`, and those three copies must agree.

## Build

```sh
git clone --recursive https://github.com/whitefoxx/web-agent.git
cd web-agent
npm install
npm run build          # → dist/  (load unpacked in chrome://extensions)
npm test               # the full shell's suite
npm run check          # typecheck + lint + format + test
```

Already cloned without `--recursive`? `git submodule update --init --recursive`.

**Chrome 138+** is needed for user-script-world adapters and site scripts, and
they additionally need *Allow user scripts* switched on in the extension's
details page — Chrome gates that API behind a switch only you can flip.
Everything else works without it.

## What it will and won't do

- **A write always stops and asks.** Posting, commenting, following, deleting,
  downloading — any tool marked `access: 'write'` raises a confirmation in the
  side panel showing exactly what it is about to do, and a prompt left
  unanswered for five minutes counts as *no*. Write tools are also kept out of
  the model's first-round tool summary, so it has to go looking before it can
  even ask.
- **It stores no credentials.** It reuses the login you already have. Your API
  key lives in `chrome.storage.local` and clearing settings clears it.
- **CDP attaches late and detaches early.** `chrome.debugger` is attached only
  for the tab a tool is working on, and released when it finishes — the yellow
  "is being debugged" bar appearing means something is running right now.
- **It backs off instead of hammering.** A captcha or a rate-limit redirect
  becomes a structured `RateLimitedError`, and the prompt tells the model not to
  retry into it.

## Known limits

- Chrome kills an idle MV3 service worker, so a long task can be cut off
  mid-flight. An open side panel keeps it alive; there is a keep-alive and a
  resume path, but the honest answer is that very long tasks are still the
  weak spot.
- Tool calls run one at a time within a round.
- Upgrading an installed marketplace adapter means uninstall + reinstall — the
  old source stays in IndexedDB until you do.

## Submodules

- **`web-tools/`** — the shared base. Edit base code **there**, push, then bump
  the pointer here.
- **`marketplace/`** — the legacy per-site adapter catalog, frozen, and
  hand-maintained (never regenerate its index). It is a read path for this shell
  only; the lean shells dropped it on 2026-09-06, because a catalogue of sites
  rots — every entry needs a checksum rotation and a real-browser re-verify each
  time a site changes its markup — and reaching a site turned out to be a skill
  an agent can build live from the primitives.

## Docs

`docs/` is the institutional memory, and it is the honest kind: post-mortems in
a **symptom / root cause / fix / lesson** shape, audits with their methodology,
and the reasoning behind decisions that look arbitrary from the outside.

- `docs/architecture.md` — start here; §A is the system-level picture.
- `docs/adapter-hot-plug.md` §10.x — the long-running bug log.
- `docs/tests/` — what has actually been verified in a real browser, and
  `findings.md`, the running record of what went wrong and why.

## Credits & history

- **[opencli](https://github.com/jackwener/opencli)** — the adapter source
  ecosystem the marketplace catalog was originally harvested from, and the
  reference for the `cli({})` adapter format this repo can still execute.
- An early version ran in **chat-tab mode**: it hijacked a logged-in DeepSeek
  page for inference, so it needed no API key at all. It was removed — carrying
  two backends (tab tracking in the worker, paused/resume banners in the UI,
  continuity recovery) cost more than it was worth, and bring-your-own-key is
  both steadier and universal. All of that code is gone.
- **xiaohongshu-operator** was the ancestor: single-site, CDP only. None of it
  survives here.

## Licence

[MIT](./LICENSE) — © 2026 Yunbiao Cheng.

Use it, change it, ship it, sell what you build with it. The marketplace
adapters derive from [opencli](https://github.com/jackwener/opencli)
(Apache-2.0) and carry that project's terms and attribution.
