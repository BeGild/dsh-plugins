/**
 * Model-callable tools: the agent creates and manages both job kinds from a
 * conversation, no UI clicking required.
 *
 * Descriptions stay deliberately tight — tool manuals live in the prompt
 * prefix, so every line costs cache on all sides (AGENTS.md §10.2). The
 * adapter contract below is the minimum a model needs to emit a correct
 * watcher on the first try; details live in README.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildJobRecord, applyJobUpdate } from '../core/jobs.js'
import { describeSchedule } from '../core/schedule.js'

const ADAPTER_CONTRACT = [
  'Adapter contract (watch jobs): plain Node script, executed as `node adapter.js` with a hard timeout.',
  'stdout = one JSON object per line: {"id": stable-string, "payload": any-JSON, "group_key"?: string, "occurred_at"?: ISO}.',
  'Empty stdout + exit 0 = quiet poll. exit !=0 = failed poll (stderr shown in history). Read-only: never mutate the source.',
  'id MUST be stable across polls (runtime dedupes on it). For reminders derive it from the time slot, not the clock tick',
  '(e.g. "rem:2026-10-12:3"), poll ~5x faster than the slot, gate on active hours; env SCENARIO_NOW pins the clock for tests.',
].join(' ')

const SCHEDULE_HELP = 'schedule = exactly one of: schedule_interval_seconds (>=10), schedule_cron ("m h dom mon dow", local time), schedule_run_at (ISO or epoch ms, one-shot).'

/**
 * Register every loop tool. Returns the names of the registered tools.
 */
export function registerTools(ctx, deps) {
  const { store, engine, consumer, escalator, scenariosRoot } = deps
  const logger = deps.logger ?? console
  const registered = []

  const scheduleFromArgs = (args) => {
    if (args.schedule_cron) return { cron: args.schedule_cron }
    if (args.schedule_interval_seconds) return { intervalSeconds: args.schedule_interval_seconds }
    if (args.schedule_run_at) return { runAt: args.schedule_run_at }
    throw new Error(`no schedule given. ${SCHEDULE_HELP}`)
  }

  const jobSummary = (job) => {
    const counts = store.eventCounts(job.id)
    const state = job.paused ? 'paused' : (job.lastStatus ?? 'registered')
    return `${job.id} [${job.kind}] "${job.title}" · ${describeSchedule(job.schedule)} · ${state}`
      + (job.kind === 'watch' ? ` · queue pending=${counts.pending} dead=${counts.dead}` : '')
      + (job.nextRunAt ? ` · next ${new Date(job.nextRunAt).toLocaleString()}` : ' · no next run')
      + (job.lastError ? ` · lastError: ${job.lastError}` : '')
  }

  const register = (spec) => {
    const tool = defineTool(spec)
    ctx.tools.register(tool)
    registered.push(tool.name)
    return tool
  }

  register({
    name: 'job_create',
    description: 'Create a scheduled job. Two kinds: "watch" runs a zero-token JS adapter script on a schedule and escalates deduped events to an agent; "agent" runs instructions through an agent session on a schedule (costs tokens per run). ' + ADAPTER_CONTRACT + ' ' + SCHEDULE_HELP,
    parameters: {
      kind: { type: 'string', required: true, description: '"watch" (zero-token script checks) or "agent" (scheduled agent runs).' },
      title: { type: 'string', required: true, description: 'Human-readable job title.' },
      id: { type: 'string', description: 'Optional slug id ([a-z0-9-]); derived when omitted.' },
      schedule_cron: { type: 'string', description: '5-field cron, local time, e.g. "0 9 * * 1-5".' },
      schedule_interval_seconds: { type: 'number', description: 'Fixed interval in seconds (>=10).' },
      schedule_run_at: { type: 'string', description: 'One-shot fire time, ISO string or epoch ms.' },
      adapter_code: { type: 'string', description: 'watch only: full JS source of the adapter script (written under the scenario dir).' },
      adapter_file: { type: 'string', description: 'watch only: path to an existing adapter JS file, instead of adapter_code.' },
      instructions: { type: 'string', description: 'Agent instructions for escalations / the prompt for agent jobs. Required for agent jobs.' },
      baseline: { type: 'string', description: '"ignore" (default: first poll only records, no events) or "enqueue" (process backlog too).' },
      aggregate_window_seconds: { type: 'number', description: 'Group records closer than this many seconds into one event (default 0).' },
      escalation_mode: { type: 'string', description: '"fresh" (new session per run, default) or "pinned" (one continuing session per job).' },
      provider: { type: 'string', description: 'Optional provider override for escalation sessions.' },
      model: { type: 'string', description: 'Optional model override for escalation sessions.' },
      workdir: { type: 'string', description: 'Optional working directory for escalation sessions.' },
      timeout_minutes: { type: 'number', description: 'Escalation timeout in minutes (default 30).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' }, jobId: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const { job, wroteAdapter } = buildJobRecord({
        id: args.id,
        kind: args.kind,
        title: args.title,
        description: args.description,
        schedule: scheduleFromArgs(args),
        adapterCode: args.adapter_code,
        adapterFile: args.adapter_file,
        baseline: args.baseline,
        aggregateWindowSeconds: args.aggregate_window_seconds,
        instructions: args.instructions,
        mode: args.escalation_mode,
        provider: args.provider,
        model: args.model,
        workdir: args.workdir,
        timeoutMinutes: args.timeout_minutes,
      }, { scenariosRoot })
      store.upsertJob(job)
      logger.info(`[loop-runner] job created: ${jobSummary(job)}`)
      const lines = [`created ${jobSummary(job)}`]
      if (wroteAdapter) lines.push(`adapter written: ${wroteAdapter}`)
      if (job.kind === 'watch') {
        lines.push('note: the first poll runs on schedule and only records candidates (baseline=ignore) — no backlog flood.')
      }
      return { summary: lines.join('\n'), jobId: job.id }
    },
  })

  register({
    name: 'job_list',
    description: 'List all scheduled jobs (both kinds) with state, schedule, queue depth and next run.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute() {
      const jobs = store.listJobs()
      if (jobs.length === 0) return { summary: 'no jobs yet — create one with job_create' }
      return { summary: jobs.map(jobSummary).join('\n'), count: jobs.length }
    },
  })

  register({
    name: 'job_status',
    description: 'Show one job: config, next run, last error, queue counts, recent executions and escalations.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const job = store.getJob(args.id)
      if (!job) throw new Error(`job not found: ${args.id}`)
      const counts = store.eventCounts(job.id)
      const execs = store.listExecutions(job.id, 5)
        .map((row) => `  ${new Date(row.startedAt).toLocaleString()} ${row.status}${row.newCandidates ? ` +${row.newCandidates}` : ''}${row.error ? ` (${row.error.slice(0, 120)})` : ''}`)
      const escs = store.listEscalations(5, job.id)
        .map((row) => `  ${new Date(row.startedAt).toLocaleString()} ${row.trigger} ${row.outcome}${row.error ? ` (${row.error.slice(0, 120)})` : ''}`)
      const summary = [
        jobSummary(job),
        `queue: pending=${counts.pending} in-flight=${counts['in-flight']} consumed=${counts.consumed} dead=${counts.dead}`,
        execs.length ? `recent executions:\n${execs.join('\n')}` : 'no executions yet',
        escs.length ? `recent escalations:\n${escs.join('\n')}` : 'no escalations yet',
      ].join('\n')
      return { summary, job: { id: job.id, kind: job.kind, paused: job.paused, nextRunAt: job.nextRunAt } }
    },
  })

  register({
    name: 'job_pause',
    description: 'Pause a job. Watch jobs stop collecting (queued events still drain); agent jobs stop firing.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
      reason: { type: 'string', description: 'Optional reason kept in the record.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      return { summary: mutateJob(store, args.id, (job) => { job.paused = true; job.pauseReason = args.reason || ''; return `paused ${job.id}` }) }
    },
  })

  register({
    name: 'job_resume',
    description: 'Resume a paused job. skip_backlog=true discards records that appeared while paused (they are recorded but never escalated).',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
      skip_backlog: { type: 'boolean', description: 'Discard records accumulated during the pause (default false).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      return {
        summary: mutateJob(store, args.id, (job) => {
          job.paused = false
          job.pauseReason = ''
          if (args.skip_backlog) job.initialized = false
          return `resumed ${job.id}${args.skip_backlog ? ' (backlog will be recorded but not escalated)' : ''}`
        }),
      }
    },
  })

  register({
    name: 'job_update',
    description: 'Update a job (hot-applied): schedule, instructions/prompt, aggregate window, baseline, title, timeout. ' + SCHEDULE_HELP,
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
      schedule_cron: { type: 'string', description: 'New 5-field cron.' },
      schedule_interval_seconds: { type: 'number', description: 'New interval in seconds.' },
      schedule_run_at: { type: 'string', description: 'New one-shot time.' },
      instructions: { type: 'string', description: 'New escalation instructions / agent prompt.' },
      aggregate_window_seconds: { type: 'number', description: 'New aggregation window.' },
      baseline: { type: 'string', description: '"ignore" or "enqueue".' },
      title: { type: 'string', description: 'New title.' },
      description: { type: 'string', description: 'New description.' },
      timeout_minutes: { type: 'number', description: 'New escalation timeout.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const job = store.getJob(args.id)
      if (!job) throw new Error(`job not found: ${args.id}`)
      const schedule = args.schedule_cron || args.schedule_interval_seconds || args.schedule_run_at
        ? scheduleFromArgs(args)
        : undefined
      const next = applyJobUpdate(job, {
        ...(schedule !== undefined ? { schedule } : {}),
        ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
        ...(args.aggregate_window_seconds !== undefined ? { aggregateWindowSeconds: args.aggregate_window_seconds } : {}),
        ...(args.baseline !== undefined ? { baseline: args.baseline } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.timeout_minutes !== undefined ? { timeoutMinutes: args.timeout_minutes } : {}),
      })
      store.upsertJob(next)
      return { summary: `updated ${jobSummary(next)}` }
    },
  })

  register({
    name: 'job_run_now',
    description: 'Fire a job immediately: watch jobs poll at once (interval re-anchors); agent jobs escalate at once. Schedule untouched for cron.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const result = await engine.runNow(args.id)
      return { summary: result.fired ? `fired ${args.id} (${result.kind})` : `not fired: ${result.reason}` }
    },
  })

  register({
    name: 'job_remove',
    description: 'Remove a job: stops scheduling, keeps nothing running. History in the ledger survives; scenario adapter files stay on disk.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const removed = store.removeJob(args.id)
      if (!removed) throw new Error(`job not found: ${args.id}`)
      return { summary: `removed ${args.id} (adapter files kept on disk)` }
    },
  })

  register({
    name: 'events_requeue',
    description: 'Requeue a job\'s dead events (and lift retry backoff on pending ones): use after fixing the failure cause.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const count = consumer.requeue(args.id)
      return { summary: `requeued ${count} event(s) for ${args.id}` }
    },
  })

  register({
    name: 'consume_once',
    description: 'Diagnostic: claim the oldest pending event of a job and escalate it right now, waiting for the agent to finish.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { summary: { type: 'string' }, ok: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const job = store.getJob(args.id)
      if (!job) throw new Error(`job not found: ${args.id}`)
      const event = store.nextPending(args.id)
      if (!event) return { summary: `no pending event for ${args.id}` }
      consumer.claim(event)
      const result = await escalator.escalate(job, event, 'event')
      consumer.ack(event, result)
      return {
        summary: result.ok
          ? `escalated ${event.eventId} -> session ${result.sessionId}\n${(result.text ?? '').slice(0, 400)}`
          : `escalation failed: ${result.error}`,
        ok: result.ok,
      }
    },
  })

  return registered
}

/** Shared tiny helper: load, mutate in place inside store.mutate, report. */
function mutateJob(store, id, fn) {
  let report = null
  store.mutate((s) => {
    const job = s.jobs[id]
    if (!job) return
    report = fn(job)
    job.updatedAt = Date.now()
  })
  if (report === null) throw new Error(`job not found: ${id}`)
  return report
}

/** System-prompt announcement: teaches the agent the two-tier token philosophy. */
export const SYSTEM_PROMPT_GUIDANCE = [
  '## Scheduled jobs (dsh-loop-runner)',
  'Two job kinds, one engine. Watch jobs run a local JS adapter on a schedule with ZERO model tokens and queue deduped events; each queued event escalates to an agent session automatically. Agent jobs run instructions through an agent session on a schedule (tokens per run).',
  'When the user wants periodic checks, monitoring or reminders: build a watch job (job_create kind="watch") whose adapter emits a candidate record only when something deserves attention; never poll with the model itself. For pure scheduled agent work (daily digests, weekly reports) use kind="agent" with instructions.',
  'Adapter rules: read-only source access, stable ids (slot-derived for reminders, SCENARIO_NOW env pins the clock in tests), bounded payloads. Report state with job_list/job_status; job_run_now triggers immediately.',
].join('\n')
