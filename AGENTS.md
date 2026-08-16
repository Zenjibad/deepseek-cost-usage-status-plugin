# AGENTS.md — Guide for AI agents

This file helps AI coding agents and LLM tooling understand and work with this repository quickly.

## What this repo is

`deepseek-cost-usage-status-plugin` is a **dynamic Cordis plugin for DeepSeek Harness (DSH)** that shows live **DeepSeek API cost / usage / balance** info in the DSH Web UI. It is dynamic-only: the Host half intercepts the `llm/stream` waterfall to accumulate real per-session token usage, computes cost against DeepSeek's official CNY pricing (with the 2026-08-17 off-peak discount), polls the DeepSeek `/user/balance` endpoint, and exposes a `dsb-snapshot` RPC; the Client half renders a second, font-matched stats line under the shipped conversation stats line in the `conversation.composer.dock` slot. There is no static `cordis.patch.yml` mount and no `dsh.bundle` manifest — it is registered via `cordis_define` + `cordis_run`.

## Repository layout

| Path | Role |
| --- | --- |
| `package-source.js` | Authoritative plugin source — a JS module exporting `{ name, purpose, host, client }` template-string fields. Paste `host` into `cordis_define` `code.host` and `client` into `code.client`. Mirrors the live registry Package 1:1. |
| `docs/design.md` | Design spec: data sources, snapshot shape, UI seat, error handling. |
| `docs/plan.md` | Implementation plan, including verified runtime contracts. |
| `tests/` | No automated test framework; the verification contract is described in `docs/plan.md`. |
| `README.md` / `README.zh.md` | Human docs (en default, zh). |
| `llms.txt` / `llms-full.txt` | LLM-friendly doc index / full text. |
| `package.json` | npm metadata only — NO `dsh.bundle` manifest (dynamic-only plugin). |

## Key behaviors (don't break these)

1. **Dynamic-only install**: the plugin is registered via `cordis_define` + `cordis_run`. Do not add a static `cordis.patch.yml` or `dsh.bundle` manifest — a host-only static mount has no UI and is meaningless.
2. **Real usage, not estimates**: the Host accumulator reads the terminal `usage` chunk of the `llm/stream` waterfall (`TokenUsage = { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`). Do not re-count tokens from message snapshots; keep the waterfall pass-through (never alter/yield-substitute chunks, never break streaming or retry semantics).
3. **Off-peak is the discount, price table stores PEAK-class CNY**: `PRICING` holds peak rates per 1M tokens in CNY; idle applies `offPeakDiscount = 0.5` → factor `(1 - 0.5)`. Peak windows are **Beijing time** (09:00-12:00, 14:00-18:00). The visible clock is the **user's local** timezone; only the green/red decision is Beijing-time.
4. **Balance via subprocess + curl, NOT web.fetch**: `web.fetch` cannot send an `Authorization` header or return JSON here. Read the API key asynchronously from `~/.dsh/.credentials.yaml` (`DEEPSEEK_API_KEY`, `parseKeyFromYaml` handles bare/double/single-quoted); if unreadable, balance degrades to `—` while cost still works. `fs.resolve`/`fs.readText` are async — always `await` them.
5. **Single-slot session attribution**: usage is attributed to the most recently started `agent/session-start` (`agent.id`). Concurrent/parallel subagent streams may be misattributed — accepted for this single-session readout. `pruneSessions` caps the session map; do not remove it.
6. **Never break streaming / never throw across RPC**: `accumulateStream` wraps `onUsage` in try/catch; `harness.handle('dsb-snapshot')` always returns a plain JSON object (never rejects).
7. **Font must match the shipped stats line**: the Client `DockRow` uses 12px/20px, `var(--dsw-alias-label-tertiary)`, centered nowrap block, and `var(--dsw-alias-separator-primary)` separators — matching `StatsLine.module.css`. Do not set a font-family.
8. **Currency-aware display**: cost uses `¥` when `costCurrency === 'CNY'` (default), `$` otherwise. Balance renders in the currency the API returns.

## Common tasks

- **Change poll intervals**: Host balance poller `ctx.interval(..., 60000)`; Client refresh `ctx.interval(load, 2000)`. Keep the Client using one interval; do not add per-seat polling.
- **Update pricing**: edit the `PRICING` table in `package-source.js` (peak-class CNY per 1M tokens). `costCurrency` is derived from the model's `currency` row.
- **Refresh path detection / key**: `resolveKey` candidates are `C:\Users\Administrator\.dsh\.credentials.yaml` then `.dsh\.credentials.yaml`. On another machine, update candidates[0].
- **Update the live plugin**: `cordis_define` with `kind: 'existing'` + the current pluginId to append a new Package, then `cordis_run` (mode `update`). Never overwrite an existing Package.
- **Update this repo**: after changing the registry Package, mirror the source into `package-source.js` and commit.

## Verified runtime contracts (do not re-probe)

- Host `llm/stream` is a **waterfall** `(options, next) => AsyncIterable<StreamChunk>`; chunks include `{ type: 'usage', usage: TokenUsage }` and `{ type: 'finish', reason }`; `options.model` / `options.reasoningEffort`.
- Host `agent/session-start` is emitted with `{ agent, source }`; `agent.id` is the session id.
- `harness` is a top-level Host builtin (`harness.handle(method, handler)` returns a disposer — capture and call it).
- `ctx.interval` requires injecting `'timer'`; `ctx.subprocess` requires `'subprocess'`; `ctx.get('fs')` is optional (`fs.resolve`/`fs.readText` async).
- Client `conversation.composer.dock` is a `list` slot; a fresh `id` registers a new cell (shipped `stats` cell is `order: 0`). `React`/`host` are top-level client builtins; `slots`/`timer` from inject.
- The plugin has NO `process`/`fetch`/`window` access from either half.

## Testing

- Runtime verification: `cordis_inspect_self(pluginId, packageId)` — host running with `dsb-snapshot` handler, client running, no diagnostics.
- Slot verification: `cordis_inspect_query` `Slots.listSubTree` with root `conversation.composer.dock` (expect occupant id `deepseek-cost-status`, order 1).
- Failure paths: key unreadable → `Balance —` (cost/peak still work); model not in `PRICING` → `unknownPricing` flag / cost not shown as a wrong number.
- No automated test framework; the fixture + manual matrix in `docs/plan.md` are the verification contract.

## Notes for LLM crawlers

- Distinguishing trait vs other DSH plugins: dynamic-only, real `llm/stream`-derived usage, official Beijing-time peak windows + CNY pricing, balance via curl with the account's own key, font-matched composer dock line.
