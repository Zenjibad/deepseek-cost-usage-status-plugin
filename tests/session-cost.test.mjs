import { recordUsage, sessionCost, pruneSessions, computePeakState } from '../lib/index.js'
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1) } }
const sessions = new Map()
const at = () => new Date('2026-08-17T01:00:00Z') // 09:00 Beijing MONDAY = PEAK, factor 1
const start = (id, usage) => {
  if (!sessions.has(id)) sessions.set(id, { calls: [], startedMs: null, model: null, effort: null })
  recordUsage(sessions, id, { model: 'deepseek-v4-flash' }, usage, at())
  pruneSessions(sessions, id)
}
// flash: in 3.0, out 9.0 per 1M; 2000 in + 500 out = 0.0105; 1000 in = 0.003
start('A', { inputTokens: 2000, outputTokens: 500 })
assert(sessions.has('A'), 'A exists after its own start')
assert(Math.abs(sessionCost(sessions.get('A').calls).total - 0.0105) < 1e-9, 'A cost = 0.0105')
start('B', { inputTokens: 1000 })
assert(sessions.has('B'), 'B exists after its own start')
assert(Math.abs(sessionCost(sessions.get('B').calls).total - 0.003) < 1e-9, 'B cost = 0.003')
assert(sessions.has('A'), 'A survives B starting (cost tied to session)')
assert(Math.abs(sessionCost(sessions.get('A').calls).total - 0.0105) < 1e-9, 'A cost preserved after switch to B')
start('A', { inputTokens: 1000 })
assert(Math.abs(sessionCost(sessions.get('A').calls).total - 0.0135) < 1e-9, 'A cost accumulates on return (0.0135)')
assert(Math.abs(sessionCost(sessions.get('B').calls).total - 0.003) < 1e-9, 'B cost preserved after A resumes')
for (let i = 0; i < 30; i++) start('S' + i, { inputTokens: 10 })
assert(sessions.size <= 20, 'session map bounded to <= 20 (' + sessions.size + ')')
// Weekend = always off-peak (Beijing-time Sat/Sun), even inside peak-hour windows.
const satPeakHours = computePeakState(new Date('2026-08-15T02:00:00Z')) // 10:00 Beijing Sat
const sunPeakHours = computePeakState(new Date('2026-08-16T02:00:00Z')) // 10:00 Beijing Sun
const monPeakHours = computePeakState(new Date('2026-08-17T02:00:00Z')) // 10:00 Beijing Mon (weekday)
assert(satPeakHours.isOffPeak === true && satPeakHours.isPeak === false, 'Saturday 10:00 Beijing is off-peak')
assert(sunPeakHours.isOffPeak === true && sunPeakHours.isPeak === false, 'Sunday 10:00 Beijing is off-peak')
assert(satPeakHours.offPeakDiscount === 0.5, 'Saturday off-peak discount 0.5')
assert(monPeakHours.isOffPeak === false && monPeakHours.isPeak === true, 'Monday 10:00 Beijing is peak')
console.log('PASS: per-session cost preserved, map bounded to ' + sessions.size)