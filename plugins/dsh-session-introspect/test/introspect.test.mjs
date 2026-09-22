/**
 * dsh-session-introspect tests — run with: node test/introspect.test.mjs
 *
 * The plugin reads a live session store, so the tests build one: a fake
 * Session with the documented shape (header / snapshotEvents / deriveMessages
 * / surface) and a fake store with get/list. Nothing here touches the real
 * harness, and no test spawns a process.
 */
import assert from 'node:assert/strict'
import { Config, OPS, apply, inject, name, renderResult } from '../lib/index.js'

let passed = 0
let failed = 0
const failures = []

async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    failures.push({ label, error })
    console.log(`  FAIL ${label}\n       ${error.message.split('\n')[0]}`)
  }
}

console.log('dsh-session-introspect tests\n')

// ------------------------------------------------------------------- fixtures

const EVENTS = [
  { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 1,
    time: 20,
    data: { content: [{ type: 'text', text: 'please summarise the repo' }] },
  },
  {
    type: 'assistant/chunk',
    seq: 2,
    time: 30,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'wo' } },
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: 40,
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'text', text: 'a deliberately long assistant answer used to prove truncation' },
        ],
      },
    },
  },
  {
    type: 'tool/call',
    seq: 4,
    time: 50,
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
  },
  {
    type: 'tool/result',
    seq: 5,
    time: 60,
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            content: [{ type: 'text', text: 'README.md' }],
          },
        ],
      },
    },
  },
  { type: 'turn/end', seq: 6, time: 70, data: { turn: 1, reason: { kind: 'completed' } } },
]

function makeSession({ id, createdAt = 0, events = EVENTS, header = {}, messages = [] }) {
  return {
    id,
    header: { version: 0, id, createdAt, isSeeded: false, ...header },
    inheritedEventCount: 0,
    firstLiveSeq: 0,
    surface: { nodes: events.map((event) => event.seq), replaceGeneration: 0 },
    snapshotEvents: () => events,
    deriveMessages: () => messages,
  }
}

function makeStore(sessions) {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return { list: () => [...sessions], get: (id) => byId.get(id) }
}

/** Build a plugin instance against a fresh context and return its tool. */
function mount(sessions, config) {
  const registered = []
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    sessions: makeStore(sessions),
  }
  apply(ctx, config)
  return { ctx, registered, def: registered[0] }
}

const ROOT = makeSession({ id: 'root', createdAt: 1_000, header: { cwd: 'C:\\repo' } })
const CHILD = makeSession({
  id: 'child',
  createdAt: 2_000,
  events: [{ type: 'turn/start', seq: 0, time: 5, data: { turn: 1 } }],
  header: { parentSession: 'root', origin: 'subagent', delegationDepth: 1 },
})
const GRANDCHILD = makeSession({
  id: 'grandchild',
  createdAt: 3_000,
  events: [],
  header: { parentSession: 'child', origin: 'subagent', delegationDepth: 2 },
})

const MAIN = { maxEvents: 50, maxSessions: 2, maxTextChars: 20, includeChunks: false }
const WIDE = { maxEvents: 50, maxSessions: 50, maxTextChars: 400, includeChunks: true }

const run = (def, args, agent) => def.execute(args, agent === undefined ? {} : { agent })

// -------------------------------------------------------------- module shape

await test('exports the cordis plugin surface', () => {
  assert.equal(name, 'dsh-session-introspect')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'Config must be a Schemastery schema')
  assert.deepEqual(OPS, ['self', 'list', 'events', 'surface', 'lineage'])
})

// ------------------------------------------------------------- registration

await test('registers exactly one tool, named session_introspect', () => {
  const { registered, def } = mount([ROOT], MAIN)
  assert.equal(registered.length, 1)
  assert.equal(def.name, 'session_introspect')
  assert.equal(typeof def.execute, 'function')
  assert.equal(def.isConcurrencySafe({ op: 'self' }), true)
})

// ------------------------------------------------------------------- self

await test('self reports the calling session', async () => {
  const { def } = mount([ROOT, CHILD], MAIN)
  const value = await run(def, { op: 'self' }, { session: ROOT })
  assert.equal(value.op, 'self')
  assert.equal(value.session.id, 'root')
  assert.equal(value.session.cwd, 'C:\\repo')
  assert.equal(value.session.eventCount, EVENTS.length)
  assert.equal(value.session.surfaceCount, EVENTS.length)
  assert.equal(value.session.lastSeq, 6)
  assert.equal(value.session.isSeeded, false)
})

await test('self without an owning agent fails loudly', async () => {
  const { def } = mount([ROOT], MAIN)
  await assert.rejects(() => run(def, { op: 'self' }, undefined), /no owning agent session/)
})

await test('an unknown sessionId fails loudly', async () => {
  const { def } = mount([ROOT], MAIN)
  await assert.rejects(
    () => run(def, { op: 'self', sessionId: 'nope' }, { session: ROOT }),
    /no live session "nope"/,
  )
})

await test('a missing session store is reported, not thrown at load', async () => {
  const registered = []
  const ctx = { tools: { register: (definition) => registered.push(definition) } }
  apply(ctx, MAIN)
  await assert.rejects(
    () => run(registered[0], { op: 'self' }, { session: ROOT }),
    /no session store on ctx.sessions/,
  )
})

// ------------------------------------------------------------------- list

await test('list returns live sessions newest first', async () => {
  const { def } = mount([ROOT, CHILD, GRANDCHILD], WIDE)
  const value = await run(def, { op: 'list' }, { session: ROOT })
  assert.deepEqual(
    value.sessions.map((session) => session.id),
    ['grandchild', 'child', 'root'],
  )
  assert.equal(value.truncated, false)
})

await test('list honours maxSessions and reports truncation', async () => {
  const { def } = mount([ROOT, CHILD, GRANDCHILD], MAIN)
  const value = await run(def, { op: 'list' }, { session: ROOT })
  assert.equal(value.sessions.length, 2)
  assert.equal(value.truncated, true)
})

await test('a requested limit cannot raise the configured bound', async () => {
  const { def } = mount([ROOT, CHILD, GRANDCHILD], MAIN)
  const value = await run(def, { op: 'list', limit: 99 }, { session: ROOT })
  assert.equal(value.sessions.length, 2)
})

// ----------------------------------------------------------------- events

await test('events returns the tail of the log by default', async () => {
  const { def } = mount([ROOT], WIDE)
  const value = await run(def, { op: 'events', limit: 3 }, { session: ROOT })
  assert.deepEqual(
    value.events.map((event) => event.seq),
    [4, 5, 6],
  )
  assert.equal(value.events[2].text, 'turn 1 ended: completed')
  assert.equal(value.session.id, 'root')
})

await test('events hides assistant/chunk unless includeChunks is set', async () => {
  const hidden = mount([ROOT], MAIN)
  const withoutChunks = await run(hidden.def, { op: 'events', fromSeq: 0, toSeq: 6 }, { session: ROOT })
  assert.equal(
    withoutChunks.events.some((event) => event.type === 'assistant/chunk'),
    false,
  )

  const shown = mount([ROOT], WIDE)
  const withChunks = await run(shown.def, { op: 'events', fromSeq: 0, toSeq: 6 }, { session: ROOT })
  assert.equal(
    withChunks.events.some((event) => event.type === 'assistant/chunk'),
    true,
  )
})

await test('events honours the type filter', async () => {
  const { def } = mount([ROOT], WIDE)
  const value = await run(def, { op: 'events', type: 'tool/call' }, { session: ROOT })
  assert.equal(value.events.length, 1)
  assert.equal(value.events[0].text, '[bash] {"command":"ls"}')
})

await test('events honours an inclusive fromSeq/toSeq window', async () => {
  const { def } = mount([ROOT], MAIN)
  const value = await run(def, { op: 'events', fromSeq: 1, toSeq: 3 }, { session: ROOT })
  assert.deepEqual(
    value.events.map((event) => event.seq),
    [1, 3],
    'seq 2 is the hidden chunk',
  )
})

await test('events truncates a long preview to maxTextChars', async () => {
  const { def } = mount([ROOT], MAIN)
  const value = await run(def, { op: 'events', type: 'assistant/message' }, { session: ROOT })
  assert.equal(value.events.length, 1)
  assert.equal(value.events[0].text.length, 21, '20 characters plus the ellipsis')
  assert.match(value.events[0].text, /…$/)
})

await test('events reports truncation when the bound clips the window', async () => {
  const { def } = mount([ROOT], MAIN)
  const value = await run(def, { op: 'events', fromSeq: 0, toSeq: 6, limit: 2 }, { session: ROOT })
  assert.equal(value.events.length, 2)
  assert.equal(value.truncated, true)
})

await test('events on a session with no events returns an empty list', async () => {
  const { def } = mount([ROOT, GRANDCHILD], WIDE)
  const value = await run(def, { op: 'events', sessionId: 'grandchild' }, { session: ROOT })
  assert.deepEqual(value.events, [])
  assert.equal(value.session.eventCount, 0)
  assert.equal(value.session.lastSeq, undefined)
})

// ---------------------------------------------------------------- surface

await test('surface returns the model-visible nodes', async () => {
  const { def } = mount([ROOT], WIDE)
  const value = await run(def, { op: 'surface' }, { session: ROOT })
  assert.deepEqual(value.surface, [0, 1, 2, 3, 4, 5, 6])
  assert.equal(value.truncated, false)
})

await test('surface keeps only the newest nodes when clipped', async () => {
  const { def } = mount([ROOT], MAIN)
  const value = await run(def, { op: 'surface', limit: 2 }, { session: ROOT })
  assert.deepEqual(value.surface, [5, 6])
  assert.equal(value.truncated, true)
})

// ---------------------------------------------------------------- lineage

await test('lineage walks ancestors and descendants', async () => {
  const { def } = mount([ROOT, CHILD, GRANDCHILD], WIDE)
  const value = await run(def, { op: 'lineage', sessionId: 'child' }, { session: ROOT })
  assert.deepEqual(value.ancestors, ['root'])
  assert.deepEqual(value.descendants, ['grandchild'])
  assert.equal(value.session.id, 'child')
  assert.equal(value.session.origin, 'subagent')
  assert.equal(value.session.delegationDepth, 1)
})

await test('lineage on a detached session reports no relatives', async () => {
  const { def } = mount([ROOT], WIDE)
  const value = await run(def, { op: 'lineage' }, { session: ROOT })
  assert.deepEqual(value.ancestors, [])
  assert.deepEqual(value.descendants, [])
})

await test('lineage stops at an ancestor that is not live', async () => {
  const orphan = makeSession({ id: 'orphan', createdAt: 9_000, header: { parentSession: 'gone' } })
  const { def } = mount([orphan], WIDE)
  const value = await run(def, { op: 'lineage', sessionId: 'orphan' }, { session: ROOT })
  assert.deepEqual(value.ancestors, ['gone'])
})

// ----------------------------------------------------------------- schema

await test('every op returns only keys its output schema declares', async () => {
  const declared = new Set(['op', 'session', 'sessions', 'events', 'surface', 'ancestors', 'descendants', 'truncated'])
  const { def } = mount([ROOT, CHILD], WIDE)
  for (const op of OPS) {
    const value = await run(def, { op, sessionId: 'child' }, { session: ROOT })
    for (const key of Object.keys(value)) {
      assert.ok(declared.has(key), `op ${op} returned undeclared key ${key}`)
    }
    assert.equal(value.op, op)
  }
})

await test('a session summary never carries an undefined-valued key', async () => {
  const { def } = mount([ROOT], WIDE)
  const value = await run(def, { op: 'self' }, { session: ROOT })
  for (const [key, entry] of Object.entries(value.session)) {
    assert.notEqual(entry, undefined, `session.${key} is undefined`)
  }
})

// ----------------------------------------------------------------- render

await test('renderResult renders a session line', () => {
  const text = renderResult({
    op: 'self',
    session: { id: 'root', eventCount: 7, messageCount: 0, surfaceCount: 7, isSeeded: false, createdAt: 0, cwd: 'C:\\repo' },
  })
  assert.match(text, /session: root events=7/)
  assert.match(text, /cwd=C:\\repo/)
})

await test('renderResult renders events, lineage and truncation', () => {
  const text = renderResult({
    op: 'events',
    events: [{ seq: 4, type: 'tool/call', time: 0, text: '[bash] ls' }],
    ancestors: ['root'],
    descendants: [],
    truncated: true,
  })
  assert.match(text, /\[4\] tool\/call: \[bash\] ls/)
  assert.match(text, /ancestors \(nearest first\): root/)
  assert.match(text, /descendants: \(none live\)/)
  assert.match(text, /truncated to the configured bound/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const { label, error } of failures) console.error(`\n--- ${label} ---\n${error.stack}`)
  process.exit(1)
}
