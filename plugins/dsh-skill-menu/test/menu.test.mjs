/**
 * dsh-skill-menu tests. Run with: node test/menu.test.mjs
 *
 * The browser half cannot execute under Node for real (the DSH module system
 * evaluates it as a classic script that only registers a factory), so this
 * suite stands in for the loader — a fake `window.__ModuleLoader__`, stub
 * modules, and a stub context — and checks what would otherwise fail only in
 * the browser: the bundle contract, locale parity, slot and source
 * registration, and the sectioning the '/' menu renders.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let passed = 0
let failed = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}\n       ${error.message.split('\n')[0]}`)
  }
}

/** Load lib/client.js the way the browser loader does: register the factory. */
async function loadClientBundle() {
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) { registrations.push(registration) },
    },
  }
  try {
    await import(`file://${join(ROOT, 'lib', 'client.js').replace(/\\/g, '/')}?t=${Date.now()}`)
  } finally {
    delete globalThis.window
  }
  return registrations
}

/** Stub module table: react plus the declared external, nothing else. */
function stubModules() {
  const h = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } })
  const react = Object.assign(h, {
    Fragment: 'fragment',
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  })
  const primitives = {
    StateDot: () => null,
    IconSkillOutline16: () => null,
    IconChevronDownOutline14: () => null,
    IconInspectOutline12: () => null,
    rankByName: (skills) => skills,
  }
  return { react, '@deepseek-ai/dsh-client-ui-primitives': primitives }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

console.log('dsh-skill-menu tests\n')

await test('the bundle registers one factory under the package name, as a classic script', async () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-primitives'))
  const registrations = await loadClientBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, pkg.name)
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:import|export)\s[^\s*]/)
})

await test('materializing requests only the declared modules', async () => {
  const registrations = await loadClientBundle()
  const required = []
  const stubs = stubModules()
  const exposed = registrations[0].factory((id) => {
    required.push(id)
    const mod = stubs[id]
    if (!mod) throw new Error(`unexpected require("${id}")`)
    return mod
  })
  assert.deepEqual(required.sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
  assert.deepEqual(exposed.inject.sort(), [
    'inputTriggers', 'locale', 'remote', 'remote.skills', 'sessions', 'slots',
  ])
})

await test('apply registers dictionaries with identical keys, the tool row, and the source', async () => {
  const registrations = await loadClientBundle()
  const stubs = stubModules()
  const exposed = registrations[0].factory((id) => stubs[id])

  const seen = { locale: {}, slots: [], sources: [] }
  const ctx = {
    effect(fn) { fn() },
    on() {},
    locale: {
      register(ns, dicts) { seen.locale[ns] = dicts },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject(seat, register) { seen.slots.push({ seat, register }) },
      register: (options, component) => ({ options, component }),
    },
    remote: { skills: { list: async () => ({ ok: true, value: { skills: [] } }) }, $on() {} },
    sessions: { subagentAddress: () => undefined },
    get: (name) => ({
      registerSource(source) {
        seen.sources.push(source)
        return () => {}
      },
    }),
  }
  exposed.apply(ctx)

  const dicts = seen.locale['skill-menu']
  assert.ok(dicts, 'dictionaries registered under the plugin namespace')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())

  const seats = seen.slots.map((entry) => entry.register())
  assert.deepEqual(seats.map((s) => s.options.key), ['skill'])

  assert.equal(seen.sources.length, 1)
  const source = seen.sources[0]
  assert.equal(source.trigger, '/')
  assert.equal(source.name, 'skill')
  assert.equal(typeof source.candidates, 'function')
  assert.equal(source.onPick({ candidate: { name: 'x' } }).text, '/x ')
})

await test('attribution parses the package prefix and sectioning groups local last', async () => {
  const registrations = await loadClientBundle()
  const stubs = stubModules()
  const mod = registrations[0].factory((id) => stubs[id])
  assert.deepEqual(mod.attributionOf({ description: '[watch-positions] Create lists.' }), {
    package: 'watch-positions',
    description: 'Create lists.',
  })
  assert.deepEqual(mod.attributionOf({ description: 'Plain local skill.' }), {
    package: null,
    description: 'Plain local skill.',
  })

  const ranked = [
    { name: 'watchlist', description: '[watch-positions] Watchlists.' },
    { name: 'plain', description: 'Plain.' },
    { name: 'close-recap', description: '[watch-positions] Recap.' },
    { name: 'genui', description: '[genui] GenUI.' },
  ]
  const rows = mod.sectioned(ranked, '本地技能')
  assert.deepEqual(rows.map((r) => r.section), [
    'watch-positions', 'watch-positions', 'genui', '本地技能',
  ])
  assert.deepEqual(rows.map((r) => r.skill.name), ['watchlist', 'close-recap', 'genui', 'plain'])
})

await test('candidates strip the prefix and carry their package section', async () => {
  const registrations = await loadClientBundle()
  const stubs = stubModules()
  const exposed = registrations[0].factory((id) => stubs[id])
  const source = { registered: null }
  const ctx = {
    effect(fn) { fn() },
    on() {},
    locale: { register() {}, bind: (ns) => (key) => (key === 'section.local' ? '本地技能' : `${ns}:${key}`) },
    slots: { inject() {}, register: () => ({}) },
    remote: {
      skills: {
        list: async () => ({
          ok: true,
          value: {
            skills: [
              { name: 'watchlist', description: '[watch-positions] Watchlists.', modelInvocable: true },
              { name: 'manual', description: 'Plain.', modelInvocable: false },
            ],
          },
        }),
      },
      $on() {},
    },
    sessions: { subagentAddress: () => undefined },
    get: () => ({ registerSource(s) { source.registered = s; return () => {} } }),
  }
  exposed.apply(ctx)
  const items = await source.registered.candidates({ sessionId: 's' }, { query: '', signal: new AbortController().signal })
  assert.deepEqual(items, [
    { name: 'watchlist', description: 'Watchlists.', section: 'watch-positions' },
    { name: 'manual', description: 'skill-menu:menu.userOnly · Plain.', section: '本地技能' },
  ])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
