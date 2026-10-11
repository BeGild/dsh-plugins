/**
 * Loads lib/client.js the way the browser module system does: the script only
 * registers a factory, and the loader materializes it later. Checks the things
 * that would otherwise fail only in a browser — the bundle id, that it asks
 * for react, and that apply() registers the fold definition, the turn row, and
 * one row per built-in tool.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '../lib/client.js')

let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

async function loadBundle() {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load(registration) { registrations.push(registration) } } }
  await import(`${pathToFileURL(CLIENT).href}?t=${Date.now()}-${Math.random()}`)
  return registrations
}

function materialize(registration) {
  const requested = []
  const require = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return { useState: (value) => [value, () => {}] }
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    throw new Error(`bundle requested an unexpected module: ${specifier}`)
  }
  return { exports: registration.factory(require), requested }
}

const pkg = JSON.parse(readFileSync(path.join(HERE, '../package.json'), 'utf8'))

await check('the bundle id is the package name', async () => {
  const registrations = await loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, pkg.name)
})

await check('it asks for react and the two services it registers into', async () => {
  const [registration] = await loadBundle()
  const { exports, requested } = materialize(registration)
  assert.deepEqual([...new Set(requested)], ['react', 'react/jsx-runtime'])
  assert.deepEqual(exports.inject, ['slots', 'uiConversation'])
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

await check('apply registers the fold, the turn row, and every built-in tool', async () => {
  const [registration] = await loadBundle()
  const { exports } = materialize(registration)
  const definitions = []
  const slots = []
  const ctx = {
    effect() {},
    uiConversation: { events: { register(definition) { definitions.push(definition) } } },
    slots: {
      inject(_name, register) { slots.push(register()) },
      register(spec) { return spec },
    },
  }
  exports.apply(ctx)
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].kind, 'ekko-fold')
  const keys = slots.map((slot) => `${slot.name}:${slot.key}`)
  assert.ok(keys.includes('conversation.chat.node:turn-process'))
  for (const tool of ['read', 'bash', 'pwsh', 'grep', 'glob', 'write', 'edit', 'web_search', 'web_fetch', 'todo_write', 'read_image']) {
    assert.ok(keys.includes(`tool.call.toolview:${tool}`), `missing ${tool}`)
  }
  // Every registration shadows the built-in one: the keyed slot keeps the
  // lowest priority per key, and the built-ins register at the default 0.
  for (const slot of slots) {
    if (slot.name === 'settings.section') continue // list slot (id, no shadowing)
    assert.equal(slot.priority, -100, `${slot.name}:${slot.key ?? slot.id} must shadow at priority -100`)
  }
})

await check('the fold definition turns a turn\'s calls into its line', async () => {
  const [registration] = await loadBundle()
  const { exports } = materialize(registration)
  let definition
  exports.apply({
    effect() {},
    uiConversation: { events: { register(value) { definition = value } } },
    slots: { inject(_name, register) { register() }, register(spec) { return spec } },
  })
  const start = definition.start(null, { event: { type: 'turn/start', data: { turn: 3 } } })
  assert.equal(start.running, true)
  const read = definition.update(
    { state: start },
    { event: { type: 'tool/call', data: { turn: 3, callId: 'c1', name: 'read', arguments: '{"file_path":"docs/README.md"}' } } },
  )
  const published = definition.buildLocationData({ state: read }, 'turn', null)
  assert.equal(published.key, 'ekko-fold')
  assert.equal(published.value.line, '正在查看文件 docs/README.md')
  const ended = definition.update({ state: read }, { event: { type: 'turn/end', data: { turn: 3 } } })
  assert.equal(definition.buildLocationData({ state: ended }, 'turn', null).value.line, '查看文件 docs/README.md')
  assert.equal(definition.buildLocationData({ state: ended }, 'step', null), null)
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nclient: all passed')
