/**
 * dsh-loop-runner — two kinds of scheduled jobs for DeepSeek Harness.
 *
 *  - `watch` jobs: zero-token JS adapter scripts polled on a schedule; their
 *    deduped, aggregated events queue durably and escalate into real agent
 *    sessions only when something deserves attention.
 *  - `agent` jobs: cron / interval / one-shot prompts run through an agent
 *    session (tokens per run).
 *
 * One engine (in-process ticker), one escalation bridge (ctx.agents, read
 * lazily), one ledger. Management surface: loop_* model tools (agents create
 * jobs conversationally) + /api/dsh-loop-runner/* routes + the web client
 * panel (lib/client.js, "定时任务" sidebar seat).
 *
 * Scheduling semantics port the battle-tested loop-runner skill: dedupe is the
 * delivery authority, baseline "ignore" prevents backlog floods, missed slots
 * are skipped (never backfilled), failed escalations never ack.
 */

import path from 'node:path'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import { Store } from './core/store.js'
import { Engine } from './core/engine.js'
import { Consumer } from './core/consumer.js'
import { Escalator } from './host/escalation.js'
import { registerTools, SYSTEM_PROMPT_GUIDANCE } from './host/tools.js'
import { registerRoutes } from './host/routes.js'

export const name = 'dsh-loop-runner'
// 'agents' is injected on purpose: Cordis throws `cannot get property "agents"
// without inject` on undeclared service access, so the lazy-read trick does
// not work on 0.2.0. A host without agent services cannot use this plugin
// anyway — parking the fiber there is the honest outcome (same choice as
// dsh-timer-agent, the 0.2.0-native reference).
export const inject = ['webServer', 'tools', 'systemPrompt', 'agents']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  dataDir: Schema.string().default(''),
  scenariosRoot: Schema.string().default(''),
  tickerSeconds: Schema.number().default(30).min(5),
  maxConcurrentEscalations: Schema.number().default(2).min(1),
  escalationMode: Schema.string().default('fresh'),
  escalationProvider: Schema.string().default(''),
  escalationModel: Schema.string().default(''),
  escalationTimeoutMinutes: Schema.number().default(30).min(1),
  workdirRoot: Schema.string().default(''),
  consumerMaxAttempts: Schema.number().default(5).min(1),
  seenRetentionDays: Schema.number().default(90).min(1),
  eventRetentionDays: Schema.number().default(30).min(1),
  announceToAgent: Schema.boolean().default(true),
  uiPollMs: Schema.number().default(5000).min(1000),
})

/** Resolve the default data dir: $DSH_HOME/loop-runner when set, else ~/.dsh/loop-runner. */
function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'loop-runner')
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  if (config.enabled === false) {
    logger.info('[loop-runner] disabled by config')
    return
  }

  const dataDir = config.dataDir && config.dataDir.trim() !== ''
    ? path.resolve(config.dataDir)
    : defaultDataDir()
  const scenariosRoot = config.scenariosRoot && config.scenariosRoot.trim() !== ''
    ? path.resolve(config.scenariosRoot)
    : path.join(dataDir, 'jobs')
  mkdirSync(scenariosRoot, { recursive: true })

  const store = new Store(path.join(dataDir, 'state.json'), {
    seenRetentionDays: config.seenRetentionDays ?? 90,
    eventRetentionDays: config.eventRetentionDays ?? 30,
  }).load()

  const escalator = new Escalator({
    ctx,
    store,
    defaults: {
      mode: config.escalationMode === 'pinned' ? 'pinned' : 'fresh',
      provider: config.escalationProvider ?? '',
      model: config.escalationModel ?? '',
      timeoutMinutes: config.escalationTimeoutMinutes ?? 30,
      workdirRoot: config.workdirRoot ?? '',
    },
    logger,
  })

  const consumer = new Consumer({
    store,
    escalate: (job, event) => escalator.escalate(job, event, 'event'),
    maxConcurrent: config.maxConcurrentEscalations ?? 2,
    maxAttempts: config.consumerMaxAttempts ?? 5,
    logger,
  })

  const engine = new Engine({
    store,
    tickerSeconds: config.tickerSeconds ?? 30,
    onEvent: () => { consumer.pump() },
    onAgentFire: (job, trigger) => {
      // Scheduled/manual agent fires escalate immediately (no queue entry).
      escalator.escalate(job, null, trigger).then(() => consumer.pump()).catch(() => {})
    },
    logger,
  })

  // Crash recovery: events a dead host left claimed go back to pending.
  consumer.recoverInFlight()

  registerTools(ctx, { store, engine, consumer, escalator, scenariosRoot, logger })

  if (config.announceToAgent !== false && ctx.systemPrompt?.section) {
    try {
      ctx.systemPrompt.section({ name: 'plugin:loop-runner', order: 202, text: SYSTEM_PROMPT_GUIDANCE })
    } catch (error) {
      logger.warn?.(`[loop-runner] system prompt section unavailable: ${error?.message || error}`)
    }
  }

  if (ctx.webServer?.register) {
    const disposeRoutes = registerRoutes(ctx.webServer, { store, engine, consumer, uiPollMs: config.uiPollMs ?? 5000 })
    // ctx.effect runs its callback IMMEDIATELY and keeps the return value as
    // the disposer — the arrow below must RETURN the teardown, not run it.
    ctx.effect(() => () => { disposeRoutes() })
  } else {
    logger.warn?.('[loop-runner] no webServer service — panel routes skipped (tools still work)')
  }

  engine.start()
  consumer.pump()
  logger.info(`[loop-runner] started: ${store.listJobs().length} job(s), scenarios at ${scenariosRoot}`)

  // Serial teardown in one effect (multi-disposer effects run concurrently):
  // stop the ticker first, then flush state, then drop pinned handles.
  ctx.effect(() => () => {
    engine.stop()
    store.flush()
    escalator.disposeAll()
    logger.info('[loop-runner] stopped')
  })
}
