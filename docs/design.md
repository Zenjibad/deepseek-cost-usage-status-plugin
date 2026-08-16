# Design — DeepSeek Cost / Usage / Status Plugin

## Overview

A dynamic Cordis plugin for DeepSeek Harness (DSH) that adds a second, colored status line
under the shipped conversation stats line. It shows live DeepSeek API account/usage info:
on/off-peak (green/red in local time), session cost, ~¥/min burn rate, account balance, and
the current model.

## Context (verified)

- The shipped stats line lives in Slot `conversation.composer.dock` (a `list` slot, session
  scope). The plugin registers a fresh cell (`id: 'deepseek-cost-status'`, `order: 1`) that
  stacks a second line beneath it. The shipped `stats` cell is `order: 0`.
- The Host `llm/stream` is a **waterfall** `(options, next) => AsyncIterable<StreamChunk>`
  around every streaming model call — the authoritative place to observe real token usage
  without re-counting. Chunks include `{ type: 'usage', usage: TokenUsage }` and
  `{ type: 'finish', reason }`; `options.model` / `options.reasoningEffort` name the call.
  `TokenUsage` is disjoint: `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`.
- DSH runs DeepSeek itself (provider `deepseek-official`, default model `deepseek-v4-flash`);
  the account key is `DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml`.
- `web.fetch` cannot send an `Authorization` header or return JSON, so the balance request
  uses `subprocess` running `curl.exe` with `-H "Authorization: Bearer <key>" -w '\n%{http_code}'`.
- Neither half has access to `process`, `fetch`, or `window`. `fs.resolve`/`fs.readText` are async.

## DeepSeek pricing / peak model (official, effective 2026-08-17)

- **Peak hours (Beijing time, UTC+8)**: daily **09:00–12:00 and 14:00–18:00**. Everything else is
  **idle / off-peak**. Idle price = **exactly 50%** of peak.
- **Decision basis**: the green/red decision uses **Beijing time** (matches billing); the visible
  clock uses the **user's local** timezone.
- **Currency**: prices are **CNY (¥)** per 1M tokens. The `PRICING` table stores **PEAK-class** rates;
  idle applies `offPeakDiscount = 0.5` → `(1 - 0.5)`.
  - `deepseek-v4-flash`: cache-hit in 0.10 / cache-miss in 3.0 / out 9.0 (peak); half when idle.
  - `deepseek-v4-pro`:   cache-hit in 0.30 / cache-miss in 9.0 / out 27.0 (peak); half when idle.
  - Reasoning uses the same output rate (single rate for thinking & non-thinking) → premium delta 0.

## Architecture

Single dynamic Cordis plugin, two halves.

```
Host (source of truth)                          Client (rendering)
──────────────────────                          ────────────────────
 llm/stream waterfall ─ accumulate per-session tokens
 cost engine ─ (model,effort,isOffPeak@t) → ¥      conversation.composer.dock
 peak clock ─ isOffPeak (Beijing) + local time      └─ second status line
 balance poller ─ 60s / on-mount → curl.exe         renders snapshot
        │                                           ▲
        └── harness.handle('dsb-snapshot') ◄───────┘ host.call('dsb-snapshot')
```

## Data flow

1. **Accumulate** — wrap `ctx.on('llm/stream', ...)`, call `next()`, iterate the streamed chunks,
   forward every chunk untouched; on the terminal `usage` chunk, record one call against the
   current session (shallow-copy the usage). `recordUsage` sets `model`, reasoning `effort`,
   peak state, and `startedMs` on the first call.
2. **Session id** — from `agent/session-start` (`agent.id`). Single-slot attribution; `pruneSessions`
   keeps only the current record to cap the map.
3. **Cost** — `estimateCallCost(usage, model, isOffPeak, offPeakDiscount)` prices each bucket at the
   peak class rate × `(1 - offPeakDiscount)` when idle; `sessionCost` sums and flags unknown models.
4. **Burn rate** — `sessionCost / minutesSinceFirstCall` → `~¥/min`.
5. **Balance** — read the key asynchronously via `readCredentialKey`, spawn `curl.exe` (collect-mode
   stdout), `splitCurlOutput` for the body/status, `parseBalance`; 60s `ctx.interval` + immediate fire,
   in-flight guarded, never blocking the snapshot.
6. **Snapshot RPC** — `harness.handle('dsb-snapshot')` returns plain JSON (see shape). Never throws.
7. **Client render** — register in `conversation.composer.dock`; poll `dsb-snapshot` every 2s (React
   state-backed so it re-renders live); render the font-matched line.

## Snapshot shape (`dsb-snapshot`)

```jsonc
{
  "isOffPeak": true, "isPeak": false,
  "localTime": "00:47", "beijingTime": "00:47",
  "offPeakDiscount": 0.5,
  "sessionCost": 0.0412, "unknownPricing": false,
  "burnPerMin": 1.23, "costCurrency": "CNY",
  "model": "deepseek-v4-flash", "reasoningEffort": "high", "calls": 2,
  "balance": { "balance": 12.42, "currency": "CNY", "isAvailable": true, "lastFetch": 1710000000000 }
}
```

## Client line format

```
● Off-peak 00:47 · −50%  ·  Cost ¥0.0412  ·  ~¥1.23/min  ·  Balance 12.42 CNY  ·  Model deepseek-v4-flash
● Peak 10:22            ·  Cost ¥0.5000  ·  ~¥0.25/min  ·  Balance —        ·  Model deepseek-v4-flash
```

- Off-peak chip **green** (#2e7d32); peak chip **red** (#c62828); system load placeholder grey.
- Font matches the shipped stats line: 12px/20px, `var(--dsw-alias-label-tertiary)`, centered,
  nowrap block; separators use `var(--dsw-alias-separator-primary)`.
- Cost symbol: `¥` when `costCurrency === 'CNY'` (default), else `$`. Balance uses the API's currency.

## Session scope

- Session cost, calls, and burn rate reset when a new session/workspace opens (`agent/session-start`
  switches `currentSessionId` and prunes). Burn rate measures from the session's first completed call.
- Balance and peak state are account-level, not session-scoped.

## Error handling

| condition | behavior |
| --- | --- |
| key unreadable / network down / non-200 | `balance.isAvailable = false` → `Balance —`; cost & peak unchanged |
| model not in `PRICING` | `unknownPricing = true`; cost shown with existing values, never a wrong number |
| stream errors or no usage | that call contributes 0; streaming never breaks |
| `dsb-snapshot` unavailable | client shows loading state; re-polls |
| concurrent subagent streams | may be misattributed to the current session (documented single-slot assumption) |

## Components & boundaries

- **Host accumulator** (`recordUsage`, `accumulateStream`) — owns per-session token/call state.
- **Host cost engine** (`PRICING`, `estimateCallCost`, `sessionCost`) — pure; unit-testable.
- **Host peak clock** (`computePeakState`) — pure; Beijing-time decision + local display time.
- **Host balance poller** (`readCredentialKey`, `buildBalanceArgs`, `splitCurlOutput`, `parseBalance`) — timer + curl.
- **Host snapshot** (`harness.handle('dsb-snapshot')`) — plain-JSON projection.
- **Client line view** (`renderSnapshot`, `Client`) — renders the snapshot; owns no business data.
