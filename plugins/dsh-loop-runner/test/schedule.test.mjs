/**
 * Schedule math tests — run with: node test/schedule.test.mjs
 */
import assert from 'node:assert/strict'
import { normalizeSchedule, nextAfter, parseCron, describeSchedule } from '../lib/core/schedule.js'

let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message.split('\n').slice(0, 4).join('\n       ')}`)
  }
}

console.log('dsh-loop-runner schedule tests\n')

// ---- normalization -------------------------------------------------------

check('interval accepted and floored validation rejects < 10s', () => {
  const s = normalizeSchedule({ intervalSeconds: 600 })
  assert.equal(s.kind, 'interval')
  assert.equal(s.intervalSeconds, 600)
  assert.throws(() => normalizeSchedule({ intervalSeconds: 5 }), />= 10/)
})

check('cron accepted; 5 fields enforced', () => {
  const s = normalizeSchedule({ cron: '0 9 * * 1-5' })
  assert.equal(s.kind, 'cron')
  assert.throws(() => normalizeSchedule({ cron: '0 9 * *' }), /5 fields/)
  assert.throws(() => normalizeSchedule({ cron: '61 9 * * *' }), /bounds/)
  assert.throws(() => normalizeSchedule({ cron: 'a 9 * * *' }), /invalid cron field/)
})

check('empty / malformed schedule rejected', () => {
  assert.throws(() => normalizeSchedule(null), /object/)
  assert.throws(() => normalizeSchedule({}), /one of/)
  assert.throws(() => normalizeSchedule({ runAt: 'not-a-date' }), /runAt/)
})

// ---- interval ------------------------------------------------------------

check('interval rolls forward from the given instant', () => {
  const s = normalizeSchedule({ intervalSeconds: 60 })
  const t0 = 1700000000000
  assert.equal(nextAfter(s, t0), t0 + 60000)
  assert.equal(nextAfter(s, t0 + 60000), t0 + 120000)
})

// ---- cron ----------------------------------------------------------------

check('daily 09:00 fires at the next 09:00 boundary (local time)', () => {
  const s = normalizeSchedule({ cron: '0 9 * * *' })
  const from = new Date(2026, 9, 12, 10, 30, 0).getTime() // Oct 12 2026 10:30 local
  const next = nextAfter(s, from)
  const d = new Date(next)
  assert.equal(d.getHours(), 9)
  assert.equal(d.getMinutes(), 0)
  assert.equal(d.getSeconds(), 0)
  assert.equal(d.getDate(), 13) // tomorrow
})

check('same-minute fire is excluded (exclusive nextAfter)', () => {
  const s = normalizeSchedule({ cron: '30 9 * * *' })
  const at = new Date(2026, 9, 12, 9, 30, 0).getTime()
  const next = nextAfter(s, at)
  assert.equal(new Date(next).getDate(), 13)
})

check('step and list fields work (*/15 minutes, hours 9,18)', () => {
  const s = normalizeSchedule({ cron: '*/15 9,18 * * *' })
  const from = new Date(2026, 9, 12, 9, 0, 0).getTime()
  let next = nextAfter(s, from)
  assert.equal(new Date(next).getMinutes(), 15)
  next = nextAfter(s, next)
  assert.equal(new Date(next).getMinutes(), 30)
  // After 09:45 the next slot is 18:00.
  const after945 = new Date(2026, 9, 12, 9, 46, 0).getTime()
  next = nextAfter(s, after945)
  assert.equal(new Date(next).getHours(), 18)
  assert.equal(new Date(next).getMinutes(), 0)
})

check('dow: weekday-only cron skips the weekend', () => {
  const s = normalizeSchedule({ cron: '0 9 * * 1-5' })
  // Friday Oct 16 2026 10:00 -> Monday Oct 19 09:00.
  const from = new Date(2026, 9, 16, 10, 0, 0).getTime()
  const next = new Date(nextAfter(s, from))
  assert.equal(next.getDay(), 1)
  assert.equal(next.getDate(), 19)
})

check('dow 7 is Sunday too', () => {
  const ast = parseCron('0 9 * * 7')
  assert.ok(ast.dow.has(0))
})

check('dom+dow both restricted = either matches (vixie rule)', () => {
  // "0 0 13 * 5" — the 13th OR any Friday.
  const s = normalizeSchedule({ cron: '0 0 13 * 5' })
  // Nov 12 2026 is a Thursday -> next fire is Fri Nov 13 (both conditions).
  const from = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const next = new Date(nextAfter(s, from))
  assert.equal(next.getDate(), 13)
  // Nov 14 (Sat) after the 13th -> next is Fri Nov 20 (dow match, dom=20 no, dow=5 yes).
  const from2 = new Date(2026, 10, 14, 12, 0, 0).getTime()
  const next2 = new Date(nextAfter(s, from2))
  assert.equal(next2.getDay(), 5)
})

check('unreachable cron returns null within the lookahead', () => {
  const s = normalizeSchedule({ cron: '0 0 31 2 *' }) // Feb 31
  assert.equal(nextAfter(s, Date.now()), null)
})

// ---- once ----------------------------------------------------------------

check('one-shot fires only while ahead, then never', () => {
  const future = Date.now() + 3600000
  const s = normalizeSchedule({ runAt: future })
  assert.equal(nextAfter(s, Date.now()), future)
  const past = normalizeSchedule({ runAt: Date.now() - 1000 })
  assert.equal(nextAfter(past, Date.now()), null)
  const iso = normalizeSchedule({ runAt: new Date(future).toISOString() })
  assert.equal(iso.runAt, future)
})

// ---- describe ------------------------------------------------------------

check('describeSchedule renders compact labels', () => {
  assert.equal(describeSchedule(normalizeSchedule({ intervalSeconds: 600 })), 'every 10min')
  assert.match(describeSchedule(normalizeSchedule({ cron: '0 9 * * *' })), /^cron 0 9/)
  assert.match(describeSchedule(normalizeSchedule({ runAt: Date.now() + 60000 })), /^once /)
})

console.log(failed === 0 ? '\nschedule: all passed' : `\nschedule: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
