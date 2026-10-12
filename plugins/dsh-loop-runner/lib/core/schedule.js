/**
 * Schedule math for dsh-loop-runner — interval, 5-field cron (local time) and
 * one-shot timestamps, normalized to one shape with one `nextAfter` oracle.
 *
 * Ported in spirit from loopctl.py's deadline-based scheduling and
 * dsh-timer-agent's src/core/schedule.ts: every job carries an absolute
 * `nextRunAt`; the engine rolls it forward inside the same mutate that accepts
 * the fire, so a tick that arrives late or twice can never double-fire.
 *
 * Cron is evaluated in the host's local timezone, DST-naive (the classic cron
 * trade-off: a skipped/unreachable local time simply produces no run that day).
 */

/** Minimum accepted polling interval — protects external sources from hammering. */
export const MIN_INTERVAL_SECONDS = 10
/** Maximum cron lookahead — Feb 30 and friends resolve to "never" past this. */
const CRON_LOOKAHEAD_DAYS = 366

/**
 * Validate + normalize a user-supplied schedule.
 * @param {unknown} raw - {intervalSeconds} | {cron} | {runAt} (epoch ms or ISO string)
 * @returns {{kind:'interval', intervalSeconds:number} | {kind:'cron', cron:string, ast:CronAst} | {kind:'once', runAt:number}}
 * @throws {Error} on an empty or malformed schedule
 */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('schedule must be an object: {intervalSeconds} | {cron} | {runAt}')
  const s = raw
  if (s.cron !== undefined) {
    if (typeof s.cron !== 'string') throw new Error('schedule.cron must be a string')
    return { kind: 'cron', cron: s.cron, ast: parseCron(s.cron) }
  }
  if (s.intervalSeconds !== undefined) {
    const n = Math.floor(Number(s.intervalSeconds))
    if (!Number.isFinite(n) || n < MIN_INTERVAL_SECONDS) {
      throw new Error(`schedule.intervalSeconds must be >= ${MIN_INTERVAL_SECONDS}`)
    }
    return { kind: 'interval', intervalSeconds: n }
  }
  if (s.runAt !== undefined) {
    const t = typeof s.runAt === 'number' ? s.runAt : Date.parse(String(s.runAt))
    if (!Number.isFinite(t)) throw new Error('schedule.runAt must be an epoch-ms number or an ISO string')
    return { kind: 'once', runAt: t }
  }
  throw new Error('schedule needs one of cron / intervalSeconds / runAt')
}

// --------------------------------------------------------------------- cron

/**
 * @typedef {{min:Set<number>,hour:Set<number>,dom:Set<number>,mon:Set<number>,dow:Set<number>,domStar:boolean,dowStar:boolean}} CronAst
 */

/** Parse one cron field into a value set: star, star/n, a, a-b, a-b/n, comma lists. */
function parseField(field, min, max, name) {
  const values = new Set()
  for (const part of field.split(',')) {
    const m = /^(?:(\*|\d+(?:-\d+)?)(?:\/(\d+))?)$/.exec(part.trim())
    if (!m) throw new Error(`invalid cron field "${field}" (${name})`)
    const [, rangeText, stepText] = m
    const step = stepText !== undefined ? Number(stepText) : 1
    if (!Number.isFinite(step) || step < 1) throw new Error(`invalid cron step in "${field}" (${name})`)
    let lo = min
    let hi = max
    if (rangeText !== '*') {
      const dash = rangeText.indexOf('-')
      if (dash === -1) { lo = hi = Number(rangeText) } else {
        lo = Number(rangeText.slice(0, dash))
        hi = Number(rangeText.slice(dash + 1))
      }
    }
    if (!(lo >= min && hi <= max && lo <= hi)) throw new Error(`cron range ${lo}-${hi} out of ${name} bounds ${min}-${max}`)
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  if (values.size === 0) throw new Error(`empty cron field "${field}" (${name})`)
  return values
}

/**
 * Parse a 5-field cron expression (minute hour day-of-month month day-of-week;
 * dow 0 and 7 both mean Sunday).
 * @param {string} expr
 * @returns {CronAst}
 */
export function parseCron(expr) {
  const fields = String(expr).trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron expression must have 5 fields, got ${fields.length}: "${expr}"`)
  const min = parseField(fields[0], 0, 59, 'minute')
  const hour = parseField(fields[1], 0, 23, 'hour')
  const dom = parseField(fields[2], 1, 31, 'day-of-month')
  const mon = parseField(fields[3], 1, 12, 'month')
  const dowRaw = parseField(fields[4], 0, 7, 'day-of-week')
  if (dowRaw.has(7)) dowRaw.add(0)
  const dow = dowRaw
  // Classic vixie-cron rule: when BOTH dom and dow are restricted, a day
  // matching either one fires; when only one is restricted, it must match.
  return {
    min, hour, dom, mon, dow,
    domStar: fields[2] === '*',
    dowStar: fields[4] === '*',
  }
}

/** Does a local-time breakdown match the parsed expression? */
function cronMatches(ast, d) {
  if (!ast.mon.has(d.getMonth() + 1)) return false
  if (!ast.min.has(d.getMinutes()) || !ast.hour.has(d.getHours())) return false
  const domOk = ast.dom.has(d.getDate())
  const dowOk = ast.dow.has(d.getDay())
  if (ast.domStar && ast.dowStar) return true
  if (ast.domStar) return dowOk
  if (ast.dowStar) return domOk
  return domOk || dowOk
}

/** First matching minute at or after `fromMs` (exclusive: the same ms never re-fires). */
function nextCron(ast, fromMs) {
  // Start at the next whole minute strictly after fromMs.
  let t = Math.floor(fromMs / 60000) * 60000 + 60000
  const limit = fromMs + CRON_LOOKAHEAD_DAYS * 86400000
  while (t <= limit) {
    const d = new Date(t)
    if (cronMatches(ast, d)) {
      // Zero seconds so runs land on the minute boundary the expression names.
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0).getTime()
    }
    t += 60000
  }
  return null
}

// ------------------------------------------------------------------ oracle

/**
 * The single scheduling oracle: when does this schedule fire next, strictly
 * after `fromMs`? `null` means "never again" (expired one-shot / unreachable
 * cron) — the engine then stops scheduling the job.
 *
 * @param {ReturnType<typeof normalizeSchedule>} schedule
 * @param {number} fromMs
 * @returns {number | null}
 */
export function nextAfter(schedule, fromMs) {
  if (schedule.kind === 'interval') {
    return fromMs + schedule.intervalSeconds * 1000
  }
  if (schedule.kind === 'cron') {
    return nextCron(schedule.ast, fromMs)
  }
  // One-shot: fire only if the moment is still ahead.
  return schedule.runAt > fromMs ? schedule.runAt : null
}

/** Human-readable schedule for cards, tools and logs. */
export function describeSchedule(schedule) {
  if (schedule.kind === 'interval') {
    const s = schedule.intervalSeconds
    if (s % 86400 === 0) return `every ${s / 86400}d`
    if (s % 3600 === 0) return `every ${s / 3600}h`
    if (s % 60 === 0) return `every ${s / 60}min`
    return `every ${s}s`
  }
  if (schedule.kind === 'cron') return `cron ${schedule.cron}`
  return `once ${new Date(schedule.runAt).toISOString()}`
}
