/**
 * Tools tests: the REAL defineTool compiles every schema; job_create runs
 * end-to-end against a temp scenariosRoot (adapter file written, baseline
 * poll semantics), and the whole management surface is exercised through a
 * captured fake ctx.tools.
 * Run with: node test/tools.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../lib/core/store.js'
import { Engine } from '../lib/core/engine.js'
import { Consumer } from '../lib/core/consumer.js'
import { Escalator } from '../lib/host/escalation.js'
import { registerTools, SYSTEM_PROMPT_GUIDANCE } from '../lib/host/tools.js'

let failed = 0
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${label}`))
    .catch((error) => {
      failed++
      console.log(`  FAIL ${label}\n       ${String(error.message).split('\n').slice(0, 5).join('\n       ')}`)
    })
}
const dir = () => mkdtempSync(path.join(tmpdir(), 'loop-tools-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quietLogger = { info() {}, warn() {}, error() {} }

function setup() {
  const d = dir()
  const scenariosRoot = path.join(d, 'jobs')
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5 }).load()
  const escalator = new Escalator({ ctx: {}, store, defaults: { mode: 'fresh', provider: '', model: '', timeoutMinutes: 30 }, logger: quietLogger })
  const consumer = new Consumer({ store, escalate: async () => ({ ok: true }), logger: quietLogger })
  const engine = new Engine({
    store,
    runAdapter: async () => ({ records: [] }),
    onEvent: () => {},
    onAgentFire: () => {},
    logger: quietLogger,
  })
  /** @type {Map<string, object>} */
  const tools = new Map()
  const ctx = { tools: { register: (tool) => { tools.set(tool.name, tool) } } }
  registerTools(ctx, { store, engine, consumer, escalator, scenariosRoot, logger: quietLogger })
  const call = async (name, args = {}) => tools.get(name).execute(args)
  return { d, scenariosRoot, store, engine, consumer, escalator, tools, call }
}

console.log('dsh-loop-runner tools tests\n')

await check('all ten tools registered through the real defineTool', () => {
  const { tools } = setup()
  assert.deepEqual([...tools.keys()].sort(), [
    'consume_once', 'events_requeue', 'job_create', 'job_list', 'job_pause',
    'job_remove', 'job_resume', 'job_run_now', 'job_status', 'job_update',
  ])
})

await check('job_create (watch): adapter written, schedule normalized, baseline note', async () => {
  const { d, call, store, scenariosRoot } = setup()
  const adapter = `console.log(JSON.stringify({ id: 'a1', payload: { v: 1 } }))\n`
  const result = await call('job_create', {
    kind: 'watch', title: '面试邮件', id: 'italent-mail',
    schedule_interval_seconds: 600, adapter_code: adapter,
    instructions: '处理新邮件', aggregate_window_seconds: 30,
  })
  assert.match(result.summary, /created italent-mail/)
  assert.match(result.summary, /baseline=ignore/)
  const file = path.join(scenariosRoot, 'italent-mail', 'adapter.js')
  assert.ok(existsSync(file))
  assert.equal(readFileSync(file, 'utf8'), adapter)
  const job = store.getJob('italent-mail')
  assert.equal(job.kind, 'watch')
  assert.equal(job.schedule.intervalSeconds, 600)
  assert.equal(job.filter.aggregateWindowSeconds, 30)
  assert.equal(job.escalation.instructions, '处理新邮件')
  assert.ok(job.nextRunAt > 0)
  rmSync(d, { recursive: true, force: true })
})

await check('job_create (agent): instructions required; cron accepted', async () => {
  const { d, call } = setup()
  await assert.rejects(() => call('job_create', { kind: 'agent', title: '日报', schedule_cron: '0 9 * * 1-5' }), /instructions/)
  const result = await call('job_create', {
    kind: 'agent', title: '日报', id: 'daily-report',
    schedule_cron: '0 9 * * 1-5', instructions: '生成今日日报',
  })
  assert.match(result.summary, /agent/)
})

await check('job_create validation: bad id, bad schedule, missing adapter', async () => {
  const { d, call } = setup()
  await assert.rejects(() => call('job_create', { kind: 'watch', title: 'x', id: 'Bad_Id!', schedule_interval_seconds: 60 }), /id/)
  await assert.rejects(() => call('job_create', { kind: 'watch', title: 'x', schedule_interval_seconds: 5 }), />= 10/)
  await assert.rejects(() => call('job_create', { kind: 'watch', title: 'x', schedule_interval_seconds: 60 }), /adapterCode/)
})

await check('job_list / job_status / pause / resume / update / run_now / remove lifecycle', async () => {
  const s = setup()
  await s.call('job_create', { kind: 'watch', title: '巡检', id: 'w1', schedule_interval_seconds: 60, adapter_code: '' || 'console.log("")' })
  const list = await s.call('job_list', {})
  assert.match(list.summary, /w1 \[watch\]/)

  await s.call('job_pause', { id: 'w1', reason: '排查' })
  assert.equal(s.store.getJob('w1').paused, true)
  assert.equal(s.store.getJob('w1').pauseReason, '排查')

  await s.call('job_resume', { id: 'w1', skip_backlog: true })
  assert.equal(s.store.getJob('w1').paused, false)
  assert.equal(s.store.getJob('w1').initialized, false, 'skip_backlog resets the baseline')

  await s.call('job_update', { id: 'w1', schedule_interval_seconds: 120, instructions: '新指令' })
  const job = s.store.getJob('w1')
  assert.equal(job.schedule.intervalSeconds, 120)
  assert.equal(job.escalation.instructions, '新指令')

  await s.call('job_run_now', { id: 'w1' })
  await sleep(30)
  assert.ok(s.store.listExecutions('w1').length >= 1)

  const status = await s.call('job_status', { id: 'w1' })
  assert.match(status.summary, /queue: pending=0/)
  await assert.rejects(() => s.call('job_status', { id: 'nope' }), /not found/)

  await s.call('job_remove', { id: 'w1' })
  assert.equal(s.store.getJob('w1'), null)
  rmSync(s.d, { recursive: true, force: true })
})

await check('consume_once drains one event through a fake agents service; events_requeue revives dead', async () => {
  const s = setup()
  await s.call('job_create', { kind: 'watch', title: '巡检', id: 'w1', schedule_interval_seconds: 60, adapter_code: 'console.log("")' })

  // Swap in a fake agents service BEFORE any event exists, so nothing else consumes it.
  s.escalator.ctx.agents = {
    async create(opts) {
      return {
        agent: {
          session: { id: opts.sessionId, seq: 0, snapshotEvents: () => [] },
          followup() {},
          async whenIdle() {},
        },
        async dispose() {},
      }
    },
  }
  s.store.enqueueEvent('w1', { candidates: [{ id: 'x', payload: 1 }] })
  const consumed = await s.call('consume_once', { id: 'w1' })
  // snapshotEvents returns [] -> "no assistant text" -> failure reported honestly.
  assert.equal(consumed.ok, false)
  assert.match(consumed.summary, /no assistant text/)

  // Force one dead event, then revive it via the tool (pump stays idle: no auto-consume
  // in this wiring because engine.onEvent is a stub).
  s.store.mutate((st) => {
    st.events.push({ eventId: 'dead1', jobId: 'w1', status: 'dead', attempts: 3, nextAttemptAt: 0, createdAt: 1 })
  })
  const requeued = await s.call('events_requeue', { id: 'w1' })
  assert.match(requeued.summary, /requeued [1-9]/)
  rmSync(s.d, { recursive: true, force: true })
})

await check('system prompt guidance is present and mentions both kinds', () => {
  assert.match(SYSTEM_PROMPT_GUIDANCE, /watch jobs/i)
  assert.match(SYSTEM_PROMPT_GUIDANCE, /agent jobs/i)
  assert.match(SYSTEM_PROMPT_GUIDANCE, /ZERO model tokens|zero model tokens/i)
})

console.log(failed === 0 ? '\ntools: all passed' : `\ntools: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
