/**
 * The scheduler engine: one interval ticker that fires due jobs.
 *
 * Two job kinds share the loop:
 *  - `watch` — run the job's adapter script as a node child process, validate
 *    its JSON-Lines output, dedupe against the seen set, aggregate within the
 *    window, enqueue events. Costs no tokens.
 *  - `agent` — hand the fire straight to the escalation callback (tokens).
 *
 * At-most-once semantics (ported from loopctl/timer-agent): the tick claims a
 * fire by rolling `nextRunAt` forward INSIDE the store mutate, guarded on the
 * exact fired instant; a late or duplicate tick therefore cannot double-fire,
 * and a run still in progress skips its next slot instead of piling up.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { nextAfter } from './schedule.js'

/** Hard cap on adapter stdout — a runaway source must not balloon memory. */
const MAX_ADAPTER_OUTPUT = 2 * 1024 * 1024

/**
 * Spawn `node <adapterFile>` and collect stdout/stderr with a hard timeout.
 * Contract: exit 0 with zero or more JSON-Lines candidate records on stdout
 * (empty output is a successful quiet poll); non-zero or malformed output is
 * a failed execution. `SCENARIO_NOW` pins the clock for deterministic tests.
 *
 * @param {{file:string, cwd?:string|null, timeoutSeconds?:number, env?:Record<string,string>}} adapter
 * @returns {Promise<{records: Array<object>}>}
 */
export function runAdapterProcess(adapter) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [adapter.file], {
      cwd: adapter.cwd || path.dirname(adapter.file),
      env: { ...process.env, ...(adapter.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutMs = (adapter.timeoutSeconds ?? 60) * 1000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`adapter timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_ADAPTER_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `adapter exited with code ${code}`
        reject(new Error(`adapter failed (${code}): ${detail.slice(0, 2000)}`))
        return
      }
      try {
        resolve({ records: parseCandidateLines(stdout) })
      } catch (error) {
        reject(error)
      }
    })
  })
}

/** Parse + validate adapter stdout: one JSON object per non-empty line. */
export function parseCandidateLines(stdout) {
  const records = []
  const lines = stdout.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`adapter stdout line ${i + 1} is not JSON: ${error.message}`)
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`adapter stdout line ${i + 1} must be a JSON object`)
    }
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error(`adapter stdout line ${i + 1} requires a stable non-empty string id`)
    }
    if (!('payload' in record)) {
      throw new Error(`adapter stdout line ${i + 1} requires a payload`)
    }
    if ('group_key' in record && typeof record.group_key !== 'string') {
      throw new Error(`adapter stdout line ${i + 1}.group_key must be a string`)
    }
    if ('occurred_at' in record && typeof record.occurred_at !== 'string') {
      throw new Error(`adapter stdout line ${i + 1}.occurred_at must be an ISO-8601 string`)
    }
    records.push(record)
  }
  return records
}

/**
 * Port of loopctl.py `group_candidates`: bucket by group_key (or id), sort by
 * occurred_at, split a bucket whenever consecutive records are farther apart
 * than the aggregate window.
 */
export function groupCandidates(candidates, windowSeconds) {
  const groups = new Map()
  for (const candidate of candidates) {
    const key = candidate.group_key || candidate.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(candidate)
  }
  const result = []
  for (const items of groups.values()) {
    items.sort((a, b) => String(a.occurred_at ?? '').localeCompare(String(b.occurred_at ?? '')))
    let current = []
    let lastTime = null
    for (const candidate of items) {
      const time = parseTime(candidate.occurred_at)
      if (current.length && time !== null && lastTime !== null && (time - lastTime) / 1000 > windowSeconds) {
        result.push(current)
        current = []
      }
      current.push(candidate)
      if (time !== null) lastTime = time
    }
    if (current.length) result.push(current)
  }
  return result
}

function parseTime(value) {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/** Event payload shape carried to the escalation prompt (loopctl build_payload port). */
export function buildEventPayload(job, candidates) {
  return {
    event_type: job.eventType || job.id,
    watcher: job.title || job.id,
    candidates,
    instructions: job.escalation?.instructions || 'Analyze this event and follow the configured workflow.',
  }
}

/**
 * The engine. Owns the ticker and per-job serialization; emits work through
 * the two callbacks so tests and the host wiring stay deterministic.
 */
export class Engine {
  /**
   * @param {{
   *   store: import('./store.js').Store,
   *   tickerSeconds?: number,
   *   runAdapter?: typeof runAdapterProcess,
   *   onEvent: (job: object, event: object) => void,
   *   onAgentFire: (job: object, trigger: 'schedule' | 'manual') => void,
   *   logger?: { info?: Function, warn?: Function, error?: Function },
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store
    this.tickerSeconds = deps.tickerSeconds ?? 30
    this.runAdapter = deps.runAdapter ?? runAdapterProcess
    this.onEvent = deps.onEvent
    this.onAgentFire = deps.onAgentFire
    this.logger = deps.logger ?? console
    this.now = deps.now ?? Date.now
    /** @type {Map<string, Promise<void>>} job id -> in-flight execution */
    this.running = new Map()
    /** @type {NodeJS.Timeout | null} */
    this.timer = null
    this.startedAt = 0
    /** Pump callback hook, set by the host wiring (consumer.pump on enqueue). */
    this.onEventEnqueued = null
  }

  start() {
    if (this.timer) return
    this.startedAt = this.now()
    this.timer = setInterval(() => { this.tick().catch(() => {}) }, this.tickerSeconds * 1000)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    // First tick immediately on boot (catch-up for missed interval slots is
    // deliberately NOT done: loop-runner semantics — missed means skipped).
    this.tick().catch(() => {})
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One scheduling pass: claim and fire everything due. */
  async tick() {
    const now = this.now()
    for (const job of this.store.listJobs()) {
      if (job.paused) continue
      if (job.nextRunAt == null || job.nextRunAt > now) continue
      if (this.running.has(job.id)) continue
      const firedAt = job.nextRunAt
      // Claim the fire: roll nextRunAt first, guarded on the exact instant.
      const claimed = this.store.mutate((s) => {
        const live = s.jobs[job.id]
        if (!live || live.paused || live.nextRunAt !== firedAt) return null
        live.nextRunAt = nextAfter(job.schedule, Math.max(now, firedAt))
        if (job.schedule.kind === 'once') live.done = true
        return live
      })
      if (!claimed) continue
      // Serialize per job; a slow run simply skips forward slots (already rolled).
      const run = this.executeJob(claimed, firedAt).finally(() => { this.running.delete(job.id) })
      this.running.set(job.id, run)
      // Fire-and-forget: the ticker never awaits a running job.
      run.catch((error) => { this.logger.error?.(`[loop-runner] job ${job.id} crashed: ${error?.message || error}`) })
    }
  }

  /**
   * Run one fired job: watch -> adapter pipeline; agent -> escalation callback.
   * Records the execution row and job status either way.
   */
  async executeJob(job, firedAt) {
    if (job.kind === 'agent') {
      const startedAt = this.now()
      try {
        this.onAgentFire(job, 'schedule')
        this.store.recordExecution({ jobId: job.id, startedAt, finishedAt: this.now(), status: 'success', newCandidates: 0, error: null })
        this.setJobStatus(job.id, 'idle', null)
      } catch (error) {
        this.store.recordExecution({ jobId: job.id, startedAt, finishedAt: this.now(), status: 'failed', newCandidates: 0, error: String(error?.message || error) })
        this.setJobStatus(job.id, 'failed', String(error?.message || error))
      }
      return
    }

    const startedAt = this.now()
    try {
      const { records } = await this.runAdapter(job.adapter)
      const fresh = this.ingestCandidates(job, records)
      this.store.recordExecution({ jobId: job.id, startedAt, finishedAt: this.now(), status: 'success', newCandidates: fresh, error: null })
      this.setJobStatus(job.id, 'idle', null)
    } catch (error) {
      const message = String(error?.message || error)
      this.store.recordExecution({ jobId: job.id, startedAt, finishedAt: this.now(), status: 'failed', newCandidates: 0, error: message })
      this.setJobStatus(job.id, 'failed', message)
    }
  }

  /**
   * Dedupe + aggregate + enqueue. Baseline rule: the FIRST poll after job
   * creation only records candidates (baseline:'ignore', the default) so old
   * records cannot flood the agent; 'enqueue' processes them immediately.
   * @returns {number} how many candidates were newly enqueued
   */
  ingestCandidates(job, records) {
    let newCandidates = []
    this.store.mutate((s) => {
      const seen = (s.seen[job.id] ??= {})
      const initialized = job.initialized === true
      for (const record of records) {
        if (seen[record.id] !== undefined) continue
        seen[record.id] = this.now()
        if (initialized || job.baseline === 'enqueue') newCandidates.push(record)
      }
      const live = s.jobs[job.id]
      if (live) live.initialized = true
    })
    if (newCandidates.length === 0) return 0
    const window = job.filter?.aggregateWindowSeconds ?? 0
    let enqueued = 0
    for (const group of groupCandidates(newCandidates, window)) {
      const event = this.store.enqueueEvent(job.id, buildEventPayload(job, group))
      enqueued++
      this.onEvent(job, event)
    }
    return enqueued
  }

  setJobStatus(jobId, status, error) {
    this.store.mutate((s) => {
      const live = s.jobs[jobId]
      if (!live) return
      live.lastStatus = status
      live.lastError = error
      live.updatedAt = this.now()
    })
  }

  /**
   * Manual run-now (panel button / job_run_now tool). Watch jobs re-anchor
   * their interval from now (timer-agent semantics); cron keeps its natural
   * schedule; agent jobs escalate immediately without touching the schedule.
   */
  async runNow(jobId) {
    const job = this.store.getJob(jobId)
    if (!job) throw new Error(`job not found: ${jobId}`)
    if (job.kind === 'agent') {
      this.onAgentFire(job, 'manual')
      return { fired: true, kind: 'agent' }
    }
    if (this.running.has(jobId)) return { fired: false, reason: 'already running' }
    this.store.mutate((s) => {
      const live = s.jobs[jobId]
      if (live && live.schedule.kind === 'interval') live.nextRunAt = nextAfter(live.schedule, this.now())
    })
    const run = this.executeJob(job, this.now()).finally(() => { this.running.delete(jobId) })
    this.running.set(jobId, run)
    run.catch(() => {})
    return { fired: true, kind: 'watch' }
  }
}
