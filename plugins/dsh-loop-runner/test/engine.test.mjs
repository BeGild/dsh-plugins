/**
 * Engine tests: dedupe/baseline/aggregation pipeline, at-most-once claiming,
 * agent-fire dispatch, runNow re-anchoring, and one REAL adapter child
 * process (happy path + nonzero exit + timeout).
 * Run with: node test/engine.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../lib/core/store.js'
import { Engine, runAdapterProcess, parseCandidateLines, groupCandidates, buildEventPayload } from '../lib/core/engine.js'

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
const dir = () => mkdtempSync(path.join(tmpdir(), 'loop-engine-'))
const quietLogger = { info() {}, warn() {}, error() {} }

function makeEngine(overrides = {}) {
  const d = dir()
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5 }).load()
  const fired = { events: [], agents: [] }
  const engine = new Engine({
    store,
    runAdapter: overrides.runAdapter ?? (async () => ({ records: [] })),
    onEvent: (job, event) => { fired.events.push({ job, event }) },
    onAgentFire: (job, trigger) => { fired.agents.push({ job, trigger }) },
    logger: quietLogger,
    now: () => engine.now2(),
    ...overrides,
  })
  engine.now2 = () => 1700000000000
  return { engine, store, fired, d }
}

function watchJob(partial = {}) {
  return {
    id: 'w1', kind: 'watch', title: 'w1', schedule: { kind: 'interval', intervalSeconds: 60 },
    adapter: { file: 'C:/x/adapter.js', timeoutSeconds: 5 }, baseline: 'ignore',
    filter: { aggregateWindowSeconds: 0 }, escalation: { instructions: 'handle' },
    paused: false, initialized: false, nextRunAt: 1700000000000, lastStatus: 'registered', lastError: null,
    ...partial,
  }
}

console.log('dsh-loop-runner engine tests\n')

await check('baseline ignore: first poll records, does not enqueue', async () => {
  const { engine, store, fired, d } = makeEngine({ runAdapter: async () => ({ records: [{ id: 'a', payload: 1 }, { id: 'b', payload: 2 }] }) })
  store.upsertJob(watchJob())
  const fresh = engine.ingestCandidates(store.getJob('w1'), [{ id: 'a', payload: 1 }, { id: 'b', payload: 2 }])
  assert.equal(fresh, 0, 'first poll enqueues nothing under baseline=ignore')
  assert.equal(Object.keys(store.state.seen.w1).length, 2, 'candidates recorded')
  // Second poll: nothing new.
  assert.equal(engine.ingestCandidates(store.getJob('w1'), [{ id: 'a', payload: 1 }]), 0)
  // Third poll: one new candidate -> one event.
  assert.equal(engine.ingestCandidates(store.getJob('w1'), [{ id: 'c', payload: 3 }]), 1)
  assert.equal(fired.events.length, 1)
  assert.equal(fired.events[0].event.payload.candidates[0].id, 'c')
  rmSync(d, { recursive: true, force: true })
})

await check('baseline enqueue processes the first poll too', async () => {
  const { engine, store, fired, d } = makeEngine()
  store.upsertJob(watchJob({ baseline: 'enqueue' }))
  assert.equal(engine.ingestCandidates(store.getJob('w1'), [{ id: 'a', payload: 1 }]), 1)
  assert.equal(fired.events.length, 1)
  rmSync(d, { recursive: true, force: true })
})

await check('aggregation window groups by group_key and splits on gaps', async () => {
  const groups = groupCandidates([
    { id: '1', payload: {}, group_key: 'chat', occurred_at: '2026-10-12T09:00:00Z' },
    { id: '2', payload: {}, group_key: 'chat', occurred_at: '2026-10-12T09:00:20Z' },
    { id: '3', payload: {}, group_key: 'chat', occurred_at: '2026-10-12T09:05:00Z' },
    { id: '4', payload: {} },
  ], 30)
  assert.equal(groups.length, 3, 'chat splits into 2, id-keyed singleton 1')
  assert.deepEqual(groups[0].map((c) => c.id), ['1', '2'])
  assert.deepEqual(groups[1].map((c) => c.id), ['3'])
  assert.deepEqual(groups[2].map((c) => c.id), ['4'])
})

await check('event payload carries instructions + watcher identity', () => {
  const payload = buildEventPayload(watchJob({ eventType: 'mail.new' }), [{ id: 'x', payload: { subject: 'hi' } }])
  assert.equal(payload.event_type, 'mail.new')
  assert.equal(payload.watcher, 'w1')
  assert.equal(payload.instructions, 'handle')
  assert.equal(payload.candidates[0].payload.subject, 'hi')
})

await check('at-most-once: tick claims by rolling nextRunAt; duplicate ticks skip', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 80))
  const { engine, store, fired, d } = makeEngine({ runAdapter: async () => { await slow; return { records: [] } } })
  store.upsertJob(watchJob())
  await engine.tick()
  assert.equal(store.getJob('w1').nextRunAt, 1700000000000 + 60000, 'nextRunAt rolled while running')
  // A second tick in the same instant must not double-fire.
  await engine.tick()
  // Let the first execution finish and confirm exactly one execution row.
  await slow
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(store.listExecutions('w1').length, 1)
  assert.equal(fired.events.length, 0)
  rmSync(d, { recursive: true, force: true })
})

await check('paused and not-yet-due jobs never fire', async () => {
  const { engine, store, fired, d } = makeEngine({ runAdapter: async () => ({ records: [{ id: 'z', payload: 1 }] }) })
  store.upsertJob(watchJob({ id: 'paused1', paused: true }))
  store.upsertJob(watchJob({ id: 'future', nextRunAt: 1700000000000 + 999999 }))
  await engine.tick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(store.listExecutions('paused1').length, 0)
  assert.equal(store.listExecutions('future').length, 0)
  assert.equal(fired.events.length, 0)
  rmSync(d, { recursive: true, force: true })
})

await check('failed adapter marks job failed with error, keeps events', async () => {
  const { engine, store, d } = makeEngine({ runAdapter: async () => { throw new Error('boom') } })
  store.upsertJob(watchJob())
  await engine.tick()
  await new Promise((r) => setTimeout(r, 20))
  const job = store.getJob('w1')
  assert.equal(job.lastStatus, 'failed')
  assert.match(job.lastError, /boom/)
  assert.equal(store.listExecutions('w1')[0].status, 'failed')
  rmSync(d, { recursive: true, force: true })
})

await check('agent jobs dispatch to onAgentFire and record success', async () => {
  const { engine, store, fired, d } = makeEngine()
  store.upsertJob({
    id: 'a1', kind: 'agent', title: 'a1', schedule: { kind: 'interval', intervalSeconds: 60 },
    escalation: { instructions: 'run report' }, paused: false, nextRunAt: 1700000000000,
  })
  await engine.tick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(fired.agents.length, 1)
  assert.equal(fired.agents[0].trigger, 'schedule')
  assert.equal(store.listExecutions('a1')[0].status, 'success')
  rmSync(d, { recursive: true, force: true })
})

await check('one-shot job marks done after firing; no next run', async () => {
  const { engine, store, fired, d } = makeEngine()
  store.upsertJob(watchJob({ id: 'once1', schedule: { kind: 'once', runAt: 1700000000000 - 1 } }))
  await engine.tick()
  await new Promise((r) => setTimeout(r, 20))
  const job = store.getJob('once1')
  assert.equal(job.nextRunAt, null)
  assert.equal(job.done, true)
  assert.equal(store.listExecutions('once1').length, 1)
  rmSync(d, { recursive: true, force: true })
})

await check('runNow re-anchors interval and fires immediately; skips when running', async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 60))
  const { engine, store, d } = makeEngine({ runAdapter: async () => { await slow; return { records: [] } } })
  store.upsertJob(watchJob())
  const r1 = await engine.runNow('w1')
  assert.equal(r1.fired, true)
  const r2 = await engine.runNow('w1')
  assert.equal(r2.fired, false)
  await slow
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(store.listExecutions('w1').length, 1)
  assert.ok(store.getJob('w1').nextRunAt > 1700000000000)
  rmSync(d, { recursive: true, force: true })
})

// ---- real child process adapter ------------------------------------------

await check('runAdapterProcess: real node child, JSON Lines happy path', async () => {
  const d = dir()
  const file = path.join(d, 'adapter.js')
  writeFileSync(file, `const out = [{id:'m1',payload:{v:1},group_key:'g'},{id:'m2',payload:{v:2}}];\nfor (const r of out) console.log(JSON.stringify(r));\n`, 'utf8')
  const { records } = await runAdapterProcess({ file, timeoutSeconds: 10 })
  assert.equal(records.length, 2)
  assert.equal(records[0].id, 'm1')
  rmSync(d, { recursive: true, force: true })
})

await check('runAdapterProcess: nonzero exit rejects with stderr detail', async () => {
  const d = dir()
  const file = path.join(d, 'adapter.js')
  writeFileSync(file, `console.error('source unreachable');\nprocess.exit(2);\n`, 'utf8')
  await assert.rejects(() => runAdapterProcess({ file, timeoutSeconds: 10 }), /source unreachable/)
  rmSync(d, { recursive: true, force: true })
})

await check('runAdapterProcess: hard timeout kills a hanging adapter', async () => {
  const d = dir()
  const file = path.join(d, 'adapter.js')
  writeFileSync(file, `setTimeout(() => {}, 30000);\n`, 'utf8')
  await assert.rejects(() => runAdapterProcess({ file, timeoutSeconds: 1 }), /timed out after 1s/)
  // Windows: give the killed child a moment to release its file handles.
  await new Promise((r) => setTimeout(r, 500))
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch { /* temp dir; the OS will reap it */ }
})

await check('parseCandidateLines validates the contract strictly', () => {
  assert.deepEqual(parseCandidateLines(''), [])
  assert.deepEqual(parseCandidateLines('\n\n'), [])
  const ok = parseCandidateLines('{"id":"a","payload":1}\n{"id":"b","payload":null}')
  assert.equal(ok.length, 2)
  assert.throws(() => parseCandidateLines('not json'), /not JSON/)
  assert.throws(() => parseCandidateLines('{"payload":1}'), /stable non-empty string id/)
  assert.throws(() => parseCandidateLines('{"id":"a"}'), /requires a payload/)
  assert.throws(() => parseCandidateLines('{"id":"a","payload":1,"group_key":5}'), /group_key/)
  assert.throws(() => parseCandidateLines('[1,2]'), /JSON object/)
})

await check('SCENARIO_NOW env reaches the adapter process', async () => {
  const d = dir()
  const file = path.join(d, 'adapter.js')
  writeFileSync(file, `console.log(JSON.stringify({id:'pinned-' + process.env.SCENARIO_NOW, payload:{now: process.env.SCENARIO_NOW}}))\n`, 'utf8')
  const { records } = await runAdapterProcess({ file, timeoutSeconds: 10, env: { SCENARIO_NOW: '2026-10-12T09:00:00Z' } })
  assert.equal(records[0].id, 'pinned-2026-10-12T09:00:00Z')
  rmSync(d, { recursive: true, force: true })
})

console.log(failed === 0 ? '\nengine: all passed' : `\nengine: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
