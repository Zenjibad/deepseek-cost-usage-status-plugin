# DeepSeek Cost / Usage / Status Plugin for DeepSeek Harness

A **dynamic Cordis plugin** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) that adds a second, colored status line under the shipped conversation stats line, showing live **DeepSeek API cost, usage, and account balance**.

```
● Off-peak 00:47 · −50%  ·  Cost ¥0.0412  ·  ~¥1.23/min  ·  Balance 12.42 CNY  ·  Model deepseek-v4-flash
```

## Features

- **On / off-peak indicator** — green when **off-peak** (idle), red when **peak**, using DeepSeek's **official Beijing-time peak windows** (09:00–12:00, 14:00–18:00). The clock shows your **local timezone**; the decision is Beijing-time so the color matches what DeepSeek actually bills.
- **Session cost** — real per-session token usage accumulated from the `llm/stream` waterfall, priced with **official CNY rates** including the **50% off-peak discount**.
- **Burn rate** — `~¥/min` (or `~$/min`), i.e. session cost ÷ elapsed minutes since the session's first model call.
- **Account balance** — polled from DeepSeek's `/user/balance` every 60s using DSH's own `DEEPSEEK_API_KEY`; degrades to `Balance —` if the key is unavailable/network fails.
- **Current model + reasoning effort**.
- **Font-matched** to the shipped stats line (12px/20px, muted tertiary color, centered) so it reads as the same family.

## Install

This is a **dynamic-only** plugin — there is no static `cordis.patch.yml` mount. Register it in a running DSH session:

1. Open the **Package → Cordis** plugin surface, or from this agent use `cordis_define` with `kind: 'new'` (`idPrefix` of your choice).
2. Paste the `host` field of [`package-source.js`](./package-source.js) into `code.host`, and the `client` field into `code.client`.
3. `cordis_run` the defined Package and approve in the UI.

The plugin then renders its line in the `conversation.composer.dock` slot (a new cell beside the shipped `stats` cell).

## Requirements

- DSH 0.1.0-rc.6+ with the web UI and a configured DeepSeek provider.
- A DeepSeek API key stored as `DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml` (reused for the balance read). Without it, balance shows `—`; the rest still works.

## How it works

- **Host half** (source of truth): wraps the `llm/stream` waterfall, forwards every chunk untouched, reads the terminal `usage` chunk per completed call, accumulates per-session token/`model`/timing, computes cost from the `PRICING` table (official CNY, peak-class; idle = 50%) with the Beijing-time peak decision, and polls balance via `curl.exe` + `subprocess`. Exposes one RPC: `dsb-snapshot`.
- **Client half**: registers in `conversation.composer.dock`, polls `dsb-snapshot` every 2s, and renders the font-matched line with a green/red peak chip.

## Pricing table (official DeepSeek CNY, per 1M tokens, effective 2026-08-17)

| model | | cache-hit in | cache-miss in | output |
| --- | --- | --- | --- | --- |
| **deepseek-v4-flash** | idle | ¥0.05 | ¥1.5 | ¥4.5 |
| | peak | ¥0.10 | ¥3.0 | ¥9.0 |
| **deepseek-v4-pro** | idle | ¥0.15 | ¥4.5 | ¥13.5 |
| | peak | ¥0.30 | ¥9.0 | ¥27.0 |

Update `PRICING` in `package-source.js` (single place) when rates change.

## Layout

- `package-source.js` — the plugin (mirror of the live registry Package). `host` → `code.host`, `client` → `code.client`.
- `docs/design.md`, `docs/plan.md` — spec and plan.
- `AGENTS.md` — guide for AI agents / maintainers.
- `README.zh.md` — 中文文档.

## License

MIT — see [LICENSE](./LICENSE).

> Note: `api.deepseek.com` prices are in CNY; if your account bills in USD instead, switch the model `currency` rows / cost display accordingly.
