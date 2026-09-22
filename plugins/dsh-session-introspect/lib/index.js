/**
 * dsh-session-introspect — model-callable introspection of live sessions.
 *
 * The harness already hands plugins an event-sourced session store on
 * `ctx.sessions`, but nothing exposes it to the MODEL. This plugin registers
 * exactly one tool, `session_introspect`, with five operations over the
 * sessions live in this process.
 *
 * Three deliberate choices, each with a reason:
 *
 *  - **One tool, five operations.** Every tool schema sits in the request
 *    prefix, so an extra tool invalidates more prompt cache and gives the model
 *    another way to pick wrong. The operations share one argument shape, so
 *    they cost one tool block instead of five.
 *  - **The session API is reached through `ctx` at call time, never imported.**
 *    The harness starts all-or-nothing: a plugin that fails to load stops the
 *    whole process. Reading `ctx.sessions` lazily means a host without that
 *    service gets a clear tool error instead of a dead harness, and no peer
 *    range has to be guessed against a pre-stable package.
 *  - **Read-only.** This plugin appends no events and touches no files. It
 *    cannot change what the model sees on the next turn.
 *
 * @module dsh-session-introspect
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-session-introspect'
export const inject = ['tools']

/** The operations `session_introspect` accepts. */
export const OPS = ['self', 'list', 'events', 'surface', 'lineage']

/**
 * Deployment policy for the introspection tool.
 */
export const Config = Schema.object({
  /** Upper bound on events one `events` call may return. */
  maxEvents: Schema.number().default(50),
  /** Upper bound on sessions one `list` call may return. */
  maxSessions: Schema.number().default(50),
  /** Per-event text preview bound, in characters. */
  maxTextChars: Schema.number().default(300),
  /** Whether token-level `assistant/chunk` events are included by default. */
  includeChunks: Schema.boolean().default(false),
})

/** Fields reported for one session. Shared by `session` and `sessions`. */
const SESSION_FIELDS = {
  id: { type: 'string', required: true },
  cwd: { type: 'string' },
  createdAt: { type: 'integer', required: true },
  isSeeded: { type: 'boolean', required: true },
  origin: { type: 'string' },
  delegationDepth: { type: 'integer' },
  parentSession: { type: 'string' },
  agentPreset: { type: 'string' },
  eventCount: { type: 'integer', required: true },
  firstLiveSeq: { type: 'integer', required: true },
  inheritedEventCount: { type: 'integer', required: true },
  surfaceCount: { type: 'integer', required: true },
  messageCount: { type: 'integer', required: true },
  lastSeq: { type: 'integer' },
}

/** Fields reported for one event. */
const EVENT_FIELDS = {
  seq: { type: 'integer', required: true },
  type: { type: 'string', required: true },
  time: { type: 'integer', required: true },
  text: { type: 'string', required: true },
}

const DESCRIPTION = [
  'Read facts about sessions LIVE in this harness process. Read-only; appends nothing.',
  'Ops:',
  '`self` — the calling session: id, cwd, event/message/surface counts, fork lineage, delegation depth.',
  '`list` — every live session, newest first (includes subagents and sibling sessions).',
  '`events` — a bounded window of one session\'s event log; narrow with `fromSeq`/`toSeq` (inclusive) and `type`.',
  '`surface` — the event sequence numbers currently visible to the model, after any compaction.',
  '`lineage` — ancestors and descendants of a session.',
  'Only sessions live in THIS process are visible; sessions persisted by earlier runs are not.',
].join(' ')

/** Drop `undefined` keys so the canonical value matches the output schema exactly. */
function compact(record) {
  const out = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Bound one preview string to `maxChars`, flattening whitespace first. */
function truncate(text, maxChars) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars)}…`
}

/**
 * Flatten model-facing content blocks to plain text.
 *
 * ContentBlock is merge-extensible, so unknown block types fall through to
 * nothing rather than throwing. Blocks that carry `text` are preferred, which
 * covers both `text` and `reasoning` without naming them.
 * @param content - a content-block array, or anything else.
 * @returns the joined text.
 */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name}] ${block.arguments ?? ''}`)
    } else if (block.type === 'tool-result') {
      parts.push(blocksToText(block.content))
    } else if (block.type === 'image') {
      parts.push('[image]')
    } else if (typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.filter((part) => part.length > 0).join('\n')
}

/**
 * One-line account of an event, without its payload.
 * @param event - a session event.
 * @returns the account, empty for event types with nothing worth showing.
 */
function eventText(event) {
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'user/message':
      return blocksToText(data.content)
    case 'assistant/message':
      return blocksToText(data.message?.content)
    case 'tool/call':
      return `[${data.name}] ${data.arguments ?? ''}`
    case 'tool/result':
      return blocksToText(data.message?.content)
    case 'turn/start':
      return `turn ${data.turn} started`
    case 'turn/end':
      return `turn ${data.turn} ended: ${data.reason?.kind ?? 'unknown'}`
    case 'step/start':
      return `turn ${data.turn} step ${data.step} started`
    case 'step/end':
      return `turn ${data.turn} step ${data.step} ended`
    case 'request/header':
      return `request header (${data.reason ?? 'unknown'})`
    case 'request/context':
      return `${data.provider ?? '?'}/${data.model ?? '?'}`
    case 'session/end-seed':
      return 'end of fork/resume seed'
    case 'assistant/chunk':
      return 'stream chunk'
    default:
      return ''
  }
}

/** Summarize one live Session into the canonical record shape. */
function summarizeSession(session) {
  const header = session?.header ?? {}
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  let messageCount = 0
  try {
    messageCount = session?.deriveMessages?.().length ?? 0
  } catch {
    messageCount = 0
  }
  return compact({
    id: String(session?.id ?? ''),
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    createdAt: Number(header.createdAt ?? 0),
    isSeeded: header.isSeeded === true,
    origin: typeof header.origin === 'string' ? header.origin : undefined,
    delegationDepth:
      typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined,
    parentSession: header.parentSession === undefined ? undefined : String(header.parentSession),
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
    eventCount: events.length,
    firstLiveSeq: Number(session?.firstLiveSeq ?? 0),
    inheritedEventCount: Number(session?.inheritedEventCount ?? 0),
    surfaceCount: session?.surface?.nodes?.length ?? 0,
    messageCount,
    lastSeq: events.length > 0 ? Number(events[events.length - 1].seq) : undefined,
  })
}

/** Walk a session's fork ancestry and find its live descendants. */
function lineageOf(store, session) {
  const ancestors = []
  const seenUp = new Set([String(session.id)])
  let cursor = session
  while (cursor?.header?.parentSession !== undefined) {
    const parentId = String(cursor.header.parentSession)
    if (seenUp.has(parentId)) break
    seenUp.add(parentId)
    ancestors.push(parentId)
    cursor = store.get(parentId)
    if (!cursor) break
  }

  const childrenOf = new Map()
  for (const candidate of store.list()) {
    const parentId = candidate?.header?.parentSession
    if (parentId === undefined) continue
    const key = String(parentId)
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key).push(String(candidate.id))
  }

  const descendants = []
  const seenDown = new Set([String(session.id)])
  const queue = [...(childrenOf.get(String(session.id)) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seenDown.has(id)) continue
    seenDown.add(id)
    descendants.push(id)
    queue.push(...(childrenOf.get(id) ?? []))
  }

  return { ancestors, descendants }
}

/** Resolve the session store from the context, tolerating a host without one. */
function sessionsOf(ctx) {
  try {
    const store = ctx?.sessions
    if (store && typeof store.list === 'function' && typeof store.get === 'function') return store
  } catch {
    /* the service is not provided on this context */
  }
  try {
    const store = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined
    if (store && typeof store.list === 'function' && typeof store.get === 'function') return store
  } catch {
    /* ignore */
  }
  return undefined
}

/** Clamp a model-supplied integer into `[1, cap]`, falling back to `cap`. */
function bound(value, cap) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return cap
  return Math.min(Math.max(1, Math.trunc(value)), cap)
}

/** Render one session summary as a single line. */
function describeSession(summary) {
  const bits = [
    summary.id,
    `events=${summary.eventCount}`,
    `messages=${summary.messageCount}`,
    `surface=${summary.surfaceCount}`,
  ]
  if (summary.cwd) bits.push(`cwd=${summary.cwd}`)
  if (summary.origin) bits.push(`origin=${summary.origin}`)
  if (summary.delegationDepth !== undefined) bits.push(`depth=${summary.delegationDepth}`)
  if (summary.parentSession) bits.push(`parent=${summary.parentSession}`)
  if (summary.agentPreset) bits.push(`preset=${summary.agentPreset}`)
  if (summary.isSeeded) bits.push('seeded')
  return bits.join(' ')
}

/** Model-facing rendering of one canonical value. */
function renderResult(value) {
  const lines = []
  if (value.session) lines.push(`session: ${describeSession(value.session)}`)
  if (value.sessions) {
    lines.push(`${value.sessions.length} live session(s), newest first:`)
    for (const summary of value.sessions) lines.push(`  ${describeSession(summary)}`)
  }
  if (value.events) {
    lines.push(`${value.events.length} event(s):`)
    for (const event of value.events) {
      lines.push(`  [${event.seq}] ${event.type}${event.text ? `: ${event.text}` : ''}`)
    }
  }
  if (value.surface) {
    lines.push(`model-visible surface (${value.surface.length} node(s)): ${value.surface.join(', ')}`)
  }
  if (value.ancestors) {
    lines.push(`ancestors (nearest first): ${value.ancestors.join(', ') || '(none live)'}`)
  }
  if (value.descendants) {
    lines.push(`descendants: ${value.descendants.join(', ') || '(none live)'}`)
  }
  if (value.truncated) lines.push('(truncated to the configured bound)')
  return lines.join('\n')
}

/**
 * Register the `session_introspect` tool.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the deployment's bounds.
 */
export function apply(ctx, config) {
  const settings = {
    maxEvents: config?.maxEvents ?? 50,
    maxSessions: config?.maxSessions ?? 50,
    maxTextChars: config?.maxTextChars ?? 300,
    includeChunks: config?.includeChunks ?? false,
  }

  ctx.tools.register(
    defineTool({
      name: 'session_introspect',
      description: DESCRIPTION,
      parameters: {
        op: {
          type: 'string',
          required: true,
          enum: [...OPS],
          description:
            'self | list | events | surface | lineage. See the tool description for each.',
        },
        sessionId: {
          type: 'string',
          description:
            'Target a live session by id. Omit to use the calling session (which requires an owning agent).',
        },
        fromSeq: {
          type: 'integer',
          description: 'events: first sequence number to include, inclusive.',
        },
        toSeq: {
          type: 'integer',
          description: 'events: last sequence number to include, inclusive.',
        },
        type: {
          type: 'string',
          description: 'events: return only events of exactly this event type.',
        },
        limit: {
          type: 'integer',
          description:
            'Maximum entries to return. Cannot exceed the configured bound for the operation.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: [...OPS] },
            session: {
              type: 'object',
              additionalProperties: false,
              properties: SESSION_FIELDS,
            },
            sessions: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: SESSION_FIELDS },
            },
            events: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: EVENT_FIELDS },
            },
            surface: { type: 'array', items: { type: 'integer' } },
            ancestors: { type: 'array', items: { type: 'string' } },
            descendants: { type: 'array', items: { type: 'string' } },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const store = sessionsOf(ctx)
        if (!store) {
          throw new Error(
            'session_introspect: this deployment provides no session store on ctx.sessions',
          )
        }

        const self = exec?.agent?.session
        const resolveTarget = () => {
          if (args.sessionId === undefined) {
            if (!self) {
              throw new Error(
                'session_introspect: this call has no owning agent session; pass `sessionId` to name one',
              )
            }
            return self
          }
          const found = store.get(args.sessionId)
          if (!found) {
            throw new Error(
              `session_introspect: no live session "${args.sessionId}" in this process; only live sessions can be introspected`,
            )
          }
          return found
        }

        switch (args.op) {
          case 'self':
            return { op: args.op, session: summarizeSession(resolveTarget()) }

          case 'list': {
            const limit = bound(args.limit, settings.maxSessions)
            const all = store
              .list()
              .map(summarizeSession)
              .sort((a, b) => b.createdAt - a.createdAt)
            return {
              op: args.op,
              sessions: all.slice(0, limit),
              truncated: all.length > limit,
            }
          }

          case 'events': {
            const target = resolveTarget()
            const limit = bound(args.limit, settings.maxEvents)
            const all = target.snapshotEvents()
            let from
            let to
            if (args.fromSeq === undefined && args.toSeq === undefined) {
              from = Math.max(0, all.length - limit)
              to = all.length
            } else {
              from = Math.max(0, args.fromSeq ?? 0)
              to =
                args.toSeq === undefined
                  ? Math.min(all.length, from + limit)
                  : Math.min(all.length, args.toSeq + 1)
            }
            const window = to > from ? all.slice(from, to) : []
            const keep =
              args.type === undefined
                ? (event) => settings.includeChunks || event.type !== 'assistant/chunk'
                : (event) => event.type === args.type
            const matched = window.filter(keep)
            return {
              op: args.op,
              session: summarizeSession(target),
              events: matched.slice(0, limit).map((event) => ({
                seq: Number(event.seq),
                type: String(event.type),
                time: Number(event.time ?? 0),
                text: truncate(eventText(event), settings.maxTextChars),
              })),
              truncated: matched.length > limit,
            }
          }

          case 'surface': {
            const target = resolveTarget()
            const limit = bound(args.limit, settings.maxEvents)
            const nodes = [...(target.surface?.nodes ?? [])]
            return {
              op: args.op,
              session: summarizeSession(target),
              surface: nodes.slice(-limit).map(Number),
              truncated: nodes.length > limit,
            }
          }

          case 'lineage': {
            const target = resolveTarget()
            const { ancestors, descendants } = lineageOf(store, target)
            return {
              op: args.op,
              session: summarizeSession(target),
              ancestors,
              descendants,
            }
          }

          default:
            throw new Error(
              `session_introspect: unknown op "${args.op}"; expected one of ${OPS.join(', ')}`,
            )
        }
      },
    }),
  )
}

export { renderResult }
