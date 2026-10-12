/**
 * Panel routes: the same-origin API the web client polls.
 *
 * Shape follows the two verified in-repo/upstream precedents: routes are
 * `{kind: 'exact'|'prefix', path, handler(req, res)}` objects handed to
 * `ctx.webServer.register()` (which returns a disposer), every handler is
 * fenced to loopback requests only, and JSON bodies are size-capped. Job ids
 * travel as query params so every route stays an exact path.
 */

const BASE = '/api/dsh-loop-runner'
/** Request-body ceiling — configs and prompts are small; anything bigger is a bug. */
const MAX_JSON_BODY_BYTES = 256 * 1024

/** @returns {boolean} true when the request originates from this machine. */
function isLoopback(req) {
  const remote = req?.socket?.remoteAddress ?? ''
  if (!remote) return false
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function writeJson(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** Wire every panel route onto the webServer. Returns a single dispose fn. */
export function registerRoutes(webServer, deps) {
  const { store, engine, consumer } = deps
  const disposers = []

  /** Wrap a handler with the loopback fence and error fence. */
  const guarded = (fn) => async (req, res) => {
    if (!isLoopback(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return
    }
    try {
      await fn(req, res)
    } catch (error) {
      writeJson(res, 500, { error: String(error?.message || error) })
    }
  }

  const jobCard = (job) => {
    const counts = store.eventCounts(job.id)
    const lastExec = store.listExecutions(job.id, 1)[0] ?? null
    return {
      id: job.id,
      kind: job.kind,
      title: job.title,
      description: job.description,
      paused: !!job.paused,
      done: !!job.done,
      schedule: job.schedule,
      nextRunAt: job.nextRunAt,
      lastStatus: job.lastStatus ?? 'registered',
      lastError: job.lastError ?? null,
      queue: counts,
      lastExecution: lastExec && {
        startedAt: lastExec.startedAt,
        status: lastExec.status,
        newCandidates: lastExec.newCandidates,
        error: lastExec.error,
      },
      escalation: job.escalation,
      updatedAt: job.updatedAt ?? null,
    }
  }

  const findJob = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const id = url.searchParams.get('id') ?? ''
    const job = store.getJob(id)
    if (!job) {
      writeJson(res, 404, { error: `job not found: ${id}` })
      return null
    }
    return job
  }

  const post = (path, fn) => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: `${BASE}${path}`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'POST only' })
          return
        }
        const body = await readJsonBody(req)
        await fn(req, res, body)
      }),
    }))
  }

  const get = (path, fn) => {
    disposers.push(webServer.register({
      kind: 'exact',
      path: `${BASE}${path}`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'GET only' })
          return
        }
        await fn(req, res)
      }),
    }))
  }

  get('/health', (_req, res) => {
    const counts = store.eventCounts()
    writeJson(res, 200, {
      ok: true,
      engineStartedAt: engine.startedAt || null,
      jobs: { watch: store.listJobs().filter((j) => j.kind === 'watch').length, agent: store.listJobs().filter((j) => j.kind === 'agent').length },
      queue: counts,
      inFlight: consumer.inFlight.size,
      uiPollMs: deps.uiPollMs ?? 5000,
    })
  })

  get('/overview', (_req, res) => {
    const jobs = store.listJobs()
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .map(jobCard)
    writeJson(res, 200, { jobs })
  })

  get('/job', (req, res) => {
    const job = findJob(req, res)
    if (!job) return
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 20) || 20))
    writeJson(res, 200, {
      job: jobCard(job),
      executions: store.listExecutions(job.id, limit),
      events: store.listEvents(job.id, url.searchParams.get('status'), limit),
      escalations: store.listEscalations(limit, job.id),
    })
  })

  get('/escalations', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50))
    writeJson(res, 200, { escalations: store.listEscalations(limit) })
  })

  post('/job/pause', (req, res, body) => {
    const job = findJob(req, res)
    if (!job) return
    store.mutate((s) => {
      const live = s.jobs[job.id]
      if (live) { live.paused = true; live.pauseReason = String(body?.reason ?? ''); live.updatedAt = Date.now() }
    })
    writeJson(res, 200, { ok: true })
  })

  post('/job/resume', (req, res, body) => {
    const job = findJob(req, res)
    if (!job) return
    store.mutate((s) => {
      const live = s.jobs[job.id]
      if (live) {
        live.paused = false
        live.pauseReason = ''
        if (body?.skipBacklog === true) live.initialized = false
        live.updatedAt = Date.now()
      }
    })
    consumer.pump()
    writeJson(res, 200, { ok: true })
  })

  post('/job/run', async (req, res) => {
    const job = findJob(req, res)
    if (!job) return
    const result = await engine.runNow(job.id)
    consumer.pump()
    writeJson(res, 200, { ok: true, ...result })
  })

  post('/job/requeue', (req, res) => {
    const job = findJob(req, res)
    if (!job) return
    const count = consumer.requeue(job.id)
    writeJson(res, 200, { ok: true, count })
  })

  return () => {
    for (const disposer of disposers) {
      try { disposer?.() } catch { /* best effort */ }
    }
  }
}
