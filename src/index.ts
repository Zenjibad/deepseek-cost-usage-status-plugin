/**
 * deepseek-cost-usage-status-plugin — host half.
 *
 * Wraps the `llm/stream` waterfall to accumulate real per-session token usage,
 * prices each call with DeepSeek's official CNY rates (peak-class, 50% off-peak
 * discount, Beijing-time windows), polls the account balance via
 * `curl.exe` + `subprocess`, and serves the snapshot to the client bundle over
 * an HTTP route (`GET /deepseek-cost/api`).
 *
 * Runtime note: packaged profile plugins are loaded as real Node modules
 * (`cordis-plugin-loader` uses plain `import()`), so `process.env` and `Date`
 * ARE available here — unlike the dynamic-plugin sandbox.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'deepseek-cost-usage-status-plugin'

// Hard dependencies: webServer (serves the client's stats route), timer
// (balance poll), subprocess (curl balance read), llm (llm/stream waterfall).
export const inject = ['webServer', 'timer', 'subprocess', 'llm']

export interface Config {
  /** Fallback CNY→display-currency rate (CNY per 1 unit, e.g. 7.2 for USD), used only when the live FX fetch fails. */
  fallbackFxRate?: number
  /** How often to refresh the live FX rate, in ms. Defaults to 1 hour. */
  fxRefreshMs?: number
}

/**
 * Cordis validates the entry config against this standard-schema object.
 * Set it from a patch layer, e.g. in $DSH_HOME/cordis.patch.yml:
 *
 *   deepseek-cost-usage-status-plugin:
 *     config: { fallbackFxRate: 7.2, fxRefreshMs: 3600000 }
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'deepseek-cost-usage-status-plugin',
    validate(value: unknown): { value: Config } | { issues: Array<{ message: string; path?: Array<string | number> }> } {
      const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      const out: Config = {}
      if (typeof raw.fallbackFxRate === 'number' && Number.isFinite(raw.fallbackFxRate) && raw.fallbackFxRate > 0) {
        out.fallbackFxRate = raw.fallbackFxRate
      }
      if (typeof raw.fxRefreshMs === 'number' && Number.isFinite(raw.fxRefreshMs) && raw.fxRefreshMs >= 60000) {
        out.fxRefreshMs = Math.round(raw.fxRefreshMs)
      }
      return { value: out }
    },
  },
}

/* ------------------------------------------------------------------ *
 * Pure helpers (ported 1:1 from the dynamic plugin; no service deps)
 * ------------------------------------------------------------------ */

export interface PeakState {
  isOffPeak: boolean
  isPeak: boolean
  offPeakDiscount: number
  localTime: string
  beijingMinutes: number
  beijingTime: string
}

/** DeepSeek's official peak hours are in BEIJING time (UTC+8): 09:00–12:00 and 14:00–18:00. */
export function computePeakState(date: Date): PeakState {
  const bjMs = date.getTime() + 8 * 3600 * 1000
  const bj = new Date(bjMs)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const isPeak = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
  const isOffPeak = !isPeak
  const localTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return {
    isOffPeak,
    isPeak,
    offPeakDiscount: isOffPeak ? 0.5 : 0,
    localTime,
    beijingMinutes: minutes,
    beijingTime: String(bj.getUTCHours()).padStart(2, '0') + ':' + String(bj.getUTCMinutes()).padStart(2, '0'),
  }
}

/** Official DeepSeek 2026-08-17 CNY pricing (PEAK-class per 1M tokens). */
export const PRICING: Record<string, { input: number; cacheRead: number; output: number; reasoning: number; currency: string }> = {
  'deepseek-v4-flash': { input: 3.0, cacheRead: 0.1, output: 9.0, reasoning: 9.0, currency: 'CNY' },
  'deepseek-v4-pro': { input: 9.0, cacheRead: 0.3, output: 27.0, reasoning: 27.0, currency: 'CNY' },
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export function estimateCallCost(
  usage: TokenUsage | null | undefined,
  model: string | undefined,
  isOffPeak: boolean,
  offPeakDiscount: number,
): number | null {
  const p = PRICING[model ?? '']
  if (!p) return null
  const f = isOffPeak ? 1 - (offPeakDiscount || 0) : 1
  const perTok = (perM: number): number => perM / 1e6
  const input = (usage?.inputTokens ?? 0) * perTok(p.input)
  const cache = (usage?.cacheReadTokens ?? 0) * perTok(p.cacheRead)
  let output = (usage?.outputTokens ?? 0) * perTok(p.output)
  const reasoning = (usage?.reasoningTokens ?? 0) * perTok(Math.max(p.reasoning - p.output, 0))
  output = output + reasoning
  return (input + cache + output) * f
}

export interface CallRecord {
  usage: TokenUsage | null
  model: string | undefined
  isOffPeak: boolean
  offPeakDiscount: number
  at: string
}

export function sessionCost(calls: CallRecord[]): { total: number; unknown: boolean } {
  let total = 0
  let unknown = false
  for (const c of calls) {
    if (!c) continue
    const cost = estimateCallCost(c.usage, c.model, c.isOffPeak, c.offPeakDiscount)
    if (cost === null) unknown = true
    else total += cost
  }
  return { total, unknown }
}

/** Split `-w '\n%{http_code}'` curl output: body before the last newline, code after. */
export function splitCurlOutput(text: string): { code: string; body: string } {
  const s = String(text == null ? '' : text)
  const nl = s.lastIndexOf('\n')
  if (nl < 0) return { code: s.trim(), body: '' }
  return { code: s.slice(nl + 1).trim(), body: s.slice(0, nl) }
}

/** Extract DEEPSEEK_API_KEY from a credentials yaml (bare / double- / single-quoted). */
export function parseKeyFromYaml(text: string): string | null {
  const m = /(?:^|\n)[ \t]*DEEPSEEK_API_KEY[ \t]*:[ \t]*([^\s\r\n]+)/.exec(text || '')
  if (!m || !m[1]) return null
  return m[1].replace(/^["']+|["']+$/g, '')
}

export function parseBalance(text: string): { isAvailable: boolean; balance: number | null; currency: string } {
  try {
    const j = JSON.parse(text) as { is_available?: boolean; balance_infos?: Array<{ total_balance?: string | number; currency?: string }> }
    const first = (j.balance_infos && j.balance_infos[0]) || {}
    return {
      isAvailable: !!j.is_available,
      balance: first.total_balance != null ? Number(first.total_balance) : null,
      currency: first.currency || 'USD',
    }
  } catch {
    return { isAvailable: false, balance: null, currency: 'USD' }
  }
}

export function buildBalanceArgs(apiKey: string): string[] {
  // NOTE: the API key travels on the child process's command line (visible to
  // other processes on this machine) — accepted tradeoff for this readout tool.
  return [
    'curl.exe', '-sS',
    '-H', 'Authorization: Bearer ' + apiKey,
    '-w', '\n%{http_code}',
    'https://api.deepseek.com/user/balance',
  ]
}

/** Public free FX endpoint with a CNY base: rates are units of each currency per 1 CNY. */
export const FX_API = 'https://open.er-api.com/v6/latest/CNY'

export function buildFxArgs(): string[] {
  return ['curl.exe', '-sS', '-w', '\n%{http_code}', FX_API]
}

export interface FxRates {
  ok: boolean
  rates: Record<string, number>
}

/** Parse the `{result, rates}` body from open.er-api.com (rate values are numbers/strings). */
export function parseFxRates(text: string): FxRates {
  try {
    const j = JSON.parse(text) as { result?: string; rates?: Record<string, unknown> }
    if (j.result !== 'success' || !j.rates) return { ok: false, rates: {} }
    const rates: Record<string, number> = {}
    for (const [code, v] of Object.entries(j.rates)) {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n) && n > 0) rates[code] = n
    }
    return { ok: typeof rates['CNY'] === 'number', rates }
  } catch {
    return { ok: false, rates: {} }
  }
}

export type FxSource = 'none' | 'live' | 'fallback'

export interface FxResolution {
  /** Units of the display currency per 1 CNY. 1 = no conversion. */
  rate: number
  source: FxSource
}

/**
 * Resolve the CNY→target rate: live map first, then the configured fallback
 * (config.fallbackFxRate is CNY per 1 unit → 1/fallbackFxRate units per CNY).
 * Returns null when neither is available; CNY always resolves to 1.
 */
export function resolveFxRate(
  targetCurrency: string,
  liveRates: Record<string, number>,
  config: Config,
): FxResolution | null {
  if (!targetCurrency || targetCurrency === 'CNY') return { rate: 1, source: 'none' }
  const live = liveRates[targetCurrency]
  if (typeof live === 'number' && Number.isFinite(live) && live > 0) return { rate: live, source: 'live' }
  if (typeof config.fallbackFxRate === 'number' && Number.isFinite(config.fallbackFxRate) && config.fallbackFxRate > 0) {
    return { rate: 1 / config.fallbackFxRate, source: 'fallback' }
  }
  return null
}

export interface SessionState {
  calls: CallRecord[]
  startedMs: number | null
  model: string | null
  effort: string | null
}

export function recordUsage(
  sessions: Map<string, SessionState>,
  sessionId: string,
  options: { model?: string; reasoningEffort?: string },
  usage: TokenUsage | null | undefined,
  now: Date,
): boolean {
  const s = sessions.get(sessionId)
  if (!s) return false
  const peak = computePeakState(now)
  s.calls.push({
    usage: usage && typeof usage === 'object' ? { ...usage } : null,
    model: options.model,
    isOffPeak: peak.isOffPeak,
    offPeakDiscount: peak.offPeakDiscount,
    at: now.toISOString(),
  })
  s.model = options.model ?? null
  if (s.calls.length === 1) s.startedMs = now.getTime()
  if (options.reasoningEffort) s.effort = options.reasoningEffort
  return true
}

/** Pass-through stream wrapper that captures the terminal `usage` chunk. */
export async function* accumulateStream(
  stream: AsyncIterable<unknown>,
  onUsage: (usage: TokenUsage) => void,
): AsyncIterable<unknown> {
  let usage: TokenUsage | undefined
  for await (const chunk of stream) {
    if (chunk && typeof chunk === 'object' && (chunk as { type?: string }).type === 'usage') {
      usage = (chunk as { usage?: TokenUsage }).usage
    }
    yield chunk
  }
  if (usage && typeof onUsage === 'function') {
    try {
      onUsage(usage)
    } catch {
      /* a throw must never break streaming semantics */
    }
  }
}

export function pruneSessions(sessions: Map<string, SessionState>, keepId: string): void {
  for (const key of Array.from(sessions.keys())) {
    if (key !== keepId) sessions.delete(key)
  }
}

/* ------------------------------------------------------------------ *
 * Snapshot served to the client bundle
 * ------------------------------------------------------------------ */

export interface CostSnapshot {
  ok: boolean
  error?: string
  isOffPeak: boolean
  isPeak: boolean
  localTime: string
  offPeakDiscount: number
  beijingTime: string
  sessionCost: number
  unknownPricing: boolean
  burnPerMin: number | null
  costCurrency: string
  fxRate: number | null
  fxSource: FxSource
  model: string | null
  reasoningEffort: string | null
  calls: number
  balance: { balance: number | null; currency: string; isAvailable: boolean; lastFetch: number | null }
}

/* ------------------------------------------------------------------ *
 * Runtime plumbing (loosely typed service façade)
 * ------------------------------------------------------------------ */

interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: string; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
  }): {
    done: Promise<{ exitCode: number | null; signal: unknown }>
    collected: { stdout: { readFrom(offset: number): { text: string } } }
  }
}

interface FsLike {
  resolve(path: string, opts?: { cwd?: string }): Promise<{ [k: string]: unknown }>
  readText(target: unknown): Promise<string>
}

type HostCtx = {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: unknown, res: {
        writeHead(status: number, headers: Record<string, string>): void
        end(body: string): void
      }) => void | Promise<void>
    }): () => void
  }
  interval(fn: () => void | Promise<void>, ms: number): () => void
  on(event: string, listener: (...args: any[]) => any): () => void
}

const EMPTY_COST: CostSnapshot = {
  ok: true,
  isOffPeak: true,
  isPeak: false,
  localTime: '',
  offPeakDiscount: 0.5,
  beijingTime: '',
  sessionCost: 0,
  unknownPricing: false,
  burnPerMin: null,
  costCurrency: 'CNY',
  fxRate: null,
  fxSource: 'none',
  model: null,
  reasoningEffort: null,
  calls: 0,
  balance: { balance: null, currency: 'USD', isAvailable: false, lastFetch: null },
}

export function apply(ctx: Context, cfg?: Partial<Config>): void {
  const c = ctx as unknown as HostCtx
  const fsRef = ctx.get('fs') as FsLike | undefined
  const config = (cfg ?? {}) as Config

  const sessions = new Map<string, SessionState>()
  const balanceState = { balance: null as number | null, currency: 'USD', isAvailable: false, lastFetch: null as number | null }
  // Live CNY→X rates from the FX API; kept across polls so a transient
  // failure degrades to the last known live map, then the configured fallback.
  const fxState = { rates: {} as Record<string, number>, lastFetch: null as number | null }
  // Single-slot attribution: usage is attributed to the most recent agent/session-start.
  let currentSessionId: string | null = null

  async function resolveKey(): Promise<string | null> {
    // 1. Direct env (cheap, wins if the process carries it).
    const fromEnv = process.env.DEEPSEEK_API_KEY
    if (fromEnv) return fromEnv
    // 2. Credentials yaml: $DSH_HOME → $USERPROFILE/.dsh → relative .dsh.
    if (fsRef === undefined) return null
    const home = process.env.DSH_HOME || (process.env.USERPROFILE ? process.env.USERPROFILE + '/.dsh' : '')
    const candidates: string[] = []
    if (home) candidates.push(home + '/.credentials.yaml')
    if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE + '/.dsh/.credentials.yaml')
    candidates.push('.dsh/.credentials.yaml')
    for (const cand of candidates) {
      try {
        const target = await fsRef.resolve(cand)
        const key = parseKeyFromYaml(await fsRef.readText(target))
        if (key) return key
      } catch {
        /* unreadable/rejected candidate → try next */
      }
    }
    return null
  }

  let polling = false
  async function pollBalance(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const apiKey = await resolveKey()
      if (!apiKey) {
        balanceState.isAvailable = false
        return
      }
      const sub = ctx.get('subprocess') as SubprocessLike | undefined
      if (sub === undefined) return
      const handle = sub.spawn({
        argv: buildBalanceArgs(apiKey),
        cwd: '.',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 4096 } },
        graceMs: 10000,
      })
      await handle.done
      const text = handle.collected.stdout.readFrom(0).text
      const split = splitCurlOutput(text)
      if (split.code !== '200') {
        balanceState.isAvailable = false
        return
      }
      const parsed = parseBalance(split.body)
      balanceState.balance = parsed.balance
      balanceState.currency = parsed.currency
      balanceState.isAvailable = parsed.isAvailable
      balanceState.lastFetch = Date.now()
    } catch {
      balanceState.isAvailable = false
    } finally {
      polling = false
    }
  }

  let fxPolling = false
  async function refreshFxRates(): Promise<void> {
    if (fxPolling) return
    fxPolling = true
    try {
      const sub = ctx.get('subprocess') as SubprocessLike | undefined
      if (sub === undefined) return
      const handle = sub.spawn({
        argv: buildFxArgs(),
        cwd: '.',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 4096 } },
        graceMs: 10000,
      })
      await handle.done
      const text = handle.collected.stdout.readFrom(0).text
      const split = splitCurlOutput(text)
      if (split.code !== '200') return
      const parsed = parseFxRates(split.body)
      if (parsed.ok) {
        fxState.rates = parsed.rates
        fxState.lastFetch = Date.now()
      }
    } catch {
      /* keep the last known live rates */
    } finally {
      fxPolling = false
    }
  }

  function buildSnapshot(): CostSnapshot {
    const s = currentSessionId ? sessions.get(currentSessionId) : undefined
    const peak = computePeakState(new Date())
    const cost = s ? sessionCost(s.calls) : { total: 0, unknown: false }

    // User-currency display: convert the CNY cost into the account's balance
    // currency when the balance poll succeeded. FX = live rate map first,
    // then the configured fallback; without either, cost stays CNY.
    let displayCurrency = 'CNY'
    let fx: FxResolution | null = null
    const balanceCurrency = balanceState.isAvailable ? balanceState.currency : ''
    if (balanceCurrency && balanceCurrency !== 'CNY') {
      fx = resolveFxRate(balanceCurrency, fxState.rates, config)
      if (fx) displayCurrency = balanceCurrency
    }
    const factor = fx ? fx.rate : 1
    const displayCost = cost.total * factor

    let burnPerMin: number | null = null
    if (s && s.startedMs) {
      const elapsedMin = (Date.now() - s.startedMs) / 60000
      if (elapsedMin > 0 && displayCost > 0) burnPerMin = displayCost / elapsedMin
    }
    return {
      ok: true,
      isOffPeak: peak.isOffPeak,
      isPeak: peak.isPeak,
      localTime: peak.localTime,
      offPeakDiscount: peak.offPeakDiscount,
      beijingTime: peak.beijingTime,
      sessionCost: displayCost,
      unknownPricing: cost.unknown,
      burnPerMin,
      costCurrency: displayCurrency,
      fxRate: fx ? fx.rate : null,
      fxSource: fx ? fx.source : 'none',
      model: s ? s.model : null,
      reasoningEffort: s ? s.effort : null,
      calls: s ? s.calls.length : 0,
      balance: {
        balance: balanceState.balance,
        currency: balanceState.currency,
        isAvailable: balanceState.isAvailable,
        lastFetch: balanceState.lastFetch,
      },
    }
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Wrap the llm/stream waterfall: pass every chunk through untouched, capture
    // the terminal usage chunk per completed call, attribute to the current session.
    disposers.push(
      c.on('llm/stream', (options: { model?: string; reasoningEffort?: string }, next: () => AsyncIterable<unknown>) => {
        const stream = next()
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream
        return accumulateStream(stream, (usage) => {
          if (!currentSessionId) return
          recordUsage(sessions, currentSessionId, options, usage, new Date())
        })
      }),
    )

    disposers.push(
      c.on('agent/session-start', ({ agent }: { agent?: { id?: string } }) => {
        if (!agent || !agent.id) return
        currentSessionId = agent.id
        if (!sessions.has(agent.id)) {
          sessions.set(agent.id, { calls: [], startedMs: null, model: null, effort: null })
        }
        pruneSessions(sessions, agent.id)
      }),
    )

    disposers.push(c.interval(() => void pollBalance(), 60000))
    void pollBalance()

    disposers.push(c.interval(() => void refreshFxRates(), config.fxRefreshMs ?? 3600000))
    void refreshFxRates()

    disposers.push(
      c.webServer.register({
        kind: 'exact',
        path: '/deepseek-cost/api',
        handler: async (_req, res) => {
          try {
            const body = JSON.stringify(buildSnapshot())
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(body)
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ...EMPTY_COST, ok: false, error: String((e as Error)?.message ?? e) }))
          }
        },
      }),
    )

    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* best-effort teardown */
        }
      }
    }
  })
}
