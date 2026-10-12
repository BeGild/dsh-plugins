/**
 * Event consumer: turns pending queue entries into agent escalations.
 *
 * Contract ported from loopctl.py's wait/ack pair, adapted to a single
 * in-process owner:
 *  - an event is claimed (status 'in-flight') only when an escalation slot is
 *    available; the global cap keeps token spend and host load bounded;
 *  - success acks (status 'consumed');
 *  - failure returns the event to 'pending' with exponential backoff, and
 *    after maxAttempts marks it 'dead' (visible in the panel, requeueable);
 *  - boot recovery: events left 'in-flight' by a crashed host go back to
 *    'pending' unchanged (the escalation ledger tells whether the agent
 *    actually ran — the user decides, same caution as loop-runner's janitor).
 */

/** Backoff before a failed event may retry: min(60s * 2^attempts, 1h). */
export function retryBackoffMs(attempts) {
  return Math.min(60000 * 2 ** attempts, 3600000)
}

export class Consumer {
  /**
   * @param {{
   *   store: import('./store.js').Store,
   *   escalate: (job: object, event: object) => Promise<{ok:boolean, error?:string, sessionId?:string, text?:string}>,
   *   maxConcurrent?: number,
   *   maxAttempts?: number,
   *   logger?: { warn?: Function, error?: Function },
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store
    this.escalate = deps.escalate
    this.maxConcurrent = deps.maxConcurrent ?? 2
    this.maxAttempts = deps.maxAttempts ?? 5
    this.logger = deps.logger ?? console
    this.now = deps.now ?? Date.now
    /** @type {Set<string>} eventIds currently escalating */
    this.inFlight = new Set()
  }

  /** Host just booted: reclaim events a dead process left claimed. */
  recoverInFlight() {
    let recovered = 0
    this.store.mutate((s) => {
      for (const e of s.events) {
        if (e.status !== 'in-flight') continue
        // In-flight rows only exist for this process's own claims; anything
        // still marked is from before the crash (the live set starts empty).
        e.status = 'pending'
        e.claimedAt = null
        recovered++
      }
    })
    if (recovered) this.logger.warn?.(`[loop-runner] recovered ${recovered} in-flight event(s) from a previous run`)
    return recovered
  }

  /** Try to start escalations until the concurrency cap or the queue is dry. */
  pump() {
    let started = 0
    while (this.inFlight.size < this.maxConcurrent) {
      const event = this.store.nextPending()
      if (!event) break
      const job = this.store.getJob(event.jobId)
      if (!job) {
        // Orphan (job removed): drop instead of looping forever.
        this.store.mutate((s) => {
          const row = s.events.find((x) => x.eventId === event.eventId)
          if (row) row.status = 'dead'
        })
        continue
      }
      this.claim(event)
      this.dispatch(job, event)
      started++
    }
    return started
  }

  claim(event) {
    this.store.mutate((s) => {
      const row = s.events.find((x) => x.eventId === event.eventId)
      if (row) { row.status = 'in-flight'; row.claimedAt = this.now() }
    })
    this.inFlight.add(event.eventId)
    this.store.flush()
  }

  dispatch(job, event) {
    // Intentionally not awaited: pump() must never block the engine loop.
    this.escalate(job, event)
      .then((result) => this.ack(event, result))
      .catch((error) => this.ack(event, { ok: false, error: String(error?.message || error) }))
  }

  /** Settle one escalation: ack on success, backoff/dead on failure. */
  ack(event, result) {
    this.inFlight.delete(event.eventId)
    if (result?.ok) {
      this.store.mutate((s) => {
        const row = s.events.find((x) => x.eventId === event.eventId)
        if (row) { row.status = 'consumed'; row.consumedAt = this.now(); row.nextAttemptAt = 0 }
      })
      this.store.flush()
      return
    }
    const attempts = (event.attempts ?? 0) + 1
    const dead = attempts >= this.maxAttempts
    this.store.mutate((s) => {
      const row = s.events.find((x) => x.eventId === event.eventId)
      if (!row) return
      row.attempts = attempts
      if (dead) {
        row.status = 'dead'
        row.lastError = result?.error ?? 'escalation failed'
      } else {
        row.status = 'pending'
        row.nextAttemptAt = this.now() + retryBackoffMs(attempts)
        row.lastError = result?.error ?? 'escalation failed'
      }
      row.claimedAt = null
    })
    this.store.flush()
    this.logger.error?.(`[loop-runner] escalation for ${event.jobId} failed (attempt ${attempts}${dead ? ', dead' : ''}): ${result?.error ?? 'unknown'}`)
  }

  /**
   * Manual requeue (panel / events_requeue tool): dead events return to
   * pending with attempts reset, stuck pending events lose their backoff.
   * Returns how many events became runnable right now.
   */
  requeue(jobId) {
    const now = this.now()
    let revived = 0
    let lifted = 0
    this.store.mutate((s) => {
      for (const e of s.events) {
        if (e.jobId !== jobId) continue
        if (e.status === 'dead') { e.status = 'pending'; e.attempts = 0; e.nextAttemptAt = 0; e.lastError = null; revived++ }
        else if (e.status === 'pending' && (e.nextAttemptAt ?? 0) > now) { e.nextAttemptAt = 0; lifted++ }
      }
    })
    this.pump()
    return revived + lifted
  }
}
