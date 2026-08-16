/**
 * deepseek-cost-usage-status-plugin — client half (browser bundle).
 *
 * Polls the host's `/deepseek-cost/api` route every 2s and renders the
 * snapshot as a second, font-matched stats line in the
 * `conversation.composer.dock` slot (beside the shipped `stats` cell).
 *
 * This bundle ships as `exports["./client"]` (CJS ModuleLoader factory),
 * discovered via the `dsh.client` declaration in package.json.
 */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['slots']

const POLL_MS = 2000
const API = '/deepseek-cost/api'

interface Snapshot {
  ok: boolean
  error?: string
  stale?: boolean
  isOffPeak?: boolean
  isPeak?: boolean
  localTime?: string
  offPeakDiscount?: number
  beijingTime?: string
  sessionCost?: number
  unknownPricing?: boolean
  burnPerMin?: number | null
  costCurrency?: string
  model?: string | null
  reasoningEffort?: string | null
  calls?: number
  balance?: { balance?: number | null; currency?: string; isAvailable?: boolean; lastFetch?: number | null }
}

interface RenderedLine {
  peakChip: { text: string; color: string }
  costText: string
  burnText: string
  balanceText: string
  modelText: string
}

/** Port of the dynamic plugin's renderSnapshot; burn rate now uses the cost currency. */
function renderSnapshot(snap: Snapshot | null): RenderedLine {
  if (snap === null || snap.ok !== true) {
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

  const cost = typeof snap.sessionCost === 'number' && Number.isFinite(snap.sessionCost) ? snap.sessionCost : 0
  const costSymbol = snap.costCurrency === 'CNY' ? '¥' : '$'
  const costText = 'Cost ' + costSymbol + cost.toFixed(4)

  let burnText = '~—/min'
  if (snap.burnPerMin != null) {
    const burn = Number(snap.burnPerMin)
    if (Number.isFinite(burn)) burnText = '~' + costSymbol + burn.toFixed(2) + '/min'
  }

  let balanceText = 'Balance —'
  const b = snap.balance
  if (b && b.isAvailable && b.balance != null) {
    const bal = Number(b.balance)
    if (Number.isFinite(bal)) {
      const currency = b.currency
      balanceText = currency && currency !== 'USD'
        ? 'Balance ' + bal.toFixed(2) + ' ' + currency
        : 'Balance $' + bal.toFixed(2)
    }
  }

  const modelText = snap.model ? 'Model ' + snap.model : ''
  return { peakChip, costText, burnText, balanceText, modelText }
}

export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as
    | {
        inject(name: string, callback: () => () => void): void
        register(
          options: { name: string; id: string; order?: number; label?: string },
          component: (props: unknown) => React.ReactNode,
        ): () => void
      }
    | undefined
  if (slots === undefined) return

  // ---- shared poller (module-scoped within this apply) ----
  let snapshot: Snapshot | null = null
  let lastGood: Snapshot | null = null
  const listeners = new Set<() => void>()

  async function poll(): Promise<void> {
    try {
      const res = await fetch(API, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      snapshot = (await res.json()) as Snapshot
      if (snapshot.ok) lastGood = snapshot
    } catch (e) {
      snapshot = { ok: false, error: String((e as Error)?.message ?? e) }
    }
    for (const fn of listeners) fn()
  }
  void poll()
  const timer = setInterval(() => void poll(), POLL_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
    listeners.clear()
  })

  function useSnapshot(): Snapshot | null {
    const [state, setState] = React.useState<Snapshot | null>(snapshot)
    React.useEffect(() => {
      const fn = () => {
        let out = snapshot
        if (snapshot && !snapshot.ok && lastGood !== null) {
          out = { ...lastGood, stale: true }
        }
        setState(out)
      }
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }, [])
    return state
  }

  function DockLine(): React.ReactElement {
    const snap = useSnapshot()
    const r = renderSnapshot(snap)
    // Match the shipped stats line (StatsLine.module.scss root): 12px/20px,
    // muted tertiary label color, centered, nowrap block, separators using
    // the separator token — so this dock line reads as the same family.
    return React.createElement(
      'span',
      {
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

  slots.inject('conversation.composer.dock', () =>
    slots.register(
      { name: 'conversation.composer.dock', id: 'deepseek-cost-status', order: 1 },
      () => React.createElement(DockLine),
    ),
  )
}
