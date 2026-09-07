# Adapter & tool secrets — a vault the LLM never sees

**Status:** implemented on branch `feat/page-agent-borrows` (2026-06-25).
**Code:** `src/config/secret-store.ts` (+ tests `tests/secret-store.test.ts`),
plumbing in `src/userscript/{protocol,run-in-page,runner,sw-runner}.ts`,
`src/tools/dispatcher.ts`, UI in `src/sidepanel/App.tsx` (`SecretsSection`).

## 1. The problem

Some adapters/tools need a **sensitive value at call time** — an API key, a
bearer token — that must **never enter the LLM's context**. The first case is
`weread-official/*` (and `notebooklm`, `v2ex`): ported opencli adapters that read
`process.env.WEREAD_API_KEY`. The func runtime hardcoded an empty env
(`browserProcessPolyfill` → `env:{}`), so the key never reached the adapter and
every weread-official call failed with "no API key" — even though the key + the
gateway were verified working (HTTP 200, real results).

We want a **general** mechanism (not weread-specific): user-supplied secrets,
persisted on the machine, usable as inputs to adapters/tools, but provably absent
from anything the model reads.

## 2. The constraint, and why it forces "late binding"

A secret can only leak into the model's context three ways. Each gets a
guarantee, all enforced in the service worker:

1. **The model receives the value** (in a tool result). → **Env injection** binds
   the value at execution time _in the SW → isolated world_; it's never part of
   the result. The model calls `weread-official__search {query}` and never sees a
   key. (`dispatcher.ts` → `sw-runner.ts` → `run-in-page.ts`)
2. **The model must pass it as an arg.** → The model emits a **placeholder**
   `{{secret:NAME}}`; the SW swaps in the real value _after_ the model produced
   the call, at the dispatch chokepoint. (`dispatcher.ts` `executeAdapter`)
3. **An adapter echoes it** (buggy/hostile, e.g. `"invalid key wrk-…"`). →
   **Redaction**: every result/error is deep-scrubbed of known secret values →
   `«NAME»` before it becomes a `tool` message. (`dispatcher.ts` `executeAdapter`)

The common thread: the value lives outside the agent loop and is spliced in at
the **last moment, in the service worker**. The model only ever handles a name or
a placeholder.

## 3. Where it's stored, and why not `localStorage`

The vault is **`chrome.storage.local`** under one key (`web:secrets`),
`name → {value, scope?, note?, updatedAt}`.

The user's instinct was "localStorage or IndexedDB". In MV3 that's the wrong
surface for two reasons:

- The **service worker can't read `window.localStorage`** (it's a window-only
  API). The SW is exactly where env injection / substitution / redaction run.
- The visited page's `localStorage`/`indexedDB` belong to **that site's origin** —
  the site's own JS could read a secret stashed there. Wrong trust boundary.

`chrome.storage.local` is the extension-private store the SW can read and the
page cannot. It's already where the LLM API keys live (`llm-config.ts`), so the
secrets sit at the same trust level as the model keys. Crucially, the **adapter
itself can't read the vault** either: the `USER_SCRIPT` world exposes only a
sliver of `chrome.*` (`runtime.connect/sendMessage/getURL/id`), no
`chrome.storage` — so the SW **must** push the value in, and the page never sees
it.

## 4. Mode 1 — env injection (the weread unblock)

When a func adapter runs, the SW resolves which secrets its source references and
hands them to the adapter as `process.env`:

```
dispatcher.executeAdapterInner
  └─ env = resolveEnvForSource(source, site, secrets)     # secret-store.ts
        # = { NAME: value } for every `process.env.NAME` in the source
        #   whose (optional) scope allows this site
  └─ runInstalledFuncAdapter({ …, env })                  # sw-runner.ts
        └─ INIT message { …, env }                         # protocol.ts (port msg)
              └─ runner.runWithInit → runAdapterInPage({ …, env })   # runner.ts
                    └─ installProcessPolyfill(globalThis, env)        # run-in-page.ts
                          # process.env = { ...env }, RESET each run
```

Two safety properties baked in:

- **Least privilege.** `resolveEnvForSource` scans the source for
  `process.env.NAME` (dot + bracket forms; _not_ destructuring, on purpose) and
  injects only those names — and only if the secret's `scope` allows the site.
  An adapter receives exactly the keys it literally reads, nothing else.
- **No cross-run leak.** The USER_SCRIPT world is reused across adapter runs in a
  pooled tab, so a prior run's `process` (with a prior key in `env`) is still
  there. `installProcessPolyfill` **resets `process.env` to this run's set every
  time** (when it owns the polyfill — `platform === 'browser'`, so a real Node
  `process` under tests is left intact).

The wire path is the isolated USER_SCRIPT world over a `chrome.runtime` port —
the host page's JS can't read the INIT message, so the key transits SW→adapter
without ever being page-visible.

## 5. Mode 2 — placeholder substitution (any tool, any arg)

For a tool that needs a secret as an explicit argument (e.g. a future
`http_request` with an `Authorization` header), the model/workflow/user writes
`{{secret:NAME}}` in the arg. At the dispatch chokepoint
(`executeAdapter`), `substitutePlaceholders` deep-walks the args and replaces the
token with the value — whole-string (`"{{secret:X}}"`) or embedded
(`"Bearer {{secret:X}}"`). An unknown NAME is left verbatim (a visibly-broken
call beats a silent empty credential) and reported as `missing`.

Ordering matters and is deliberate (`executeAdapter`):

1. Substitute → `execArgs` (real values) — used only for execution.
2. Run the tool.
3. **Redact** the raw result.
4. Explore-trace recording uses the **original** (placeholder) args and the
   **redacted** result — so a recorded/synthesized trace never captures a secret.

## 6. Redaction

`redactSecrets` deep-walks any result/error and replaces every known secret value
with `«NAME»`, longest values first. Applied in `executeAdapter` after execution,
so it covers **all** callers — the in-panel agent, the bridge (external agents),
and explore. Values shorter than 6 chars are skipped (a 2-char "secret" would
turn results into mush; real keys are long).

**Known limitation:** only _literal_ occurrences are caught. An adapter that
base64- or url-encodes the key before echoing it would slip through. Acceptable
for v1 (adapters are sha-pinned + hand-reviewed); revisit if untrusted adapters
become common.

## 7. The hot-path cache

`executeAdapter` runs on **every** tool call (generic primitives included), so it
reads secrets via `getSecretsCached()` — an in-SW snapshot invalidated on any
write, including a write from the sidepanel UI (a different JS context) via a
`chrome.storage.onChanged` listener. Mutators also drop the cache synchronously
for same-context immediacy. No `chrome.storage.local.get` per call.

## 8. Setting a secret — UI only

Adding/editing a value is a **UI action**: menu → **凭据** (`SecretsSection`).
Mirrors the LLM-key boundary — values are **never accepted over the bridge**, and
the list endpoints (`listSecretInfos`, the future bridge `list_secret_names`)
return **names + metadata only**, never values. The list can't re-read a value,
so editing the value **replaces** it (blank = keep), and the field is
`type=password`. The name IS the storage key, so changing it is a true **rename**
(`renameSecret` = write-new + delete-old) that **carries the existing value
over** — the user never re-enters the key — and rejects a collision rather than
clobbering another secret.

Fields: name (must be a valid env identifier), value (write-only), note
(non-sensitive label), scope (optional comma-separated site allow-list, e.g.
`weread-official, weread*`; empty = any adapter that references the name).

## 9. Verifying weread-official end-to-end

1. `npm run build`, then **reload** the unpacked extension (the bridge keeps the
   SW alive, so it won't auto-pick up a new build — see
   [verify-page-context-tools memory] / adapter-hot-plug §10).
2. Menu → 凭据 → 添加凭据: name `WEREAD_API_KEY`, value = the user's `wrk-…` key,
   scope `weread-official` (optional).
3. Drive a call via the bridge: `weread-official__search {book, query}` (or
   `load_adapter {site:'weread-official', name:'search'}` first if not installed).
   Expect real results — and the key absent from the result.

## 10. What's deliberately deferred

- **Bridge `list_secret_names`** (names only) so an external agent can discover
  which secrets exist. Setting stays UI-only. (Mode 1/2/redaction already work
  over the bridge because it calls `executeAdapter`.)
- **Encryption at rest** (WebCrypto) — currently same plaintext-at-rest level as
  the LLM keys. A unified "encrypt the whole credential surface" pass would cover
  both.
- **Encoded-echo redaction** (§6).

## 11. Cross-refs

- Marketplace flow (how adapters that need a key are shipped): `adapter-hot-plug.md`.
- Func runtime / userScripts world: `adapter-hot-plug.md` §B, `run-in-page.ts`.
- The original weread investigation that motivated this: `docs/tests/findings.md`
  ("weread 登录后复测 + weread-official key 验证").
