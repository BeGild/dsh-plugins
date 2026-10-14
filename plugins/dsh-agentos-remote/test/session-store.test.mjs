/**
 * dsh-agentos-remote session-store tests — run with: node test/session-store.test.mjs
 *
 * Hermetic: builds a fake ~/.dsh/sessions tree with real zstd-compressed v4
 * logs (node:zlib) and pins the DSH-row → ACP-update conversion — the mapping
 * that makes thoughts, tool calls and history render identically live and
 * replayed.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  dshEventsToAcpUpdates,
  dshSessionHistory,
  findDshSessionFile,
  listDshSessions,
} from '../lib/session-store.js'

let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message.split('\n').slice(0, 4).join('\n       ')}`)
  }
}

function withTempSessions(build) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-store-'))
  const previous = os.homedir
  os.homedir = () => home
  try {
    build(path.join(home, '.dsh', 'sessions'))
  } finally {
    os.homedir = previous
    rmSync(home, { recursive: true, force: true })
  }
}

function writeSession(root, workspace, sessionId, rows, fileName = 'session.v4.jsonl.zstd') {
  const dir = path.join(root, workspace, sessionId)
  mkdirSync(dir, { recursive: true })
  const lines = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  writeFileSync(path.join(dir, fileName), zstdCompressSync(Buffer.from(lines, 'utf8')))
}

console.log('dsh-agentos-remote session-store tests\n')

await check('listDshSessions and findDshSessionFile resolve the real layout', () => {
  withTempSessions((root) => {
    writeSession(root, '--E-work-x--', 'sess-1', [{ type: 'session', id: 'sess-1', cwd: 'E:\\work\\x' }])
    const sessions = listDshSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, 'sess-1')
    assert.ok(findDshSessionFile('sess-1').includes('sess-1'))
    assert.equal(findDshSessionFile('missing'), null)
  })
})

await check('assistant chunk deltas and final messages do not duplicate streamed text', () => {
  const updates = dshEventsToAcpUpdates([
    { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hel' } } },
    { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } } },
    { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'thinking' } } },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: { id: 'assistant-1', content: [
      { type: 'thinking', thinking: 'thinking' }, { type: 'text', text: 'hello' },
    ] } } },
  ], { streamed: new Map() });
  assert.deepEqual(updates.map((update) => update.sessionUpdate), [
    'agent_message_chunk', 'agent_message_chunk', 'agent_thought_chunk',
  ]);
  assert.deepEqual(updates.map((update) => update.content.text), ['hel', 'lo', 'thinking']);
  assert.deepEqual(updates.map((update) => update._meta['codebuddy.ai'].chunkSeq), [0, 1, 0]);
});

await check('packed chunk storage rows decode to replayable events', () => {
  // The exact on-disk packed shape (one row for a run of three deltas), written
  // literally rather than produced by an encoder, so this pins the storage
  // format the decoder must accept.
  const packed = [{
    type: 'text-chunks',
    seq0: 0,
    time0: 10,
    data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['t0', 't1', 't2'] },
  }];
  withTempSessions((root) => {
    writeSession(root, '--work--', 'packed-session', [
      { type: 'session', id: 'packed-session', cwd: '/work' },
      ...packed,
    ]);
    const history = dshSessionHistory('packed-session');
    assert.deepEqual(history.events.map((event) => event.type), ['assistant/chunk', 'assistant/chunk', 'assistant/chunk']);
    assert.deepEqual(history.events.map((event) => event.seq), [0, 1, 2]);
    assert.deepEqual(history.events.map((event) => event.time), [10, 11, 12]);
    assert.deepEqual(history.updates.map((update) => update.content.text), ['t0', 't1', 't2']);
  });
});

await check('a corrupt packed row throws instead of silently dropping the run', () => {
  withTempSessions((root) => {
    writeSession(root, '--work--', 'corrupt-session', [
      { type: 'session', id: 'corrupt-session', cwd: '/work' },
      { type: 'text-chunks', seq0: 0, time0: 10, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['a', 'b'] } },
    ]);
    assert.throws(() => dshSessionHistory('corrupt-session'), /invalid DSH session storage record/);
  });
});

await check('a multi-frame log reads back whole, not just its header', () => {
  // DSH appends one zstd frame per durability flush. Node decodes only the
  // FIRST frame (both `zstdDecompressSync` and `createZstdDecompress`), so a
  // 43 KB log holding 25 rows used to read back as its 230-byte header alone —
  // which is why history replay was empty and cold sessions had no title.
  const frames = [
    [{ type: 'session', id: 'multi', cwd: '/work' }],
    [{ seq: 0, type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first' }] } }],
    [
      { seq: 1, type: 'session/title', data: { title: '真实标题' } },
      { seq: 2, type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'text', text: 'reply' }] } } },
    ],
  ]
  withTempSessions((root) => {
    const dir = path.join(root, '--work--', 'multi')
    mkdirSync(dir, { recursive: true })
    const buffer = Buffer.concat(frames.map((rows) => zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8'))))
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), buffer)
    const history = dshSessionHistory('multi')
    assert.equal(history.title, '真实标题', 'the title row lives in a later frame')
    assert.deepEqual(history.events.map((event) => event.type), ['user/message', 'assistant/message'])
    assert.deepEqual(history.updates.map((update) => update.content.text), ['first', 'reply'])
  })
})

await check('user and assistant rows become message chunks; thinking becomes a thought chunk', () => {
  const updates = dshEventsToAcpUpdates([
    { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    {
      type: 'assistant/message',
      data: {
        message: {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me think' },
            { type: 'text', text: 'the answer' },
            { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' },
          ],
        },
      },
    },
  ])
  assert.deepEqual(updates.map((u) => u.sessionUpdate), ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk'])
  assert.equal(updates[1].content.text, 'let me think')
  assert.equal(updates[2].content.text, 'the answer', 'embedded tool-call blocks are skipped; tool/call rows carry them')
})

await check('framework context injected as user messages never reaches the app', () => {
  // The host injects the runtime-context snapshot, the workspace instructions
  // and the skill catalog as user-role messages, each tagged with its own
  // `source.kind`. They must not be forwarded: the phone renders a user message
  // as an ordinary bubble, so framework text would read as the user's own words
  // (verified on the device — a long user message and the runtime-context
  // snapshot render identically). WorkBuddy's own client hides them too.
  const injected = [
    { type: 'user/message', data: { id: 'c1', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }], source: { kind: 'runtime-context', form: 'snapshot' } } },
    { type: 'user/message', data: { id: 'c2', content: [{ type: 'text', text: '<system-reminder>\nworkspace instructions\n</system-reminder>' }], source: { kind: 'agent-instructions', form: 'instructions' } } },
    { type: 'user/message', data: { id: 'c3', content: [{ type: 'text', text: '<system-reminder>\nskill catalog\n</system-reminder>' }], source: { kind: 'skill-catalog', form: 'catalog' } } },
    { type: 'user/message', data: { id: 'c4', content: [{ type: 'text', text: 'goal directive' }], source: { kind: 'goal' } } },
  ]
  assert.deepEqual(dshEventsToAcpUpdates(injected), [])

  const real = dshEventsToAcpUpdates([
    { type: 'user/message', data: { id: 'u1', content: [{ type: 'text', text: 'my question' }], source: { kind: 'user', rpcId: 'r1' } } },
    { type: 'user/message', data: { id: 'u2', content: [{ type: 'text', text: 'legacy row without source' }] } },
  ])
  assert.deepEqual(real.map((u) => u.content.text), ['my question', 'legacy row without source'])
})

await check('tool rows become a pending call and its completed update', () => {
  const updates = dshEventsToAcpUpdates([
    { type: 'tool/call', data: { callId: 'call_1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'call_1', content: [{ type: 'text', text: 'contents' }] } } },
  ])
  assert.equal(updates[0].sessionUpdate, 'tool_call')
  assert.equal(updates[0].status, 'pending')
  assert.deepEqual(updates[0].rawInput, { file_path: 'a.txt' }, 'JSON string arguments are parsed for the app renderer')
  assert.equal(updates[1].sessionUpdate, 'tool_call_update')
  assert.equal(updates[1].status, 'completed')
  assert.equal(updates[1].rawOutput, 'contents')
})

await check('assistant stream deltas and turn termination are projected into ACP updates', () => {
  const updates = dshEventsToAcpUpdates([
    { type: 'assistant/chunk', seq: 1, data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hel' } } },
    { type: 'assistant/chunk', seq: 2, data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } } },
    { type: 'turn/end', seq: 3, data: { turn: 2, reason: { kind: 'completed' } } },
  ], { streamed: new Map() });
  assert.deepEqual(updates.map((update) => update.sessionUpdate), [
    'agent_message_chunk', 'agent_message_chunk', 'session_end_turn',
  ]);
  assert.deepEqual(updates.slice(0, 2).map((update) => update.content.text), ['hel', 'lo']);
  assert.equal(updates[2].stopReason, 'end_turn');
});

await check('rows without an app rendering are dropped', () => {
  const updates = dshEventsToAcpUpdates([
    { type: 'turn/start' }, { type: 'step/end' }, { type: 'request/header' },
    { type: 'goal/change' }, { type: 'todo/write' },
  ])
  assert.deepEqual(updates, [])
})

await check('dshSessionHistory replays a compressed log with title and updates', () => {
  withTempSessions((root) => {
    writeSession(root, '--E-work-x--', 'sess-h', [
      { type: 'session', id: 'sess-h', cwd: 'E:\\work\\x', createdAt: 1 },
      { type: 'session/title', data: { title: '调研任务' } },
      { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }] } },
      { type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '答复' }] } } },
    ])
    const history = dshSessionHistory('sess-h')
    assert.equal(history.title, '调研任务')
    assert.deepEqual(history.events.map((event) => event.type), ['user/message', 'assistant/message'])
    assert.deepEqual(history.updates.map((u) => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk'])
    assert.ok(history.updates.every((u) => u._meta['codebuddy.ai'].isHistoryReplay === true))
    assert.equal(dshSessionHistory('nobody'), null)
  })
})

await check('every log name the harness has used is read, not just the newest', () => {
  // The name carries the row format, and a store that has been upgraded holds
  // several at once: 0.2.0 writes `session.v4.jsonl.zstd`, 0.1.5 wrote
  // `session.jsonl.zstd`. Reading only the newest name made a machine that had
  // just upgraded list placeholder titles and open every conversation empty,
  // even though the rows themselves parse fine under every one of these names.
  withTempSessions((root) => {
    const rows = [
      { type: 'session', id: 's', cwd: 'E:\\work\\x', createdAt: 1 },
      { type: 'session/title', data: { title: '旧格式也能读出标题' } },
      { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }] } },
      { type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '答复' }] } } },
    ]
    writeSession(root, '--E-work-x--', 'sess-v4', rows, 'session.v4.jsonl.zstd')
    writeSession(root, '--E-work-x--', 'sess-v3', rows, 'session.v3.jsonl.zstd')
    writeSession(root, '--E-work-x--', 'sess-plain', rows, 'session.jsonl.zstd')
    for (const id of ['sess-v4', 'sess-v3', 'sess-plain']) {
      assert.ok(findDshSessionFile(id), `${id} is not found`)
      const history = dshSessionHistory(id)
      assert.equal(history.title, '旧格式也能读出标题', `${id} lost its title`)
      assert.deepEqual(history.updates.map((u) => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk'], `${id} lost its history`)
    }
    assert.equal(listDshSessions().length, 3, 'the disk listing sees all three')
  })
})

console.log(failed === 0 ? '\nall session-store checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
