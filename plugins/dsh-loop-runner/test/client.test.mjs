/**
 * Client artifact tests: the closure-factory file is evaluated against a fake
 * window/require, then apply() runs against fake locale/slots contexts — the
 * load check without booting the web client.
 * Run with: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${String(error.message).split('\n').slice(0, 5).join('\n       ')}`)
  }
}

const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

/** Minimal fake React: only createElement is used at factory scope. */
const fakeReact = { createElement: (...args) => ({ args }), Fragment: 'Fragment' }
const loaded = []

const window = {
  __ModuleLoader__: {
    load(entry) { loaded.push(entry) },
  },
}

// Evaluate the artifact exactly like the browser module system would.
const evaluate = new Function('window', 'require', `${source}\n`)
evaluate(window, (id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
})

console.log('dsh-loop-runner client tests\n')

check('artifact registers one module with the package id', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-loop-runner')
  assert.equal(typeof loaded[0].factory, 'function')
})

check('factory exports apply + inject for the client plugin shape', () => {
  const exports = loaded[0].factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

/** Run apply() against fake locale/slots; returns everything captured. */
function runApply() {
  const captured = { locales: [], slots: [], disposers: [] }
  const makeCtx = () => ({
    // Real ctx.effect invokes fn immediately and keeps its return as disposer.
    effect(fn) { const dispose = fn(); captured.disposers.push(dispose) },
    locale: {
      register(ns, dicts) { captured.locales.push({ ns, dicts }) },
      bind: (ns) => (key) => {
        captured.boundNs = ns
        const { dicts } = captured.locales[captured.locales.length - 1]
        const value = dicts.zh[key] ?? dicts.en[key]
        return value === undefined ? key : value
      },
    },
    slots: {
      inject(slotName, register) { captured.slots.push({ slotName, register }) },
      register(opts, component) { return { ...opts, component } },
    },
  })
  const exports = loaded[0].factory((id) => (id === 'react' ? fakeReact : null))
  exports.apply(makeCtx())
  return captured
}

check('apply registers the zh+en dictionary under the loop-runner namespace', () => {
  const captured = runApply()
  assert.equal(captured.locales.length, 1)
  assert.equal(captured.locales[0].ns, 'loop-runner')
  const { zh, en } = captured.locales[0].dicts
  assert.equal(zh['panel.label'], '定时任务')
  assert.equal(en['panel.label'], 'Scheduled jobs')
})

check('zh and en dictionaries cover the identical key set', () => {
  const { dicts } = runApply().locales[0]
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length >= 50, `expected a full dictionary, got ${zhKeys.length} keys`)
})

check('apply injects the sidebar row and the main panel cell', () => {
  const captured = runApply()
  assert.deepEqual(captured.slots.map((s) => s.slotName).sort(), ['main', 'sidebar.panellist'])
  const row = captured.slots.find((s) => s.slotName === 'sidebar.panellist').register()
  assert.equal(row.name, 'sidebar.panellist')
  assert.equal(row.id, 'loop-runner')
  assert.equal(typeof row.label, 'function')
  assert.equal(row.label(), '定时任务')
  const cell = captured.slots.find((s) => s.slotName === 'main').register()
  assert.equal(cell.name, 'main')
  assert.equal(cell.key, 'loop-runner')
  assert.equal(cell.locale, 'loop-runner')
  assert.equal(typeof cell.inject, 'function')
  const face = cell.inject()
  for (const method of ['health', 'overview', 'job', 'escalations', 'action']) {
    assert.equal(typeof face.api[method], 'function', `api.${method}`)
  }
})

check('api face targets the plugin route base with the right methods', () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => { calls.push({ input: String(input), init }); return new Promise(() => {}) }
  try {
    const face = runApply().slots.find((s) => s.slotName === 'main').register().inject()
    face.api.job('my job', 5)
    face.api.action('j1', 'pause', { reason: 'x' })
    assert.equal(calls[0].input, '/api/dsh-loop-runner/job?id=my%20job&limit=5')
    assert.equal(calls[1].input, '/api/dsh-loop-runner/job/pause?id=j1')
    assert.equal(calls[1].init.method, 'POST')
    assert.equal(calls[1].init.body, JSON.stringify({ reason: 'x' }))
  } finally {
    globalThis.fetch = originalFetch
  }
})

check('no literal colours: styles reference --dsw-* tokens only', () => {
  const literal = /"(?:#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\()/.exec(source)
  assert.equal(literal, null, `literal colour found: ${literal && literal[0]}`)
  const tokenCount = (source.match(/--dsw-alias-/g) || []).length
  assert.ok(tokenCount >= 20, `expected semantic tokens, got ${tokenCount}`)
})

console.log(failed === 0 ? '\nclient: all passed' : `\nclient: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
