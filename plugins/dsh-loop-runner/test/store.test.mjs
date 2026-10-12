/**
 * Store tests: atomic persistence, self-repair, pruning, queue semantics.
 * Run with: node test/store.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../lib/core/store.js'

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
const dir = () => mkdtempSync(path.join(tmpdir(), 'loop-store-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('dsh-loop-runner store tests\n')

check('fresh store saves atomically (tmp+rename) and reloads', async () => {
  const d = dir()
  const file = path.join(d, 'state.json')
  const store = new Store(file, { debounceMs: 10 }).load()
  store.upsertJob({ id: 'j1', kind: 'watch', title: 't' })
  store.enqueueEvent('j1', { hello: 1 })
  await sleep(60)
  store.flush()
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.jobs.j1.title, 't')
  assert.equal(onDisk.events.length, 1)
  const reloaded = new Store(file).load()
  assert.equal(reloaded.getJob('j1').id, 'j1')
  rmSync(d, { recursive: true, force: true })
})

check('corrupt state is backed up, never trusted', async () => {
  const d = dir()
  const file = path.join(d, 'state.json')
  writeFileSync(file, '{ not json', 'utf8')
  const store = new Store(file).load()
  assert.equal(store.listJobs().length, 0)
  assert.ok(store.state.lastLoadError)
  // The corrupt bytes were renamed aside, and a fresh empty state replaced them.
  const siblings = readdirSync(d).filter((f) => f.startsWith('state.json.corrupt-'))
  assert.equal(siblings.length, 1)
  assert.equal(readFileSync(path.join(d, siblings[0]), 'utf8'), '{ not json')
  store.flush()
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).jobs, {})
  rmSync(d, { recursive: true, force: true })
})

check('partial state (missing fields) is repaired', () => {
  const d = dir()
  const file = path.join(d, 'state.json')
  writeFileSync(file, JSON.stringify({ jobs: { a: { id: 'a' } } }), 'utf8')
  const store = new Store(file).load()
  assert.deepEqual(store.state.events, [])
  assert.deepEqual(store.state.seen, {})
  assert.ok(store.getJob('a'))
  rmSync(d, { recursive: true, force: true })
})

check('nextPending respects backoff and picks oldest first', () => {
  const d = dir()
  const store = new Store(path.join(d, 'state.json'), { now: () => 1000000 }).load()
  store.upsertJob({ id: 'j1', kind: 'watch', title: 't' })
  const e1 = store.enqueueEvent('j1', { n: 1 })
  const e2 = store.enqueueEvent('j1', { n: 2 })
  assert.equal(store.nextPending().eventId, e1.eventId)
  // e1 waits for retry -> e2 becomes the pick.
  store.mutate((s) => { s.events[0].nextAttemptAt = 2000000 })
  assert.equal(store.nextPending().eventId, e2.eventId)
  assert.equal(store.nextPending('other-job'), null)
  rmSync(d, { recursive: true, force: true })
})

check('eventCounts scopes by job and counts all statuses', () => {
  const d = dir()
  const store = new Store(path.join(d, 'state.json')).load()
  store.upsertJob({ id: 'j1', kind: 'watch', title: 't' })
  store.upsertJob({ id: 'j2', kind: 'watch', title: 't' })
  store.enqueueEvent('j1', {})
  store.enqueueEvent('j1', {})
  store.enqueueEvent('j2', {})
  const all = store.eventCounts()
  assert.equal(all.pending, 3)
  assert.equal(store.eventCounts('j1').pending, 2)
  store.mutate((s) => { s.events[0].status = 'dead' })
  assert.equal(store.eventCounts('j1').dead, 1)
  rmSync(d, { recursive: true, force: true })
})

check('prune drops old consumed events, stale seen entries, dead rows', () => {
  const d = dir()
  const now = 1700000000000
  const store = new Store(path.join(d, 'state.json'), {
    now: () => now, seenRetentionDays: 90, eventRetentionDays: 30,
  }).load()
  store.upsertJob({ id: 'j1', kind: 'watch', title: 't' })
  store.mutate((s) => {
    s.seen.j1 = { old: now - 91 * 86400000, fresh: now - 1000 }
    s.events.push(
      { eventId: 'gone', jobId: 'j1', status: 'consumed', consumedAt: now - 31 * 86400000 },
      { eventId: 'kept', jobId: 'j1', status: 'consumed', consumedAt: now - 1000 },
      { eventId: 'dead', jobId: 'j1', status: 'dead' },
      { eventId: 'pend', jobId: 'j1', status: 'pending' },
    )
  })
  const { prunedSeen, prunedEvents } = store.prune()
  assert.equal(prunedSeen, 1)
  assert.ok(prunedEvents >= 2) // old consumed + dead
  assert.ok(!store.state.seen.j1.old)
  assert.ok(store.state.seen.j1.fresh)
  assert.deepEqual(store.state.events.map((e) => e.eventId).sort(), ['kept', 'pend'])
  rmSync(d, { recursive: true, force: true })
})

check('removeJob keeps in-flight events of other rows and clears job data', () => {
  const d = dir()
  const store = new Store(path.join(d, 'state.json')).load()
  store.upsertJob({ id: 'j1', kind: 'watch', title: 't' })
  store.enqueueEvent('j1', {})
  store.recordExecution({ jobId: 'j1', startedAt: 1, finishedAt: 2, status: 'success', newCandidates: 0, error: null })
  const removed = store.removeJob('j1')
  assert.equal(removed.id, 'j1')
  assert.equal(store.getJob('j1'), null)
  assert.equal(store.state.events.length, 0)
  assert.equal(store.state.executions.length, 0)
  assert.equal(store.removeJob('nope'), null)
  rmSync(d, { recursive: true, force: true })
})

check('execution ring buffer caps per job', () => {
  const d = dir()
  const store = new Store(path.join(d, 'state.json')).load()
  store.upsertJob({ id: 'j1', kind: 'watch', title: 't' })
  for (let i = 0; i < 150; i++) store.recordExecution({ jobId: 'j1', startedAt: i, finishedAt: i, status: 'success', newCandidates: 0, error: null })
  store.prune()
  assert.ok(store.state.executions.length <= 100, `expected <=100, got ${store.state.executions.length}`)
  rmSync(d, { recursive: true, force: true })
})

console.log(failed === 0 ? '\nstore: all passed' : `\nstore: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
