/**
 * Escalation engine: run one prompt through a real DSH agent session and
 * settle the outcome into the ledger.
 *
 * The session-driving shape is the one verified live in this repo's
 * dsh-agentos-remote (lib/index.js runTask): `ctx.agents.create` →
 * `agent.followup()` → `await agent.whenIdle()` → read assistant text from
 * `session.snapshotEvents()` → `handle.dispose()`. Pinned jobs additionally
 * try `ctx.agents.resume` first so a scenario keeps conversation continuity.
 *
 * `ctx.agents` is read lazily (never injected): a host without agent services
 * still boots; the first escalation then fails with a clear message instead
 * of taking the all-or-nothing profile down.
 */

import { createHash, randomUUID } from 'node:crypto'

/** Prompt payload cap: bounded context for the next LLM decision, never a dump. */
const MAX_PAYLOAD_CHARS = 16000
/** Ledger text preview length. */
const PREVIEW_CHARS = 400

/** fs- and session-safe id fragment. */
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'job'
}

/** Short stable hash so one event always maps to one sessionId. */
function hash8(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
}

/** Build the escalation prompt: instructions first, then the bounded event payload. */
export function buildPrompt(job, event) {
  const instructions = job.escalation?.instructions || job.title || job.id
  if (!event) return instructions
  let payloadJson
  try {
    payloadJson = JSON.stringify(event.payload, null, 2)
  } catch {
    payloadJson = String(event.payload)
  }
  if (payloadJson.length > MAX_PAYLOAD_CHARS) {
    payloadJson = `${payloadJson.slice(0, MAX_PAYLOAD_CHARS)}\n… (payload truncated)`
  }
  return `${instructions}\n\n--- event payload (JSON) ---\n${payloadJson}`
}

/** Collect assistant text blocks from the session log at/after startSeq (agentos-remote port). */
export function extractAssistantText(session, startSeq) {
  try {
    const events = session.snapshotEvents(startSeq)
    const parts = []
    for (const event of events) {
      if (event?.type !== 'assistant/message') continue
      const blocks = event?.data?.message?.content ?? event?.message?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block?.type === 'text' && block.text) parts.push(block.text)
      }
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

export class Escalator {
  /**
   * @param {{
   *   ctx: object,
   *   store: import('../core/store.js').Store,
   *   defaults: { mode:'fresh'|'pinned', provider:string, model:string, timeoutMinutes:number },
   *   logger?: { info?: Function, warn?: Function, error?: Function },
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.ctx = deps.ctx
    this.store = deps.store
    this.defaults = deps.defaults
    this.logger = deps.logger ?? console
    this.now = deps.now ?? Date.now
    /** @type {Map<string, {handle:object, dispose:Function}>} jobId -> pinned handle */
    this.pinned = new Map()
    this._workspaceWarned = false
  }

  /** Dispose cached pinned handles (plugin teardown). */
  disposeAll() {
    for (const [, entry] of this.pinned) {
      try { entry.handle?.dispose?.() } catch { /* best effort */ }
    }
    this.pinned.clear()
  }

  /**
   * Escalate one unit of work. Resolves with the settle result — never throws
   * (the consumer's ack path treats a rejection and {ok:false} the same, but
   * a settled return keeps agent-job fires simple too).
   *
   * @param {object} job
   * @param {object|null} event - queue entry for event triggers, null for scheduled/manual agent fires
   * @param {'event'|'schedule'|'manual'} trigger
   */
  async escalate(job, event, trigger) {
    const esc = this.store.appendEscalation({
      eventId: event?.eventId ?? null,
      jobId: job.id,
      trigger,
      sessionId: null,
      startedAt: this.now(),
    })
    const prompt = buildPrompt(job, event)
    try {
      const result = await this.runAgent(job, event, prompt)
      this.store.settleEscalation(esc.escalationId, {
        outcome: result.ok ? 'succeeded' : 'failed',
        sessionId: result.sessionId ?? null,
        finishedAt: this.now(),
        error: result.error ?? null,
        textPreview: (result.text ?? '').slice(0, PREVIEW_CHARS),
      })
      return result
    } catch (error) {
      const message = String(error?.message || error)
      this.store.settleEscalation(esc.escalationId, { outcome: 'failed', finishedAt: this.now(), error: message })
      return { ok: false, error: message }
    }
  }

  /** One agent round-trip: (resume|create) → followup → whenIdle → extract → dispose-if-fresh. */
  async runAgent(job, event, prompt) {
    const agents = this.ctx.agents
    if (!agents) {
      return { ok: false, error: 'ctx.agents is unavailable on this host — cannot escalate. Install/enable an agents-providing bundle.' }
    }
    const mode = job.escalation?.mode || this.defaults.mode
    const agentOptions = {}
    const provider = job.escalation?.provider || this.defaults.provider
    const model = job.escalation?.model || this.defaults.model
    if (provider) agentOptions.provider = provider
    if (model) agentOptions.model = model
    const timeoutMs = (job.escalation?.timeoutMinutes ?? this.defaults.timeoutMinutes) * 60000

    const suffix = event ? hash8(event.eventId) : `${this.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const sessionId = `loop-${slug(job.id)}-${suffix}`
    const cwd = job.escalation?.workdir || undefined
    let handle
    let reused = false

    if (mode === 'pinned') {
      const cached = this.pinned.get(job.id)
      if (cached) { handle = cached.handle; reused = true }
    }
    if (!handle) {
      try {
        handle = await (mode === 'pinned' && job.pinnedSessionId
          ? agents.resume({ resumeSessionId: job.pinnedSessionId, ...(Object.keys(agentOptions).length ? { agentOptions } : {}) })
          : agents.create({ sessionId, ...(Object.keys(agentOptions).length ? { agentOptions } : {}), ...(cwd ? { meta: { cwd } } : {}) }))
        if (mode === 'pinned') {
          const liveId = handle?.agent?.session?.id ?? sessionId
          this.store.mutate((s) => { const live = s.jobs[job.id]; if (live) live.pinnedSessionId = liveId })
          this.pinned.set(job.id, { handle })
        }
      } catch (error) {
        // A cold resume can fail (session gone / preset not rebuildable): fall
        // through to a fresh session rather than failing forever.
        if (mode !== 'pinned') throw error
        this.logger.warn?.(`[loop-runner] pinned resume failed for ${job.id}, creating fresh: ${error?.message || error}`)
        this.pinned.delete(job.id)
        handle = await agents.create({
          sessionId,
          ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
          ...(cwd ? { meta: { cwd } } : {}),
        })
        const liveId = handle?.agent?.session?.id ?? sessionId
        this.store.mutate((s) => { const live = s.jobs[job.id]; if (live) live.pinnedSessionId = liveId })
        this.pinned.set(job.id, { handle })
      }
    }

    const agent = handle.agent
    const startSeq = agent.session?.seq ?? 0
    const finalSessionId = agent.session?.id ?? sessionId
    this.attachWorkspace(finalSessionId, cwd)

    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-loop-runner' },
    })

    let timedOut = false
    const guard = new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        try { agent.cancel?.({ kind: 'hook', reason: 'dsh-loop-runner: escalation timed out' }) } catch { /* optional API */ }
        resolve()
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })

    try {
      await Promise.race([agent.whenIdle(), guard])
    } catch (error) {
      this.dropPinnedOnFailure(job, mode, reused, handle)
      return { ok: false, sessionId: finalSessionId, error: String(error?.message || error) }
    }
    if (timedOut) {
      this.dropPinnedOnFailure(job, mode, reused, handle)
      return { ok: false, sessionId: finalSessionId, error: `escalation timed out after ${timeoutMs / 60000} minutes` }
    }

    const text = extractAssistantText(agent.session, startSeq)
    // Pinned handles stay alive for the next fire; fresh ones are one-shot.
    if (mode !== 'pinned') await disposeHandle(handle)
    if (!text) {
      return { ok: false, sessionId: finalSessionId, error: 'agent produced no assistant text' }
    }
    return { ok: true, sessionId: finalSessionId, text }
  }

  /**
   * A failed pinned escalation must not leave a dead handle cached: dispose it
   * so the next attempt re-resumes from the persisted pinnedSessionId.
   */
  dropPinnedOnFailure(job, mode, reused, handle) {
    if (mode !== 'pinned') {
      if (!reused) void disposeHandle(handle)
      return
    }
    this.pinned.delete(job.id)
    void disposeHandle(handle)
  }

  /** Best-effort: group the run under its project workspace in the GUI. */
  attachWorkspace(sessionId, cwd) {
    if (!cwd) return
    try {
      const registry = this.ctx.get?.('workspaceRegistry')
      if (!registry) return
      const workspace = registry.resolve ? registry.resolve(cwd)
        : registry.ensure ? registry.ensure(cwd)
          : registry.get ? registry.get(cwd) : null
      workspace?.attachSession?.(sessionId)
    } catch (error) {
      if (!this._workspaceWarned) {
        this._workspaceWarned = true
        this.logger.warn?.(`[loop-runner] workspace attach failed (${error?.message || error}); runs still work, only sidebar grouping is missing`)
      }
    }
  }
}

async function disposeHandle(handle) {
  try { await handle?.dispose?.() } catch { /* best effort */ }
}
