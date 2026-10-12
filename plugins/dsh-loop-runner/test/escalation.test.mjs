/**
 * Escalation tests against a fake agents service shaped exactly like the
 * verified ctx.agents surface (create/resume -> {agent, dispose},
 * agent.followup / whenIdle / session.snapshotEvents).
 * Run with: node test/escalation.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../lib/core/store.js'
import { Escalator, buildPrompt, extractAssistantText } from '../lib/host/escalation.js'

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
const dir = () => mkdtempSync(path.join(tmpdir(), 'loop-esc-'))
const quietLogger = { info() {}, warn() {}, error() {} }
// The production timeout guard deliberately unrefs its timer; keep the loop
// alive so that timer still fires while this file is under test.
const keepAlive = setInterval(() => {}, 1 << 30)

/**
 * Fake agents service. `script` describes one run: {text, events?, idleError?}.
 * Records every call for assertions.
 */
function fakeAgents(script = {}) {
  const calls = { created: [], resumed: [], followups: [], disposed: 0, cancelled: [] }
  const agents = {
    calls,
    async create(opts) {
      calls.created.push(opts)
      return makeHandle(script, calls, opts.sessionId)
    },
    async resume(opts) {
      calls.resumed.push(opts)
      return makeHandle(script, calls, opts.resumeSessionId)
    },
  }
  return agents
}

function makeHandle(script, calls, sessionId) {
  const events = []
  const handle = {
    agent: {
      session: {
        id: sessionId,
        seq: 7,
        snapshotEvents: (fromSeq) => events.filter((e) => e.seq >= fromSeq),
      },
      followup(message) {
        calls.followups.push(message)
        events.push({ seq: 8, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: script.text ?? 'ok result' }] } } })
      },
      async whenIdle() {
        if (script.idleError) throw new Error(script.idleError)
        if (script.hang) await new Promise(() => {}) // never resolves
      },
      cancel(reason) { calls.cancelled.push(reason) },
    },
    async dispose() { calls.disposed++ },
  }
  return handle
}

function makeEscalator(ctxAdds = {}, script = {}) {
  const d = dir()
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5 }).load()
  const escalator = new Escalator({
    ctx: { agents: fakeAgents(script), ...ctxAdds },
    store,
    defaults: { mode: 'fresh', provider: '', model: '', timeoutMinutes: 30 },
    logger: quietLogger,
  })
  return { escalator, store, d }
}

const watchJob = (partial = {}) => ({
  id: 'j1', kind: 'watch', title: '面试邮件',
  escalation: { mode: 'fresh', instructions: '处理该事件', timeoutMinutes: 30 },
  ...partial,
})
const anEvent = { eventId: 'evt-1', jobId: 'j1', payload: { candidates: [{ id: 'm1', payload: { subject: 'hi' } }], instructions: '处理该事件' } }

console.log('dsh-loop-runner escalation tests\n')

await check('happy path: session created, prompt follows contract, text extracted, ledger settled', async () => {
  const { escalator, store, d } = makeEscalator({}, { text: '分析完成：2 封新邮件' })
  store.upsertJob(watchJob())
  const result = await escalator.escalate(watchJob(), anEvent, 'event')
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'loop-j1-' + result.sessionId.slice('loop-j1-'.length))
  assert.match(result.sessionId, /^loop-j1-[0-9a-f]{8}$/)
  assert.equal(result.text, '分析完成：2 封新邮件')
  const agents = escalator.ctx.agents.calls
  assert.equal(agents.created.length, 1)
  assert.equal(agents.followups.length, 1)
  assert.match(agents.followups[0].content[0].text, /处理该事件/)
  assert.match(agents.followups[0].content[0].text, /"subject": "hi"/)
  assert.equal(agents.followups[0].source.plugin, 'dsh-loop-runner')
  assert.equal(agents.disposed, 1, 'fresh handles disposed')
  const ledger = store.listEscalations(10)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].outcome, 'succeeded')
  assert.equal(ledger[0].textPreview, '分析完成：2 封新邮件')
  assert.equal(ledger[0].trigger, 'event')
  rmSync(d, { recursive: true, force: true })
})

await check('no agents service -> settled failure with a clear error, no throw', async () => {
  const d = dir()
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5 }).load()
  const escalator = new Escalator({ ctx: {}, store, defaults: { mode: 'fresh', provider: '', model: '', timeoutMinutes: 30 }, logger: quietLogger })
  const result = await escalator.escalate(watchJob(), anEvent, 'event')
  assert.equal(result.ok, false)
  assert.match(result.error, /ctx\.agents/)
  assert.equal(store.listEscalations(10)[0].outcome, 'failed')
  rmSync(d, { recursive: true, force: true })
})

await check('empty assistant text counts as failure', async () => {
  const { escalator, store, d } = makeEscalator({}, { text: '' })
  const result = await escalator.escalate(watchJob(), anEvent, 'event')
  assert.equal(result.ok, false)
  assert.match(result.error, /no assistant text/)
  assert.equal(store.listEscalations(10)[0].outcome, 'failed')
  rmSync(d, { recursive: true, force: true })
})

await check('whenIdle rejection propagates as failure and disposes', async () => {
  const { escalator, d } = makeEscalator({}, { idleError: 'model provider 500' })
  const result = await escalator.escalate(watchJob(), anEvent, 'event')
  assert.equal(result.ok, false)
  assert.match(result.error, /model provider 500/)
  assert.equal(escalator.ctx.agents.calls.disposed, 1)
  rmSync(d, { recursive: true, force: true })
})

await check('timeout cancels a hanging agent and settles failed', async () => {
  const d = dir()
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5 }).load()
  const agents = fakeAgents({ hang: true })
  const escalator = new Escalator({
    ctx: { agents },
    store,
    defaults: { mode: 'fresh', provider: '', model: '', timeoutMinutes: 30 },
    logger: quietLogger,
  })
  const job = watchJob({ escalation: { mode: 'fresh', instructions: 'x', timeoutMinutes: 0.001 } }) // 60ms
  const result = await escalator.escalate(job, anEvent, 'event')
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out/)
  assert.equal(agents.calls.cancelled.length, 1, 'agent.cancel invoked')
  assert.equal(store.listEscalations(10)[0].outcome, 'failed')
  rmSync(d, { recursive: true, force: true })
})

await check('pinned mode: create once, reuse cached handle; cold start resumes', async () => {
  const { escalator, store, d } = makeEscalator({}, { text: 'second turn' })
  const job = watchJob({ escalation: { mode: 'pinned', instructions: 'x', timeoutMinutes: 30 } })
  store.upsertJob(job)
  await escalator.escalate(job, anEvent, 'event')
  const pinnedId = store.getJob('j1').pinnedSessionId
  assert.ok(pinnedId, 'pinned session recorded')
  assert.equal(escalator.ctx.agents.calls.created.length, 1)

  // Second fire in the same process: cached handle — no create, no resume,
  // and the pinned handle is NOT disposed between runs.
  await escalator.escalate(job, { ...anEvent, eventId: 'evt-2' }, 'event')
  assert.equal(escalator.ctx.agents.calls.created.length, 1)
  assert.equal(escalator.ctx.agents.calls.resumed.length, 0)
  assert.equal(escalator.ctx.agents.calls.disposed, 0)

  escalator.disposeAll()
  assert.equal(escalator.ctx.agents.calls.disposed, 1)

  // Cold start (fresh process/cache, persisted pinnedSessionId) -> resume.
  const escalator2 = new Escalator({
    ctx: { agents: fakeAgents({ text: 'third turn' }) },
    store,
    defaults: { mode: 'fresh', provider: '', model: '', timeoutMinutes: 30 },
    logger: quietLogger,
  })
  const cold = await escalator2.escalate(store.getJob('j1'), { ...anEvent, eventId: 'evt-3' }, 'event')
  assert.equal(cold.ok, true)
  assert.equal(escalator2.ctx.agents.calls.resumed.length, 1)
  assert.equal(escalator2.ctx.agents.calls.created.length, 0)
  rmSync(d, { recursive: true, force: true })
})

await check('pinned resume failure falls back to a fresh create', async () => {
  const d = dir()
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5 }).load()
  const calls = { created: [], resumed: [], followups: [], disposed: 0, cancelled: [] }
  const good = fakeAgents({ text: 'recovered' })
  const agents = {
    async create(opts) { calls.created.push(opts); return good.create(opts) },
    async resume() { calls.resumed.push(1); throw new Error('session gone') },
  }
  const escalator = new Escalator({ ctx: { agents }, store, defaults: { mode: 'fresh', provider: '', model: '', timeoutMinutes: 30 }, logger: quietLogger })
  const job = watchJob({ id: 'p2', escalation: { mode: 'pinned', instructions: 'x', timeoutMinutes: 30 }, pinnedSessionId: 'old-session' })
  const result = await escalator.escalate(job, anEvent, 'event')
  assert.equal(result.ok, true)
  assert.equal(calls.resumed.length, 1)
  assert.equal(calls.created.length, 1, 'fell back to create')
  rmSync(d, { recursive: true, force: true })
})

await check('provider/model passthrough: agentOptions only when configured', async () => {
  const { escalator, d } = makeEscalator({}, { text: 'ok' })
  await escalator.escalate(watchJob({ escalation: { mode: 'fresh', instructions: 'x', provider: 'ssaihub', model: 'grok-4.7', timeoutMinutes: 30 } }), anEvent, 'event')
  assert.deepEqual(escalator.ctx.agents.calls.created[0].agentOptions, { provider: 'ssaihub', model: 'grok-4.7' })

  const { escalator: plain, d: d2 } = makeEscalator({}, { text: 'ok' })
  await plain.escalate(watchJob(), anEvent, 'event')
  assert.equal(plain.ctx.agents.calls.created[0].agentOptions, undefined)
  rmSync(d, { recursive: true, force: true })
  rmSync(d2, { recursive: true, force: true })
})

await check('scheduled agent fire: prompt is the instructions verbatim', async () => {
  const { escalator, d } = makeEscalator({}, { text: '报告完成' })
  const job = { id: 'a1', kind: 'agent', title: '日报', escalation: { mode: 'fresh', instructions: '生成今日日报', timeoutMinutes: 30 } }
  const result = await escalator.escalate(job, null, 'schedule')
  assert.equal(result.ok, true)
  assert.equal(escalator.ctx.agents.calls.followups[0].content[0].text, '生成今日日报')
  rmSync(d, { recursive: true, force: true })
})

await check('buildPrompt bounds oversized payloads', () => {
  const huge = { candidates: [{ id: 'x', payload: { blob: 'y'.repeat(40000) } }] }
  const prompt = buildPrompt(watchJob(), { payload: huge })
  assert.ok(prompt.length < 20000)
  assert.match(prompt, /truncated/)
})

await check('extractAssistantText skips events before startSeq', () => {
  const events = [
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
    { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'new' }, { type: 'tool_use', text: 'ignored' }] } } },
  ]
  assert.equal(extractAssistantText({ snapshotEvents: (from) => events.filter((e) => e.seq >= from) }, 7), 'new')
})

console.log(failed === 0 ? '\nescalation: all passed' : `\nescalation: ${failed} FAILED`)
clearInterval(keepAlive)
process.exit(failed === 0 ? 0 : 1)
