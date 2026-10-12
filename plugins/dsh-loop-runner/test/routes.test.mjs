/**
 * Routes tests: captured webServer.register calls invoked with fake
 * req/res — loopback fence, method guards, shapes, and actions.
 * Run with: node test/routes.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../lib/core/store.js'
import { Engine } from '../lib/core/engine.js'
import { Consumer } from '../lib/core/consumer.js'
import { registerRoutes } from '../lib/host/routes.js'

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
const dir = () => mkdtempSync(path.join(tmpdir(), 'loop-routes-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quietLogger = { info() {}, warn() {}, error() {} }

function setup() {
  const d = dir()
  const store = new Store(path.join(d, 'state.json'), { debounceMs: 5 }).load()
  const engine = new Engine({
    store,
    runAdapter: async () => ({ records: [] }),
    onEvent: () => {},
    onAgentFire: () => {},
    logger: quietLogger,
  })
  const consumer = new Consumer({ store, escalate: async () => ({ ok: true }), logger: quietLogger })
  /** @type {Map<string, {kind:string, path:string, handler:Function}>} */
  const routes = new Map()
  const webServer = { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } }
  const dispose = registerRoutes(webServer, { store, engine, consumer, uiPollMs: 2500 })
  return { d, store, engine, consumer, routes, dispose }
}

/** Fake req/res pair; collects the JSON response. */
function fakeReq(pathName, { method = 'GET', remote = '127.0.0.1', body = null } = {}) {
  const req = {
    method,
    url: `http://dsh.internal${pathName}`,
    socket: { remoteAddress: remote },
    on(event, listener) {
      if (event === 'data' && body !== null) listener(Buffer.from(JSON.stringify(body)))
      if (event === 'end' && body !== null) listener()
    },
    destroy() {},
  }
  const res = {
    code: 0, body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(text) { this.body = text ? JSON.parse(text) : null },
  }
  return { req, res }
}

async function hit(setup_, pathName, options) {
  const routePath = pathName.split('?')[0]
  const route = setup_.routes.get(routePath)
  if (!route) throw new Error(`route not registered: ${routePath}`)
  const { req, res } = fakeReq(pathName, options)
  await route.handler(req, res)
  return res
}

console.log('dsh-loop-runner routes tests\n')

await check('all eight routes registered under /api/dsh-loop-runner', () => {
  const { routes, d } = setup()
  const paths = [...routes.keys()].sort()
  assert.equal(paths.length, 8)
  for (const p of paths) assert.match(p, /^\/api\/dsh-loop-runner\//)
  assert.ok(paths.includes('/api/dsh-loop-runner/health'))
  assert.ok(paths.includes('/api/dsh-loop-runner/job'))
  rmSync(d, { recursive: true, force: true })
})

await check('non-loopback requests get 403 without touching the store', async () => {
  const s = setup()
  const res = await hit(s, '/api/dsh-loop-runner/health', { remote: '192.168.1.5' })
  assert.equal(res.code, 403)
  assert.match(res.body.error, /loopback-only/)
  rmSync(s.d, { recursive: true, force: true })
})

await check('health reports engine, queue and the configured uiPollMs', async () => {
  const s = setup()
  const res = await hit(s, '/api/dsh-loop-runner/health')
  assert.equal(res.code, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.uiPollMs, 2500)
  assert.deepEqual(res.body.jobs, { watch: 0, agent: 0 })
  rmSync(s.d, { recursive: true, force: true })
})

await check('overview returns job cards with queue counts', async () => {
  const s = setup()
  s.store.upsertJob({ id: 'w1', kind: 'watch', title: '巡检', schedule: { kind: 'interval', intervalSeconds: 60 }, paused: false, lastStatus: 'idle', createdAt: 1 })
  s.store.enqueueEvent('w1', {})
  const res = await hit(s, '/api/dsh-loop-runner/overview')
  assert.equal(res.code, 200)
  assert.equal(res.body.jobs.length, 1)
  assert.equal(res.body.jobs[0].queue.pending, 1)
  assert.equal(res.body.jobs[0].lastStatus, 'idle')
  rmSync(s.d, { recursive: true, force: true })
})

await check('job detail bundles executions/events/escalations; 404 for unknown', async () => {
  const s = setup()
  s.store.upsertJob({ id: 'w1', kind: 'watch', title: 'x', schedule: { kind: 'interval', intervalSeconds: 60 } })
  s.store.enqueueEvent('w1', {})
  s.store.recordExecution({ jobId: 'w1', startedAt: 1, finishedAt: 2, status: 'success', newCandidates: 0, error: null })
  const res = await hit(s, '/api/dsh-loop-runner/job?id=w1&limit=5')
  assert.equal(res.code, 200)
  assert.equal(res.body.events.length, 1)
  assert.equal(res.body.executions.length, 1)
  const missing = await hit(s, '/api/dsh-loop-runner/job?id=nope')
  assert.equal(missing.code, 404)
  rmSync(s.d, { recursive: true, force: true })
})

await check('pause/resume/run/requeue actions mutate through the store', async () => {
  const s = setup()
  s.store.upsertJob({ id: 'w1', kind: 'watch', title: 'x', schedule: { kind: 'interval', intervalSeconds: 60 }, adapter: { file: 'x' } })
  let res = await hit(s, '/api/dsh-loop-runner/job/pause?id=w1', { method: 'POST', body: { reason: '维护' } })
  assert.equal(res.code, 200)
  assert.equal(s.store.getJob('w1').paused, true)

  res = await hit(s, '/api/dsh-loop-runner/job/resume?id=w1', { method: 'POST', body: {} })
  assert.equal(s.store.getJob('w1').paused, false)

  res = await hit(s, '/api/dsh-loop-runner/job/run?id=w1', { method: 'POST', body: {} })
  assert.equal(res.code, 200)
  assert.equal(res.body.fired, true)

  s.store.mutate((st) => { st.events[0] = { eventId: 'dead1', jobId: 'w1', status: 'dead', attempts: 5, createdAt: 1 } })
  res = await hit(s, '/api/dsh-loop-runner/job/requeue?id=w1', { method: 'POST', body: {} })
  assert.equal(res.body.count, 1)
  rmSync(s.d, { recursive: true, force: true })
})

await check('method guards: GET-only routes reject POST and vice versa', async () => {
  const s = setup()
  const post = await hit(s, '/api/dsh-loop-runner/health', { method: 'POST' })
  assert.equal(post.code, 405)
  const get = await hit(s, '/api/dsh-loop-runner/job/pause?id=w1', { method: 'GET' })
  assert.equal(get.code, 405)
  rmSync(s.d, { recursive: true, force: true })
})

await check('escalations endpoint lists the ledger newest-first', async () => {
  const s = setup()
  s.store.appendEscalation({ jobId: 'a', trigger: 'schedule', sessionId: 's1', startedAt: 1 })
  s.store.appendEscalation({ jobId: 'b', trigger: 'event', sessionId: 's2', startedAt: 2 })
  const res = await hit(s, '/api/dsh-loop-runner/escalations?limit=10')
  assert.equal(res.code, 200)
  assert.equal(res.body.escalations.length, 2)
  assert.equal(res.body.escalations[0].jobId, 'b')
  rmSync(s.d, { recursive: true, force: true })
})

await check('dispose unregisters every route', () => {
  const s = setup()
  assert.ok(s.routes.size > 0)
  s.dispose()
  assert.equal(s.routes.size, 0)
  rmSync(s.d, { recursive: true, force: true })
})

console.log(failed === 0 ? '\nroutes: all passed' : `\nroutes: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
