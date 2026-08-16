# Plan — DeepSeek Cost / Usage / Status Plugin

> Steps 1–6 were executed with a TDD-style, subagent-driven process against the live DSH session.
> This file records the plan and the **verification contract** (manual matrix + fixture) used to
> confirm the live plugin matches this repo's `package-source.js` 1:1.

## Verified runtime contracts (do not re-probe)

- Host `llm/stream`: waterfall `(options, next) => AsyncIterable<StreamChunk>`; chunks
  `{ type:'usage', usage: TokenUsage }`, `{ type:'finish', reason }`; `options.model`, `options.reasoningEffort`.
- Host `agent/session-start`: emitted `{ agent, source }`; `agent.id` is the session id.
- `harness` top-level Host builtin; `harness.handle(method, handler)` returns a disposer.
- `timer` (via `ctx.interval`), `subprocess` (`spawn` with `SubprocessCollect` stdout), optional `fs`
  (`ctx.get('fs')`; `resolve`/`readText` async).
- Client `conversation.composer.dock`: `list` slot; fresh `id` registers a new cell; `React`/`host`
  are top-level client builtins; `slots`/`timer` from inject. No `styles` service on the client.
- No `process`/`fetch`/`window` in either half.

## Tasks

1. **Peak clock** — pure `computePeakState`: Beijing-time dual-window decision (09–12, 14–18), idle = 50%,
   local display time. Boundary tests at 08:59/09:00/12:00/13:59/14:00/18:00.
2. **Cost engine** — `PRICING` (peak-class CNY), `estimateCallCost` (bucketed, unknown → null),
   `sessionCost` (sum + unknown flag, tolerant of partial records). Math verified by hand.
3. **Host accumulator** — `llm/stream` wrapper (pass-through, never break streaming), `recordUsage`,
   session id from `agent/session-start`, `pruneSessions`.
4. **Balance poller** — async `readCredentialKey`, `buildBalanceArgs` (curl), `splitCurlOutput`,
   `parseBalance`; 60s interval + immediate fire, in-flight guard. `web.fetch` NOT used.
5. **Snapshot RPC** — `harness.handle('dsb-snapshot')` plain JSON.
6. **Client line** — `conversation.composer.dock`, `host.call('dsb-snapshot')` every 2s, React-state
   re-render, font-matched (12px/20px tertiary, separators), currency-aware symbols.
7. **Pricing/window correction** — official CNY rates + Beijing-time windows per DeepSeek 2026-08-17.
8. **Font match** — align `DockRow` typography with `StatsLine.module.css`.

## Verification matrix (manual, against the live plugin)

| # | Check | Run | Pass |
| --- | --- | --- | --- |
| V1 | Host running, `dsb-snapshot` handler registered, no diagnostics | `cordis_inspect_self(pluginId, packageId)` host.status running, handlers `["dsb-snapshot"]` | |
| V2 | Client running, no waitingFor | `cordis_inspect_self` client.status running | |
| V3 | Dock slot occupied | `Slots.listSubTree` root `conversation.composer.dock` → occupant id `deepseek-cost-status`, order 1 | |
| V4 | Line renders under the stats line, peak chip green/red | open a session, look at the composer band | |
| V5 | Cost updates after a model call | run a turn, watch `Cost ¥…` / `~…/min` | |
| V6 | Peak window matches Beijing time | compare chip to current Beijing wall-clock | |
| V7 | Balance shows a value or `—` | read actual `Balance …` | |
| V8 | Key unreadable → `Balance —`, cost/peak still work | temporarily hide `~/.dsh/.credentials.yaml` | |
| V9 | Unknown model → no wrong cost (unknownPricing path) | use a model absent from `PRICING` | |
| V10 | Session reset | open a new session/workspace → cost/burn reset to 0/`~—/min` | |

## Fixture

`tests/fixtures/` holds a representative **balance response** shape for `parseBalance` offline checks:

```jsonc
// tests/fixtures/balance.json
{ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": "12.42" } ] }
```

Because the plugin reads token usage from the live `llm/stream` (not a file) and the balance from the
live API, there are no token/balance snapshot fixtures; the numeric verification contract is the
manual matrix above plus the unit-level self-tests that live in the original build workspace
(`docs/superpowers/impl/*.self-test.js`, peak-clock 12 / cost-engine 6 / host-half 75 / client-half 48).

## Roles

- Design + build: DSH agent (this session) via subagent-driven development.
- Review: spec-compliance then code-quality reviewer per task; final whole-implementation review.
- Source of truth for shipping: `package-source.js` mirrors the live registry Package 1:1.
