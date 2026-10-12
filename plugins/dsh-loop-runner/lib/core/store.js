/**
 * JSON-backed durable state for dsh-loop-runner.
 *
 * One file holds everything the engine owns: jobs, the event queue, the
 * per-job dedupe sets ("seen"), execution history and the escalation ledger.
 * The original loop-runner kept this in SQLite because multiple OS processes
 * shared it; here a single in-process engine owns the state, so atomic
 * tmp+rename writes with a debounce are enough — and keep the plugin at zero
 * runtime dependencies (no native builds, nothing to allowBuilds).
 *
 * Durability contract: every mutation goes through `mutate()`, which applies
 * the transform immediately and schedules a debounced atomic save. `flush()`
 * forces the save; the plugin calls it on dispose and before critical
 * transitions that must survive a crash (event claims, acks).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Cap executions kept per job (ring buffer; UI reads the tail). */
const MAX_EXECUTIONS_PER_JOB = 100
/** Cap escalations kept globally. */
const MAX_ESCALATIONS = 500

/** @returns {object} a fresh, schema-complete state document */
function emptyState() {
  return {
    version: 1,
    jobs: {}, // id -> job record (schedule/adapter/escalation/paused/nextRunAt/...)
    events: [], // {eventId, jobId, payload, status, attempts, nextAttemptAt, createdAt, claimedAt, consumedAt}
    seen: {}, // jobId -> { candidateId -> seenAt(epoch ms) }
    executions: [], // {runId, jobId, startedAt, finishedAt, status, newCandidates, error}
    escalations: [], // {escalationId, eventId, jobId, trigger, sessionId, outcome, startedAt, finishedAt, error, textPreview}
  }
}

/** Coerce a loaded document into shape; unknown fields survive untouched. */
function repair(doc) {
  const state = emptyState()
  if (!doc || typeof doc !== 'object') return state
  if (doc.jobs && typeof doc.jobs === 'object') state.jobs = doc.jobs
  if (Array.isArray(doc.events)) state.events = doc.events
  if (doc.seen && typeof doc.seen === 'object') state.seen = doc.seen
  if (Array.isArray(doc.executions)) state.executions = doc.executions
  if (Array.isArray(doc.escalations)) state.escalations = doc.escalations
  return state
}

export class Store {
  /**
   * @param {string} file - absolute path of state.json
   * @param {{ seenRetentionDays?: number, eventRetentionDays?: number, debounceMs?: number, now?: () => number }} [opts]
   */
  constructor(file, opts = {}) {
    this.file = file
    this.seenRetentionDays = opts.seenRetentionDays ?? 90
    this.eventRetentionDays = opts.eventRetentionDays ?? 30
    this.debounceMs = opts.debounceMs ?? 50
    this.now = opts.now ?? Date.now
    this.state = emptyState()
    /** @type {NodeJS.Timeout | null} */
    this._timer = null
    /** Running number for ids assigned this process; combined with a random base. */
    this._seq = 0
  }

  /** Load from disk with self-repair: a corrupt file is backed up, never trusted. */
  load() {
    mkdirSync(path.dirname(this.file), { recursive: true })
    if (!existsSync(this.file)) {
      this.state = emptyState()
      return this
    }
    try {
      this.state = repair(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      const backup = `${this.file}.corrupt-${this.now()}`
      try { renameSync(this.file, backup) } catch { /* best effort */ }
      this.state = emptyState()
      this.state.lastLoadError = String(error.message || error)
    }
    this.prune()
    return this
  }

  /**
   * Apply a transform to the live state and schedule the debounced save.
   * The transform must be synchronous (build its async inputs beforehand).
   * @template T
   * @param {(state: object) => T} fn
   * @returns {T}
   */
  mutate(fn) {
    const result = fn(this.state)
    this._scheduleSave()
    return result
  }

  _scheduleSave() {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush()
    }, this.debounceMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  /** Atomic save: tmp file + rename, so a crash never leaves a half-written state. */
  flush() {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
    renameSync(tmp, this.file)
  }

  /** Fresh ids that are unique for practical purposes without a uuid dep. */
  newId(prefix) {
    this._seq += 1
    return `${prefix}-${this.now().toString(36)}-${this._seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  /** Drop stale dedupe entries, consumed events and overflow history. */
  prune() {
    const now = this.now()
    const seenCutoff = now - this.seenRetentionDays * 86400000
    const eventCutoff = now - this.eventRetentionDays * 86400000
    let prunedSeen = 0
    let prunedEvents = 0

    for (const job of Object.values(this.state.jobs)) {
      const seen = this.state.seen[job.id]
      if (!seen) continue
      for (const [candidateId, seenAt] of Object.entries(seen)) {
        if (seenAt < seenCutoff) { delete seen[candidateId]; prunedSeen++ }
      }
    }

    const before = this.state.events.length
    this.state.events = this.state.events.filter(
      (e) => !(e.status === 'consumed' && (e.consumedAt ?? 0) < eventCutoff) && e.status !== 'dead',
    )
    prunedEvents = before - this.state.events.length

    // Ring buffers per job (keep the newest MAX per job), then escalations.
    const perJob = new Map()
    this.state.executions = this.state.executions.filter((row) => {
      const used = perJob.get(row.jobId) ?? 0
      if (used >= MAX_EXECUTIONS_PER_JOB) return false
      perJob.set(row.jobId, used + 1)
      return true
    })
    if (this.state.escalations.length > MAX_ESCALATIONS) {
      this.state.escalations = this.state.escalations.slice(-MAX_ESCALATIONS)
    }
    return { prunedSeen, prunedEvents }
  }

  // ------------------------------------------------------------------ jobs

  upsertJob(job) {
    return this.mutate((s) => {
      s.jobs[job.id] = job
      return job
    })
  }

  getJob(id) {
    return this.state.jobs[id] ?? null
  }

  listJobs() {
    return Object.values(this.state.jobs)
  }

  removeJob(id) {
    return this.mutate((s) => {
      const job = s.jobs[id]
      delete s.jobs[id]
      delete s.seen[id]
      s.events = s.events.filter((e) => e.jobId !== id || e.status === 'in-flight')
      s.executions = s.executions.filter((row) => row.jobId !== id)
      return job ?? null
    })
  }

  // ---------------------------------------------------------------- events

  /** Insert a deduped, aggregated event group; returns the created record. */
  enqueueEvent(jobId, payload) {
    return this.mutate((s) => {
      const event = {
        eventId: this.newId('evt'),
        jobId,
        payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: this.now(),
        claimedAt: null,
        consumedAt: null,
      }
      s.events.push(event)
      return event
    })
  }

  /** Oldest event ready to be claimed (backoff respected), for a job or any. */
  nextPending(jobId = null) {
    const now = this.now()
    let best = null
    for (const e of this.state.events) {
      if (e.status !== 'pending') continue
      if (jobId && e.jobId !== jobId) continue
      if ((e.nextAttemptAt ?? 0) > now) continue
      if (!best || e.createdAt < best.createdAt) best = e
    }
    return best
  }

  /** Count events by status, optionally scoped to one job. */
  eventCounts(jobId = null) {
    const counts = { pending: 0, 'in-flight': 0, consumed: 0, dead: 0 }
    for (const e of this.state.events) {
      if (jobId && e.jobId !== jobId) continue
      if (counts[e.status] !== undefined) counts[e.status]++
    }
    return counts
  }

  listEvents(jobId, status = null, limit = 50) {
    const out = this.state.events
      .filter((e) => e.jobId === jobId && (!status || e.status === status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(1000, limit)))
    return out
  }

  // ------------------------------------------------------------- execution

  recordExecution(row) {
    return this.mutate((s) => {
      s.executions.push({ runId: this.newId('run'), ...row })
      // Cheap cap: the full per-job ring runs in prune().
      if (s.executions.length > 5000) s.executions = s.executions.slice(-2500)
      return s.executions[s.executions.length - 1]
    })
  }

  listExecutions(jobId, limit = 20) {
    return this.state.executions
      .filter((row) => row.jobId === jobId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, Math.min(1000, limit)))
  }

  // ------------------------------------------------------------ escalation

  appendEscalation(row) {
    return this.mutate((s) => {
      const entry = { escalationId: this.newId('esc'), outcome: 'running', error: null, textPreview: '', ...row }
      s.escalations.push(entry)
      if (s.escalations.length > MAX_ESCALATIONS * 2) s.escalations = s.escalations.slice(-MAX_ESCALATIONS)
      return entry
    })
  }

  settleEscalation(escalationId, patch) {
    return this.mutate((s) => {
      const entry = s.escalations.find((x) => x.escalationId === escalationId)
      if (entry) Object.assign(entry, patch)
      return entry ?? null
    })
  }

  listEscalations(limit = 50, jobId = null) {
    return this.state.escalations
      .filter((x) => !jobId || x.jobId === jobId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, Math.min(500, limit)))
  }
}
