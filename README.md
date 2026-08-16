# DeepSeek Cost / Usage / Status Plugin for DeepSeek Harness

A **packaged Cordis plugin** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) that adds a second, colored status line under the shipped conversation stats line, showing live **DeepSeek API cost, usage, and account balance**.

```
● Off-peak 00:47 · −50%  ·  Cost ¥0.0412  ·  ~¥1.23/min  ·  Balance ¥12.42  ·  Model deepseek-v4-flash   ← CNY account
● Off-peak 00:47 · −50%  ·  Cost $0.0057  ·  ~$0.17/min  ·  Balance $1.73  ·  Model deepseek-v4-flash   ← USD account (cost auto-converted from CNY)
```

## Features

- **On / off-peak indicator** — green when **off-peak** (idle), red when **peak**, using DeepSeek's **official Beijing-time peak windows** (09:00–12:00, 14:00–18:00). The clock shows your **local timezone**; the decision is Beijing-time so the color matches what DeepSeek actually bills.
- **Session cost** — real per-session token usage accumulated from the `llm/stream` waterfall, priced with **official CNY rates** including the **50% off-peak discount**, then **converted into your account's currency** (from the balance API) so cost and balance are directly comparable.
- **Burn rate** — `~/min` in the same display currency, i.e. session cost ÷ elapsed minutes since the session's first model call.
- **Account balance** — polled from DeepSeek's `/user/balance` every 60s using DSH's own `DEEPSEEK_API_KEY`; degrades to `Balance —` if the key is unavailable/network fails.
- **Current model + reasoning effort**.
- **Font-matched** to the shipped stats line (12px/20px, muted tertiary color, centered) so it reads as the same family.

## Quick start

This is a **packaged profile plugin** — install once with the official CLI, it loads on every DSH boot and survives restarts (no `cordis_define`):

```sh
dsh plugin --profile web add deepseek-cost-usage-status-plugin
# or from a local checkout:
dsh plugin --profile web add ./deepseek-cost-usage-status-plugin
```

Then **restart DSH**. The plugin renders its line in the `conversation.composer.dock` slot (a new cell beside the shipped `stats` cell), fed by `GET /deepseek-cost/api`.

## Requirements

- DSH 0.1.0-rc.6+ with the web UI and a configured DeepSeek provider.
- A DeepSeek API key stored as `DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml` (reused for the balance read). Without it, balance shows `—`; the rest still works.

## How it works

- **Host half** (source of truth): wraps the `llm/stream` waterfall, forwards every chunk untouched, reads the terminal `usage` chunk per completed call, accumulates per-session token/`model`/timing, computes cost from the `PRICING` table (official CNY, peak-class; idle = 50%) with the Beijing-time peak decision, and polls balance via `curl.exe` + `subprocess`. Serves the snapshot over **`GET /deepseek-cost/api`** (a `webServer` route — the packaged-plugin replacement for the dynamic `harness.handle` RPC seam).
- **Client half**: registers in `conversation.composer.dock`, polls `/deepseek-cost/api` every 2s, and renders the font-matched line with a green/red peak chip.

## User-currency cost display

Cost and burn rate are computed in CNY (the pricing table's basis) and then displayed in **your account's currency** — the one returned by `GET /user/balance` (usually USD). That way `Cost` and `Balance` share the same unit. The conversion uses a **hybrid FX rate**:

1. **Live** — fetched from [open.er-api.com](https://open.er-api.com) (`/v6/latest/CNY`, free, no key) through the same `curl.exe` + `subprocess` path as the balance poll, refreshed hourly by default (`fxRefreshMs`).
2. **Fallback** — a configured fixed rate (`fallbackFxRate`, CNY per 1 unit of the display currency, e.g. `7.2` for USD), used only when the live fetch fails.

If neither a live rate nor a fallback is available — or the balance is unknown (no API key / network failure) — cost simply stays in CNY. No wrong numbers are ever shown.

### Configuration

Set from a patch layer, e.g. `$DSH_HOME/cordis.patch.yml`:

```yaml
deepseek-cost-usage-status-plugin:
  config:
    fallbackFxRate: 7.2   # CNY per 1 USD — used when the live FX fetch fails
    fxRefreshMs: 3600000  # live FX refresh interval (default 1 h)
```

| option | default | meaning |
| --- | --- | --- |
| `fallbackFxRate` | unset | Fixed CNY→display-currency rate used when the live FX fetch fails |
| `fxRefreshMs` | `3600000` | How often to refresh the live FX rate (min 60 000) |

The currency symbol follows the account currency (¥, $, €, £, …); unmapped ISO codes render as their 3-letter code.

## Pricing table (official DeepSeek CNY, per 1M tokens, effective 2026-08-17)

| model | | cache-hit in | cache-miss in | output |
| --- | --- | --- | --- | --- |
| **deepseek-v4-flash** | idle | ¥0.05 | ¥1.5 | ¥4.5 |
| | peak | ¥0.10 | ¥3.0 | ¥9.0 |
| **deepseek-v4-pro** | idle | ¥0.15 | ¥4.5 | ¥13.5 |
| | peak | ¥0.30 | ¥9.0 | ¥27.0 |

Update `PRICING` in [`src/index.ts`](./src/index.ts) (single place) when rates change.

## FAQ

- **The line shows `Cost …` / `Balance —`?** The host route is unreachable, the balance key is missing (`~/.dsh/.credentials.yaml` → `DEEPSEEK_API_KEY`), or the balance call failed (network / non-200). Cost/peak still work without balance; the line self-recovers on the next poll.
- **Why does the balance read put the API key on a curl command line?** The key travels as an `Authorization` header argument to `curl.exe` (visible to other processes on this machine) — an accepted tradeoff for this readout tool. No key is stored or logged by the plugin itself.
- **Why is cost shown in my account's currency?** The plugin converts the CNY price into the currency your balance API returns (usually USD), so cost and balance are comparable. The rate is fetched live (hourly) and falls back to your configured `fallbackFxRate` when the fetch fails; without any rate, cost stays in CNY.

## Layout

- `src/index.ts` — the host half (waterfall wrap, pricing, balance poll, `/deepseek-cost/api` route).
- `src/client/index.tsx` — the client bundle (2s poller, dock line).
- `cordis.patch.yml` — `dsh.bundle.patch`: mounts the plugin row at boot.
- `tsdown.config.ts` — builds host (node ESM) + client (CJS ModuleLoader closure).
- `tests/fixtures/balance.json` — real-shape `/user/balance` response sample.
- `AGENTS.md` — guide for AI agents / maintainers.
- `README.zh.md` — 中文文档.

## License

MIT — see [LICENSE](./LICENSE).
