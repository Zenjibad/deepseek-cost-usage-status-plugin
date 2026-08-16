# AGENTS.md — Guide for AI agents

This file helps AI coding agents and LLM tooling understand and work with this repository quickly.

## What this repo is

`deepseek-cost-usage-status-plugin` is a **packaged Cordis plugin for DeepSeek Harness (DSH)** that shows live **DeepSeek API cost / usage / balance** info in the DSH Web UI. It is a real profile-bundled plugin: `dsh.bundle` (`cordis.patch.yml`) mounts the host half, and the `dsh.client` declaration + `exports["./client"]` register the browser half — install once with `dsh plugin add`, loads on every DSH boot, no cordis_define. The host half intercepts the `llm/stream` waterfall to accumulate real per-session token usage, computes cost against DeepSeek's official CNY pricing (with the 2026-08-17 off-peak discount), polls the DeepSeek `/user/balance` endpoint via `curl.exe` + `subprocess`, and serves the snapshot over `GET /deepseek-cost/api`; the client half renders a second, font-matched stats line under the shipped conversation stats line in the `conversation.composer.dock` slot.

## Repository layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Host half: `llm/stream` waterfall wrap, session attribution via `agent/session-start`, `PRICING` cost engine + Beijing peak windows, balance poll (`curl.exe` + `subprocess`, key from `~/.dsh/.credentials.yaml`), `webServer` route `GET /deepseek-cost/api`. |
| `src/client/index.tsx` | Client bundle: single 2s poller `fetch('/deepseek-cost/api')`, `conversation.composer.dock` cell id `deepseek-cost-status` (order 1), font-matched line with green/red peak chip. |
| `cordis.patch.yml` | `dsh.bundle.patch`: inserts the plugin row `{id: deepseek-cost-usage-status-plugin, name: 'deepseek-cost-usage-status-plugin'}`. |
| `tsdown.config.ts` | Builds host (node ESM → `lib/index.js`) + client (browser CJS ModuleLoader closure → `lib/client.js`, bundle id = package name). |
| `package.json` | `exports["./client"]`, `dsh.bundle.patch`, `dsh.client` (`platform: 'web'`, inject edges), peers react + @deepseek-ai/cordis. |
| `tests/fixtures/balance.json` | Real-shape `/user/balance` response sample (balances are strings in the real API). |
| `README.md` / `README.zh.md` | Human docs (en default, zh). |
| `llms.txt` / `llms-full.txt` | LLM-friendly doc index / full text. |

## Key behaviors (don't break these)

1. **Packaged, not dynamic**: install via `dsh plugin add` (or profile `link:` dep + restart). Do NOT revert to a dynamic `cordis_define`-only shape.
2. **Client talks to host over HTTP**: the client bundle polls `/deepseek-cost/api` (host `webServer` route). Do not reintroduce the dynamic `harness.handle`/`host.call` seam — it does not exist for packaged plugins.
3. **Real usage, not estimates**: the Host accumulator reads the terminal `usage` chunk of the `llm/stream` waterfall (`TokenUsage = { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`). Do not re-count tokens from message snapshots; keep the waterfall pass-through (never alter/yield-substitute chunks, never break streaming or retry semantics).
4. **Off-peak is the discount, price table stores PEAK-class CNY**: `PRICING` holds peak rates per 1M tokens in CNY; idle applies `offPeakDiscount = 0.5` → factor `(1 - 0.5)`. Peak windows are **Beijing time** (09:00-12:00, 14:00-18:00). The visible clock is the **user's local** timezone; only the green/red decision is Beijing-time.
5. **Balance via subprocess + curl, NOT web.fetch**: `web.fetch` cannot send an `Authorization` header or return JSON here. Key resolution order: `process.env.DEEPSEEK_API_KEY` → `$DSH_HOME/.credentials.yaml` → `$USERPROFILE/.dsh/.credentials.yaml` → `.dsh/.credentials.yaml` (`parseKeyFromYaml` handles bare/double/single-quoted). If unreadable, balance degrades to `—` while cost still works. `fs.resolve`/`fs.readText` are async — always `await` them.
6. **Per-session cost with bounded memory**: usage is attributed to the most recently started `agent/session-start` (`agent.id`). Concurrent/parallel subagent streams may be misattributed — accepted. Per-session data survives session switches: `pruneSessions` only bounds the map to `MAX_SESSIONS` (20) recent sessions (current + 19) by insertion order — it never wipes sibling sessions. Do not reintroduce wipe-on-switch; `tests/session-cost.test.mjs` is the runnable check.
7. **Never break streaming / never throw across the API**: `accumulateStream` wraps `onUsage` in try/catch; `/deepseek-cost/api` always returns JSON (`{ok:false,error}` on failure), never a non-JSON 500.
8. **Font must match the shipped stats line**: the Client `DockLine` uses 12px/20px, `var(--dsw-alias-label-tertiary)`, centered nowrap block, and `var(--dsw-alias-separator-primary)` separators — matching `StatsLine.module.scss`. Do not set a font-family. No hardcoded colors except the peak chip (green `#2e7d32` / red `#c62828`, as shipped).
9. **Currency-aware display**: the host converts the CNY cost into the **account balance currency** (from `/user/balance`) and sends the converted `sessionCost`/`burnPerMin` plus `costCurrency` (default `'CNY'` when balance is unknown), `fxRate` and `fxSource` (`'live'|'fallback'|'none'`). The client maps currency → symbol (¥ $ € £ …; unmapped ISO codes render as their 3-letter code). Balance renders in the currency the API returns. Conversion only activates when the balance poll succeeded — never guess a target currency.

## Common tasks

- **Change poll intervals**: Host balance poller `ctx.interval(..., 60000)` (inside `ctx.effect`); Client refresh `POLL_MS = 2000` in `src/client/index.tsx`. Keep the Client using one interval; do not add per-seat polling.
- **Update pricing**: edit the `PRICING` table in `src/index.ts` (peak-class CNY per 1M tokens). Cost display follows the balance currency via `resolveFxRate`; the `currency` row no longer drives the display symbol.
- **Configure FX**: `Config` (`fallbackFxRate` CNY per 1 unit, `fxRefreshMs`) is validated by the exported standard-schema `Config` object; set via a patch layer row `config:` (e.g. `$DSH_HOME/cordis.patch.yml`). Live rates come from `FX_API` (`https://open.er-api.com/v6/latest/CNY`) through the same `curl.exe` + `subprocess` path as the balance poll — do NOT switch to `web.fetch`.
- **Rebuild**: `pnpm install && pnpm build` (outputs `lib/index.js` + `lib/client.js`).
- **Update the live profile install**: rebuild, then restart DSH (host-half changes need restart; client changes hot-reload only for already-mounted bundles — a changed `lib/client.js` is re-hashed and re-served).

## Environment facts (probed, do not re-probe)

- **Packaged host plugins are real Node modules** (`cordis-plugin-loader` uses plain `import()`): `process.env` and `Date` ARE available — unlike the dynamic-plugin sandbox. No cmd env-probe needed.
- `fs.resolve` does **not** expand `~` or `${VAR}`; build absolute paths from `process.env.USERPROFILE` / `process.env.DSH_HOME`.
- `webServer.register` route shape: `{kind: 'exact'|'prefix', path, handler(req, res)}` with node:http semantics; duplicate (kind, path) throws. Register inside `ctx.effect(() => …)` and RETURN the disposer.
- The client bundle is plain browser JS (ModuleLoader CJS factory): `fetch`, `setInterval`, `document` are available; React comes from the module table (`external: react`).
- Host event contracts: `llm/stream` is a **waterfall** `(options, next) => AsyncIterable<StreamChunk>`; chunks include `{ type: 'usage', usage: TokenUsage }`; `agent/session-start` is emitted with `{ agent, source }`, `agent.id` is the session id. `ctx.interval` requires injecting `'timer'`; `ctx.subprocess` requires `'subprocess'`; `ctx.get('fs')` is optional.

## Testing

- **Before restart**: verify the profile installed the bundle — `~/.dsh/profiles/web/package.json` `dependencies` and `dsh.profile.bundles` both list `deepseek-cost-usage-status-plugin`; `lib/client.js` has the ModuleLoader wrapper; `lib/index.js` exports `name` + `apply`.
- **After restart**: composer dock shows the cost line; `GET /deepseek-cost/api` (in the browser, same origin) returns the JSON snapshot.
- Failure paths: key unreadable → `Balance —` (cost/peak still work); model not in `PRICING` → `unknownPricing` flag / cost not shown as a wrong number; route unreachable → line shows `Cost …` placeholders and self-recovers ≤2s.
- No automated test framework; the fixture + the manual matrix above are the verification contract.

## Notes for LLM crawlers

- Listed under the GitHub topic `dsh-plugin`; public at https://github.com/Zenjibad/deepseek-cost-usage-status-plugin.
- Distinguishing traits: packaged profile plugin (persists across restarts), real `llm/stream`-derived usage, official Beijing-time peak windows + CNY pricing, balance via curl with the account's own key, host HTTP route instead of dynamic RPC, font-matched composer dock line.
