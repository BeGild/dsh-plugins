/**
 * dsh-persistent-repl tests — run with: node test/repl.test.mjs
 *
 * These spawn REAL child processes (that is the feature under test), so the run
 * takes a few seconds. Every check is bounded by an explicit timeout.
 */
import assert from 'node:assert/strict'
import { Config, apply, inject, name, renderResult } from '../lib/index.js'

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

console.log('dsh-persistent-repl tests\n')

// ---------------------------------------------------------------- module shape

await test('exports the cordis plugin surface', () => {
  assert.equal(name, 'dsh-persistent-repl')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'Config must be a Schemastery schema')
})

// ------------------------------------------------------------- registration

const registered = []
let disposer = null
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  effect: (factory) => {
    disposer = factory()
  },
  logger: { info() {}, warn() {} },
}

apply(ctx, { defaultTimeoutMs: 15_000, maxTimeoutMs: 30_000, maxOutputChars: 5_000 })

const def = registered[0]
const run = (code, extra = {}) => def.execute({ code, ...extra }, {})

await test('registers exactly one node_repl tool and an effect disposer', () => {
  assert.equal(registered.length, 1)
  assert.equal(def.name, 'node_repl')
  assert.equal(typeof disposer, 'function', 'the REPL child needs an explicit disposer')
})

// --------------------------------------------------------------- persistence

await test('returns the value of the final expression', async () => {
  const r = await run('1 + 1')
  assert.equal(r.ok, true)
  assert.equal(r.value, '2')
})

await test('`const` state persists across separate calls', async () => {
  const first = await run('const base = 40')
  assert.equal(first.ok, true)
  const second = await run('base + 2')
  assert.equal(second.ok, true)
  assert.equal(second.value, '42')
})

await test('`var` and function declarations persist', async () => {
  await run('var counter = 0')
  await run('function bump() { counter += 1; return counter }')
  const r = await run('bump(); bump(); bump()')
  assert.equal(r.ok, true)
  assert.equal(r.value, '3')
})

await test('state survives in objects and arrays across calls', async () => {
  await run('const items = [1, 2, 3]')
  await run('items.push(4)')
  const r = await run('items.length')
  assert.equal(r.value, '4')
})

// ------------------------------------------------------------------ capture

await test('captures console.log output', async () => {
  const r = await run('console.log("hello", 123); "done"')
  assert.equal(r.ok, true)
  assert.deepEqual(r.logs, ['hello 123'])
  assert.equal(r.value, "'done'")
})

await test('captures process.stdout.write too', async () => {
  const r = await run('process.stdout.write("raw output")')
  assert.equal(r.ok, true)
  assert.deepEqual(r.logs, ['raw output'])
})

// ------------------------------------------------------------------- errors

await test('a thrown error comes back as ok:false with the message', async () => {
  const r = await run('throw new Error("boom")')
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
})

await test('a syntax error is reported, and the REPL stays usable', async () => {
  const bad = await run('const = = =')
  assert.equal(bad.ok, false)
  const good = await run('"still alive"')
  assert.equal(good.ok, true)
  assert.equal(good.value, "'still alive'")
})

// ----------------------------------------------------------------- async

await test('supports top-level await', async () => {
  const r = await run('const v = await Promise.resolve(7); v * 6')
  assert.equal(r.ok, true)
  assert.equal(r.value, '42')
})

await test('top-level await works across several un-semicoloned lines', async () => {
  const r = await run(
    ['const a = await Promise.resolve(2)', 'const b = await Promise.resolve(3)', 'a * b'].join('\n'),
  )
  assert.equal(r.ok, true)
  assert.equal(r.value, '6')
})

await test('top-level await with a multi-line expression is not mis-split', async () => {
  const r = await run(['const total = 1 +', '  2 +', '  3', 'total'].join('\n'))
  assert.equal(r.ok, true)
  assert.equal(r.value, '6')
})

// ------------------------------------------------------------------ reset

await test('reset discards all state', async () => {
  await run('const keepMe = 1')
  const reset = await run('"ignored"', { reset: true })
  assert.equal(reset.ok, true)
  const after = await run('typeof keepMe')
  assert.equal(after.value, "'undefined'")
})

// ---------------------------------------------------------------- timeouts

await test('a synchronous infinite loop is stopped by the vm timeout', async () => {
  const r = await run('while (true) {}', { timeout_ms: 1_000 })
  assert.equal(r.ok, false, 'expected the runaway loop to be stopped')
})

await test('an async hang is killed by the parent and the host restarts', async () => {
  await assert.rejects(
    () => run('await new Promise(() => {})', { timeout_ms: 1_000 }),
    /exceeded|restarted/,
  )
  // The host must have been replaced, so the next call works from a clean process.
  const after = await run('"recovered"')
  assert.equal(after.ok, true)
  assert.equal(after.value, "'recovered'")
})

await test('rejects a timeout_ms above the configured maximum', async () => {
  await assert.rejects(() => run('1', { timeout_ms: 999_999 }), /maxTimeoutMs/)
})

// ------------------------------------------------------------------ render

await test('renders logs and value for the model', () => {
  assert.equal(renderResult({ ok: true, value: '42', logs: ['hi'] }), 'hi\n42')
  assert.equal(renderResult({ ok: true, value: 'undefined', logs: [] }), '(no output)')
  assert.equal(renderResult({ ok: false, error: 'boom', logs: [] }), 'Error: boom')
})

// ----------------------------------------------------------------- teardown

if (typeof disposer === 'function') await disposer()
await new Promise((resolve) => setTimeout(resolve, 300))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const { label, error } of failures) console.error(`\n--- ${label} ---\n${error.stack}`)
  process.exit(1)
}
