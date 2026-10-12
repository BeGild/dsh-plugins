/**
 * Load + integration test — run with: node test/load.test.mjs
 *
 * Imports the REAL plugin entry, lets the REAL schemastery Config produce
 * defaults, applies it against a fake-but-faithful ctx (tools + systemPrompt
 * + webServer + effect), then runs the engine one tick with a REAL adapter
 * child process and a REAL escalation against a fake agents service. If any
 * import, export or wiring is wrong, this throws.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { name, inject, Config, apply } from '../lib/index.js'

let failed = 0
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${label}`))
    .catch((error) => {
      failed++
      console.log(`  FAIL ${label}\n       ${String(error.message).split('\n').slice(0, 6).join('\n       ')}`)
    })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('dsh-loop-runner load + integration tests\n')

await check('plugin identity and injects', () => {
  assert.equal(name, 'dsh-loop-runner')
  assert.deepEqual([...inject].sort(), ['agents', 'systemPrompt', 'tools', 'webServer'])
})

await check('Config schema produces complete defaults', () => {
  const config = Config({})
  assert.equal(config.enabled, true)
  assert.equal(config.tickerSeconds, 30)
  assert.equal(config.maxConcurrentEscalations, 2)
  assert.equal(config.escalationMode, 'fresh')
  assert.equal(config.escalationTimeoutMinutes, 30)
  assert.equal(config.consumerMaxAttempts, 5)
  assert.equal(config.seenRetentionDays, 90)
  assert.equal(config.eventRetentionDays, 30)
  assert.equal(config.announceToAgent, true)
  assert.equal(config.uiPollMs, 5000)
  assert.equal(config.dataDir, '')
})

await check('enabled=false short-circuits without touching anything', () => {
  const logs = []
  apply({ logger: { info: (m) => logs.push(m) } }, { enabled: false })
  assert.match(logs[0], /disabled by config/)
})

await check('full wiring: boot, tools, routes, one watch tick, escalation, teardown', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'loop-load-'))
  const adapterFile = path.join(d, 'adapter.js')
  writeFileSync(adapterFile, `console.log(JSON.stringify({ id: 'hello-1', payload: { v: 42 } }))\n`, 'utf8')

  const tools = new Map()
  const routes = new Map()
  const sections = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section: (spec) => sections.push(spec) },
    webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    // Real cordis semantics: the callback runs IMMEDIATELY and its return
    // value becomes the disposer. This catches the class of bug where setup
    // code is accidentally placed in the callback (instant self-teardown).
    effect(fn) { const dispose = fn(); effects.push(dispose) },
    // Fake agents service the escalator reads lazily.
    agents: {
      async create(opts) {
        return {
          agent: {
            session: {
              id: opts.sessionId, seq: 0,
              snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'escalated fine' }] } } }],
            },
            followup() {},
            async whenIdle() {},
          },
          async dispose() {},
        }
      },
    },
  }

  apply(ctx, {
    dataDir: path.join(d, 'state'),
    tickerSeconds: 3600, // no background tick; we drive ticks manually
    escalationMode: 'fresh',
  })

  assert.ok(tools.has('job_create'), 'tools registered')
  assert.equal(tools.size, 10)
  assert.equal(routes.size, 8, 'panel routes registered')
  assert.equal(sections.length, 1, 'system prompt section registered')
  assert.match(sections[0].text, /dsh-loop-runner/)
  assert.ok(existsSync(path.join(d, 'state', 'jobs')), 'scenario dir created')

  // Create a watch job pointing at the real adapter file, then fire it now.
  // The enqueued event auto-pumps through the real escalation (fake agents).
  const created = await tools.get('job_create').execute({
    kind: 'watch', title: '巡检', id: 'smoke',
    schedule_interval_seconds: 600, adapter_file: adapterFile,
    instructions: '处理发现', baseline: 'enqueue',
  })
  assert.match(created.summary, /created smoke/)

  await tools.get('job_run_now').execute({ id: 'smoke' })
  await sleep(250) // child spawn + escalation + settle

  const status = await tools.get('job_status').execute({ id: 'smoke' })
  assert.match(status.summary, /queue pending=0/, 'event auto-escalated, none left pending')

  const state = JSON.parse(readFileSync(path.join(d, 'state', 'state.json'), 'utf8'))
  assert.equal(state.jobs.smoke.lastStatus, 'idle')
  assert.equal(state.events[0].status, 'consumed')
  assert.equal(state.escalations.length, 1)
  assert.equal(state.escalations[0].outcome, 'succeeded')
  assert.match(state.escalations[0].textPreview, /escalated fine/)

  // The queue is drained now: consume_once reports honestly.
  const consumed = await tools.get('consume_once').execute({ id: 'smoke' })
  assert.match(consumed.summary, /no pending event/)

  // Teardown: run the effect disposers (engine stop + flush + pinned cleanup).
  for (const dispose of effects) dispose()
  assert.equal(routes.size, 0, 'routes unregistered')
  const after = JSON.parse(readFileSync(path.join(d, 'state', 'state.json'), 'utf8'))
  assert.equal(after.events[0].status, 'consumed', 'state flushed on dispose')
  rmSync(d, { recursive: true, force: true })
})

await check('missing webServer still boots with a warning (tools-only host)', () => {
  const warnings = []
  apply({
    logger: { info() {}, warn: (m) => warnings.push(m), error() {} },
    tools: { register() {} },
    systemPrompt: { section() {} },
    effect() {},
  }, { dataDir: mkdtempSync(path.join(tmpdir(), 'loop-load2-')) })
  assert.ok(warnings.some((w) => /webServer/.test(w)))
})

console.log(failed === 0 ? '\nload: all passed' : `\nload: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
