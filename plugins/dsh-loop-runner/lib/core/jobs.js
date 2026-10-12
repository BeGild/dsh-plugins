/**
 * Job-record construction and validation — the shared write path behind the
 * loop_* model tools (and, later, any panel-side creation).
 *
 * A job is one record in the store no matter its kind; only `adapter` exists
 * for `watch` jobs, and for `agent` jobs `escalation.instructions` IS the
 * prompt. Watch adapters are JS files executed as `node adapter.js` child
 * processes: stdout must be JSON Lines of {id, payload, group_key?,
 * occurred_at?} records, read-only, stable ids (the loop-runner contract).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { nextAfter, normalizeSchedule } from './schedule.js'

/** Safe job id: lowercase slug, [a-z0-9-], reasonable length. */
export const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Validate input and build a complete job record. Does NOT touch the store.
 *
 * @param {{
 *   id?: string, kind:'watch'|'agent', title:string, description?: string,
 *   schedule: object,
 *   adapterCode?: string, adapterFile?: string, adapterCwd?: string, adapterTimeoutSeconds?: number,
 *   eventType?: string, baseline?: 'ignore'|'enqueue', aggregateWindowSeconds?: number,
 *   instructions?: string, mode?: 'fresh'|'pinned', provider?: string, model?: string,
 *   workdir?: string, timeoutMinutes?: number,
 * }} input
 * @param {{ scenariosRoot: string, now?: () => number }} env
 * @returns {{ job: object, wroteAdapter: string | null }}
 */
export function buildJobRecord(input, env) {
  const now = (env.now ?? Date.now)()
  const kind = input.kind
  if (kind !== 'watch' && kind !== 'agent') throw new Error('kind must be "watch" or "agent"')
  const title = String(input.title || '').trim()
  if (!title) throw new Error('title is required')

  let id = String(input.id || '').trim().toLowerCase()
  if (!id) {
    id = `job-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }
  if (!JOB_ID_RE.test(id)) {
    throw new Error(`id must match ${JOB_ID_RE} (lowercase letters, digits, dashes): ${id}`)
  }

  const schedule = normalizeSchedule(input.schedule)

  /** @type {object|null} */
  let wroteAdapter = null
  /** @type {object|undefined} */
  let adapter
  if (kind === 'watch') {
    const dir = path.join(env.scenariosRoot, id)
    let file
    if (input.adapterCode !== undefined && String(input.adapterCode).trim() !== '') {
      file = path.join(dir, 'adapter.js')
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, String(input.adapterCode), 'utf8')
      wroteAdapter = file
    } else if (input.adapterFile) {
      file = path.resolve(String(input.adapterFile))
    } else {
      throw new Error('watch jobs need adapterCode (JS source written to the scenario dir) or adapterFile (existing JS file path)')
    }
    adapter = {
      file,
      cwd: input.adapterCwd || path.dirname(file),
      timeoutSeconds: input.adapterTimeoutSeconds ?? 60,
      env: {},
    }
  }

  const instructions = String(input.instructions ?? '').trim() || undefined
  if (kind === 'agent' && !instructions) {
    throw new Error('agent jobs need instructions (the prompt sent to the agent on every run)')
  }

  const job = {
    id,
    kind,
    title,
    description: input.description ? String(input.description) : '',
    schedule,
    eventType: input.eventType ? String(input.eventType) : '',
    baseline: input.baseline === 'enqueue' ? 'enqueue' : 'ignore',
    filter: { aggregateWindowSeconds: Math.max(0, Number(input.aggregateWindowSeconds ?? 0) || 0) },
    escalation: {
      mode: input.mode === 'pinned' ? 'pinned' : 'fresh',
      provider: input.provider ? String(input.provider) : '',
      model: input.model ? String(input.model) : '',
      workdir: input.workdir ? String(input.workdir) : '',
      timeoutMinutes: Math.max(1, Number(input.timeoutMinutes ?? 30) || 30),
      instructions: instructions ?? '',
    },
    ...(adapter ? { adapter } : {}),
    paused: false,
    initialized: false,
    pinnedSessionId: null,
    nextRunAt: nextRunFrom(schedule, now),
    lastStatus: 'registered',
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
  return { job, wroteAdapter }
}

/** First fire: cron/interval start from the next boundary; one-shot from runAt if still ahead. */
function nextRunFrom(schedule, now) {
  if (schedule.kind === 'once') return schedule.runAt > now ? schedule.runAt : null
  return nextAfter(schedule, now)
}

/** Whitelisted hot-reload fields for job_update (mirrors loop-runner semantics). */
export function applyJobUpdate(job, patch) {
  const next = { ...job }
  if (patch.schedule !== undefined) {
    next.schedule = normalizeSchedule(patch.schedule)
    if (next.schedule.kind === 'once') next.done = false
  }
  if (patch.instructions !== undefined) {
    next.escalation = { ...next.escalation, instructions: String(patch.instructions) }
  }
  if (patch.aggregateWindowSeconds !== undefined) {
    next.filter = { ...next.filter, aggregateWindowSeconds: Math.max(0, Number(patch.aggregateWindowSeconds) || 0) }
  }
  if (patch.baseline !== undefined) {
    next.baseline = patch.baseline === 'enqueue' ? 'enqueue' : 'ignore'
  }
  if (patch.title !== undefined) next.title = String(patch.title)
  if (patch.description !== undefined) next.description = String(patch.description)
  if (patch.timeoutMinutes !== undefined) {
    next.escalation = { ...next.escalation, timeoutMinutes: Math.max(1, Number(patch.timeoutMinutes) || 30) }
  }
  // A schedule change re-anchors the next fire from now.
  if (patch.schedule !== undefined) {
    next.nextRunAt = nextRunFrom(next.schedule, Date.now())
    if (next.paused === false && next.nextRunAt === null) next.done = true
  }
  next.updatedAt = Date.now()
  return next
}
