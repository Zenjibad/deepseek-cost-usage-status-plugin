// Reference copy of the live deepseek-cost-status dynamic Cordis plugin.
// Authoritative source lives in the Cordis package registry (pluginId dsb-9,
// current package pkg-16) — this file is a versioned mirror for review/rollback.
// Feed these strings back into cordis_define code.host / code.client to recreate.
module.exports = {
  name: 'deepseek-cost-status',
  purpose: 'Live DeepSeek API cost/usage/balance dashboard for DSH web — composer dock line + per-session token/cost tracking.',
  host: `// host-half.js — Host half of the DeepSeek cost-status plugin (DSB), assembled into code.host.
// Pure helpers inlined from peak-clock.js (computePeakState) and cost-engine.js
// (PRICING / estimateCallCost / sessionCost); no Node-global references — core JS only.
// Function body ending in \`return Host()\`. \`harness\` is a top-level builtin;
// ctx services come from the inject list.
'use strict'

function computePeakState(date) {
  // DeepSeek's official peak hours are in BEIJING time (UTC+8): 09:00-12:00
  // and 14:00-18:00; everything else is idle/off-peak (idle = 50% of peak).
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
    localOffsetNote: 'local ' + Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

// Official DeepSeek 2026-08-17 CNY pricing (PEAK-class per 1M tokens).
// input = cache-MISS; cacheRead = cache-HIT; output = single rate for thinking & non-thinking.
const PRICING = {
  'deepseek-v4-flash': { input: 3.0, cacheRead: 0.10, output: 9.0, reasoning: 9.0, currency: 'CNY' },
  'deepseek-v4-pro':   { input: 9.0, cacheRead: 0.30, output: 27.0, reasoning: 27.0, currency: 'CNY' },
}

function estimateCallCost(usage, model, isOffPeak, offPeakDiscount) {
  const p = PRICING[model]
  if (!p) return null
  const f = isOffPeak ? (1 - (offPeakDiscount || 0)) : 1
  const perTok = (perM) => perM / 1e6
  const input = (usage.inputTokens || 0) * perTok(p.input)
  const cache = (usage.cacheReadTokens || 0) * perTok(p.cacheRead)
  let output = (usage.outputTokens || 0) * perTok(p.output)
  const reasoning = (usage.reasoningTokens || 0) * perTok(Math.max(p.reasoning - p.output, 0))
  output = output + reasoning
  return (input + cache + output) * f
}

function sessionCost(calls) {
  let total = 0, unknown = false
  for (const c of calls) {
    if (!c) continue
    const cost = estimateCallCost(c.usage || {}, c.model, c.isOffPeak, c.offPeakDiscount)
    if (cost === null) unknown = true
    else total += cost
  }
  return { total, unknown }
}

function splitCurlOutput(text) {
  const s = String(text == null ? '' : text)
  const nl = s.lastIndexOf('\\n')
  if (nl < 0) return { code: s.trim(), body: '' }
  return { code: s.slice(nl + 1).trim(), body: s.slice(0, nl) }
}

function parseKeyFromYaml(text) {
  const m = /(?:^|\\n)[ \\t]*DEEPSEEK_API_KEY[ \\t]*:[ \\t]*([^\\s\\r\\n]+)/.exec(text || '')
  if (!m || !m[1]) return null
  return m[1].replace(/^["']+|["']+$/g, '')
}

async function readCredentialKey(fsLike, candidates) {
  if (!fsLike || typeof fsLike.resolve !== 'function' || typeof fsLike.readText !== 'function') return null
  for (const cand of candidates) {
    try {
      const target = await fsLike.resolve(cand)
      const key = parseKeyFromYaml(await fsLike.readText(target))
      if (key) return key
    } catch (e) { /* unreadable/rejected candidate → try next */ }
  }
  return null
}

function parseBalance(text) {
  try {
    const j = JSON.parse(text)
    const first = (j.balance_infos && j.balance_infos[0]) || {}
    return {
      isAvailable: !!j.is_available,
      balance: first.total_balance != null ? Number(first.total_balance) : null,
      currency: first.currency || 'USD',
    }
  } catch (e) {
    return { isAvailable: false, balance: null, currency: 'USD' }
  }
}

function buildBalanceArgs(apiKey) {
  // NOTE: the API key travels on the child process's command line (visible to
  // other processes on this machine) — accepted tradeoff for this readout tool.
  return [
    'curl.exe', '-sS',
    '-H', 'Authorization: Bearer ' + apiKey,
    '-w', '\\n%{http_code}',
    'https://api.deepseek.com/user/balance',
  ]
}

function recordUsage(sessions, sessionId, options, usage, now) {
  const s = sessions.get(sessionId)
  if (!s) return false
  const peak = computePeakState(now)
  s.calls.push({
    usage: usage && typeof usage === 'object' ? { ...usage } : usage,
    model: options.model,
    isOffPeak: peak.isOffPeak,
    offPeakDiscount: peak.offPeakDiscount,
    at: now.toISOString(),
  })
  s.model = options.model
  if (s.calls.length === 1) s.startedMs = now.getTime()
  if (options.reasoningEffort) s.effort = options.reasoningEffort
  return true
}

async function* accumulateStream(stream, onUsage) {
  let usage
  for await (const chunk of stream) {
    if (chunk && chunk.type === 'usage') usage = chunk.usage
    yield chunk
  }
  if (usage && typeof onUsage === 'function') {
    try {
      onUsage(usage)
    } catch (e) { /* a throw must never break streaming semantics */ }
  }
}

function pruneSessions(sessions, keepId) {
  for (const key of Array.from(sessions.keys())) {
    if (key !== keepId) sessions.delete(key)
  }
}

function Host() {
  return {
    inject: ['timer', 'subprocess', 'llm'],
    apply(ctx) {
      const sessions = new Map()
      const balanceState = { balance: null, currency: 'USD', isAvailable: false, lastFetch: null }
      // Single-slot attribution: usage attributed to the most recent agent/session-start.
      let currentSessionId = null

      async function resolveKey() {
        return readCredentialKey(ctx.get('fs'), [
          'C:\\\\Users\\\\Administrator\\\\.dsh\\\\.credentials.yaml',
          '.dsh\\\\.credentials.yaml',
        ])
      }

      const streamDisposer = ctx.on('llm/stream', (options, next) => {
        const stream = next()
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream
        return accumulateStream(stream, (usage) => {
          if (!currentSessionId) return
          recordUsage(sessions, currentSessionId, options, usage, new Date())
        })
      })

      const sessionDisposer = ctx.on('agent/session-start', ({ agent }) => {
        if (!agent || !agent.id) return
        currentSessionId = agent.id
        if (!sessions.has(agent.id)) {
          sessions.set(agent.id, { calls: [], startedMs: null, model: null, effort: null })
        }
        pruneSessions(sessions, agent.id)
      })

      let polling = false
      async function pollBalance() {
        if (polling) return
        polling = true
        try {
          const apiKey = await resolveKey()
          if (!apiKey) { balanceState.isAvailable = false; return }
          const handle = ctx.subprocess.spawn({
            argv: buildBalanceArgs(apiKey),
            cwd: '.',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 4096 } },
            graceMs: 10000,
          })
          await handle.done
          const text = handle.collected.stdout.readFrom(0).text
          const split = splitCurlOutput(text)
          if (split.code !== '200') { balanceState.isAvailable = false; return }
          const parsed = parseBalance(split.body)
          balanceState.balance = parsed.balance
          balanceState.currency = parsed.currency
          balanceState.isAvailable = parsed.isAvailable
          balanceState.lastFetch = Date.now()
        } catch (e) {
          balanceState.isAvailable = false
        } finally {
          polling = false
        }
      }
      const pollTimer = ctx.interval(() => { pollBalance() }, 60000)
      pollBalance()

      const snapshotDisposer = harness.handle('dsb-snapshot', () => {
        const s = currentSessionId ? sessions.get(currentSessionId) : undefined
        const peak = computePeakState(new Date())
        const cost = s ? sessionCost(s.calls) : { total: 0, unknown: false }
        let burnPerMin = null
        if (s && s.startedMs) {
          const elapsedMin = (Date.now() - s.startedMs) / 60000
          if (elapsedMin > 0 && cost.total > 0) burnPerMin = cost.total / elapsedMin
        }
        return {
          isOffPeak: peak.isOffPeak,
          isPeak: peak.isPeak,
          localTime: peak.localTime,
          offPeakDiscount: peak.offPeakDiscount,
          beijingTime: peak.beijingTime,
          sessionCost: cost.total,
          unknownPricing: cost.unknown,
          burnPerMin,
          costCurrency: (s && s.model && PRICING[s.model]) ? PRICING[s.model].currency : 'CNY',
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
      })

      return () => {
        if (typeof streamDisposer === 'function') streamDisposer()
        if (typeof sessionDisposer === 'function') sessionDisposer()
        if (typeof pollTimer === 'function') pollTimer()
        if (typeof snapshotDisposer === 'function') snapshotDisposer()
      }
    },
  }
}

return Host()
`,
  client: `// client-half.js — Client half of the DeepSeek cost-status plugin (DSB), assembled into code.client.
// Pure renderSnapshot + Client() returning the Cordis Client plugin object.
// Function body ending in \`return Client()\`. React and host are top-level builtins;
// slots/timer from the inject list; no styles.insert; plain JS only.
'use strict'

function renderSnapshot(snap) {
  if (snap === null || snap === undefined) {
    return {
      peakChip: { text: '…', color: '#808080' },
      costText: 'Cost …',
      burnText: '~—/min',
      balanceText: 'Balance —',
      modelText: '',
    }
  }
  const localTime = snap.localTime == null ? '' : snap.localTime
  const pct = Math.round((snap.offPeakDiscount || 0) * 100)
  const peakChip = snap.isOffPeak === true
    ? { text: '● Off-peak ' + localTime + ' · −' + pct + '%', color: '#2e7d32' }
    : { text: '● Peak ' + localTime, color: '#c62828' }

  const cost = (typeof snap.sessionCost === 'number' && Number.isFinite(snap.sessionCost))
    ? snap.sessionCost
    : 0
  const costSymbol = snap.costCurrency === 'CNY' ? '¥' : '$'
  const costText = 'Cost ' + costSymbol + cost.toFixed(4)

  let burnText = '~—/min'
  if (snap.burnPerMin != null) {
    const burn = Number(snap.burnPerMin)
    if (Number.isFinite(burn)) burnText = '~$' + burn.toFixed(2) + '/min'
  }

  let balanceText = 'Balance —'
  const b = snap.balance
  if (b && b.isAvailable && b.balance != null) {
    const bal = Number(b.balance)
    if (Number.isFinite(bal)) {
      const currency = b.currency
      balanceText = (currency && currency !== 'USD')
        ? 'Balance ' + bal.toFixed(2) + ' ' + currency
        : 'Balance $' + bal.toFixed(2)
    }
  }

  const modelText = snap.model ? 'Model ' + snap.model : ''
  return { peakChip, costText, burnText, balanceText, modelText }
}

function Client() {
  return {
    inject: ['slots', 'timer'],
    apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      function DockRow() {
        const [snapshot, setSnapshot] = React.useState(null)
        let inFlight = false
        function load() {
          if (inFlight) return
          inFlight = true
          return host.call('dsb-snapshot')
            .then((s) => { setSnapshot(s) })
            .catch(() => { setSnapshot(null) })
            .then(() => { inFlight = false })
        }
        React.useEffect(() => {
          load()
          return ctx.interval(load, 2000)
        }, [])

        const r = renderSnapshot(snapshot)
        // Match the shipped stats line (StatsLine.module.scss root): 12px/20px,
        // muted tertiary label color, centered, nowrap block, separators using
        // the separator token — so this dock line reads as the same family.
        return React.createElement('span', {
          className: 'dsb-line',
          style: {
            fontSize: 12,
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-tertiary)',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            display: 'block',
            width: '100%',
            paddingTop: 2,
          },
        },
          React.createElement('span', { style: { color: r.peakChip.color, fontWeight: 600 } }, r.peakChip.text),
          React.createElement('span', { style: { color: 'var(--dsw-alias-separator-primary)', margin: '0 10px' } }, '·'),
          React.createElement('span', null, r.costText),
          React.createElement('span', { style: { color: 'var(--dsw-alias-separator-primary)', margin: '0 10px' } }, '·'),
          React.createElement('span', null, r.burnText),
          React.createElement('span', { style: { color: 'var(--dsw-alias-separator-primary)', margin: '0 10px' } }, '·'),
          React.createElement('span', null, r.balanceText),
          r.modelText
            ? React.createElement('span', { style: { color: 'var(--dsw-alias-separator-primary)', margin: '0 10px' } }, '·')
            : null,
          r.modelText ? React.createElement('span', null, r.modelText) : null,
        )
      }

      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'deepseek-cost-status', order: 1 },
        () => React.createElement(DockRow, null),
      ))
    },
  }
}

return Client()
`,
}
