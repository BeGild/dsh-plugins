/**
 * Consumer tests: claim→escalate→ack, failure backoff, dead-lettering,
 * concurrency cap, boot recovery, requeue.
 * Run with: node test/consumer.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../lib/core/store.js'
import { Consumer, retryBackoffMs } from '../lib/core/consumer.js'

let failed = 0
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${label}`))
    .catch((error) => {
      failed++
      console.log(`  FAIL ${label}\n       ${String(error.message).split('\n').slice(0, 4).join('\n       ')}`)
    })
}
const dir = () => mkdtempSync(path.join(tmpdir(), 'loop-consumer-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quietLogger = { info() {}, warn() {}, error() {} }

function makeConsumer(escalate, opts = {}) {
  const d = dir()
  let now = 1700000000000
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5, now: () => now }).load()
  const consumer = new Consumer({
    store,
    escalate: async (job, event) => escalate(job, event),
    maxConcurrent: opts.maxConcurrent ?? 2,
    maxAttempts: opts.maxAttempts ?? 5,
    logger: quietLogger,
    now: () => now,
  })
  return {
    consumer, store, d,
    tick: (ms) => { now += ms },
    enqueue: (jobId = 'j1') => {
      store.upsertJob(store.getJob(jobId) ?? { id: jobId, kind: 'watch', title: jobId, escalation: {} })
      return store.enqueueEvent(jobId, { candidates: [] })
    },
  }
}

console.log('dsh-loop-runner consumer tests\n')

await check('success acks: consumed + consumedAt set', async () => {
  const { consumer, store, d, enqueue } = makeConsumer(async () => ({ ok: true, text: 'done', sessionId: 's1' }))
  const event = enqueue()
  consumer.pump()
  await sleep(20)
  const row = store.state.events.find((e) => e.eventId === event.eventId)
  assert.equal(row.status, 'consumed')
  assert.ok(row.consumedAt > 0)
  assert.equal(consumer.inFlight.size, 0)
  rmSync(d, { recursive: true, force: true })
})

await check('failure returns to pending with backoff, then dead after maxAttempts', async () => {
  const { consumer, store, d, enqueue, tick } = makeConsumer(async () => ({ ok: false, error: 'agent down' }), { maxAttempts: 2 })
  const event = enqueue()
  consumer.pump()
  await sleep(20)
  let row = store.state.events.find((e) => e.eventId === event.eventId)
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, 1)
  assert.ok(row.nextAttemptAt > 1700000000000, 'backoff scheduled')
  assert.match(row.lastError, /agent down/)

  // Still inside backoff: pump picks nothing.
  assert.equal(consumer.pump(), 0)

  // Backoff expires -> retry -> second failure -> dead.
  tick(retryBackoffMs(1) + 1000)
  consumer.pump()
  await sleep(20)
  row = store.state.events.find((e) => e.eventId === event.eventId)
  assert.equal(row.attempts, 2)
  assert.equal(row.status, 'dead')
  rmSync(d, { recursive: true, force: true })
})

await check('escalate() throwing is treated as a failure, not a crash', async () => {
  const { consumer, store, d, enqueue } = makeConsumer(async () => { throw new Error('kaboom') })
  const event = enqueue()
  consumer.pump()
  await sleep(20)
  const row = store.state.events.find((e) => e.eventId === event.eventId)
  assert.equal(row.status, 'pending')
  assert.match(row.lastError, /kaboom/)
  rmSync(d, { recursive: true, force: true })
})

await check('concurrency cap: max 2 escalations at a time', async () => {
  let active = 0
  let peak = 0
  const { consumer, store, d, enqueue } = makeConsumer(async () => {
    active++
    peak = Math.max(peak, active)
    await sleep(40)
    active--
    return { ok: true }
  })
  enqueue('j1')
  enqueue('j2')
  enqueue('j3')
  const started = consumer.pump()
  assert.equal(started, 2, 'only two claims issued')
  assert.equal(consumer.inFlight.size, 2)
  await sleep(20)
  assert.equal(store.state.events.filter((e) => e.status === 'in-flight').length, 2)
  await sleep(60)
  assert.equal(peak, 2)
  // Third fires after slots free.
  const more = consumer.pump()
  assert.equal(more, 1)
  await sleep(60)
  assert.equal(store.eventCounts().consumed, 3)
  rmSync(d, { recursive: true, force: true })
})

await check('boot recovery returns crashed in-flight rows to pending', async () => {
  const { consumer, store, d, enqueue } = makeConsumer(async () => ({ ok: true }))
  const event = enqueue()
  store.mutate((s) => { s.events[0].status = 'in-flight'; s.events[0].claimedAt = 1 })
  const recovered = consumer.recoverInFlight()
  assert.equal(recovered, 1)
  assert.equal(store.state.events[0].status, 'pending')
  rmSync(d, { recursive: true, force: true })
})

await check('requeue revives dead events and lifts pending backoff', async () => {
  const { consumer, store, d, enqueue, tick } = makeConsumer(async () => ({ ok: false }), { maxAttempts: 2 })
  // First event: fail twice -> dead.
  const dead = enqueue()
  consumer.pump()
  await sleep(20)
  tick(retryBackoffMs(1) + 1000)
  consumer.pump()
  await sleep(20)
  assert.equal(store.state.events.find((e) => e.eventId === dead.eventId).status, 'dead')

  // Second event: one failure -> pending with backoff still in the future.
  const pending = enqueue()
  consumer.pump()
  await sleep(20)
  assert.ok(store.state.events.find((e) => e.eventId === pending.eventId).nextAttemptAt > 0)

  const count = consumer.requeue('j1')
  assert.equal(count, 2, 'one dead revived + one backoff lifted')
  const rows = store.state.events
  assert.equal(rows.filter((e) => e.status === 'dead').length, 0)
  assert.ok(rows.every((e) => e.nextAttemptAt === 0 || e.status === 'consumed'))
  rmSync(d, { recursive: true, force: true })
})

await check('orphan events of removed jobs are dropped, not looped', async () => {
  const { consumer, store, d, enqueue } = makeConsumer(async () => ({ ok: true }))
  const event = enqueue('ghost')
  // Simulate hand-edited state: the event outlives its job record.
  store.mutate((s) => { delete s.jobs.ghost })
  consumer.pump()
  await sleep(20)
  assert.equal(store.state.events.find((e) => e.eventId === event.eventId).status, 'dead')
  assert.equal(consumer.inFlight.size, 0)
  rmSync(d, { recursive: true, force: true })
})

await check('backoff curve: capped at 1h', () => {
  assert.equal(retryBackoffMs(0), 60000)
  assert.equal(retryBackoffMs(1), 120000)
  assert.equal(retryBackoffMs(2), 240000)
  assert.equal(retryBackoffMs(10), 3600000)
})

console.log(failed === 0 ? '\nconsumer: all passed' : `\nconsumer: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
