/**
 * dsh-skill-menu tests. Run with: node test/menu.test.mjs
 *
 * The browser half cannot execute under Node for real (the DSH module system
 * evaluates it as a classic script that only registers a factory), so this
 * suite stands in for the loader — a fake `window.__ModuleLoader__`, stub
 * modules, and a stub context — and checks what would otherwise fail only in
 * the browser: the bundle contract, locale parity, the early overlay
 * registration that wins the slash-menu cell, and the render-time
 * re-ordering that groups skills under package sections.
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
    useMemo: (fn, deps) => fn(deps),
    useRef: () => ({ current: null }),
    useSyncExternalStore: () => ({ open: false, groups: [] }),
  })
  const primitives = {
    StateDot: () => null,
    IconSkillOutline16: () => null,
    IconChevronRightOutline14: () => null,
    IconChevronDownOutline14: () => null,
    IconInspectOutline12: () => null,
    ReferenceIcon: () => null,
    useAnchoredMaxHeight: () => 320,
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
  assert.deepEqual(exposed.inject.sort(), ['locale', 'sessions', 'slots'])
})

await test('apply registers dictionaries with identical keys and only the overlay entry', async () => {
  const registrations = await loadClientBundle()
  const stubs = stubModules()
  const exposed = registrations[0].factory((id) => stubs[id])

  const seen = { locale: {}, slots: [] }
  const ctx = {
    effect(fn) { fn() },
    inject(names, cb) { cb(ctx); return () => {} },
    locale: {
      register(ns, dicts) { seen.locale[ns] = dicts },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject(seat, register) { seen.slots.push({ seat, register }) },
      register: (options, component) => ({ options, component }),
    },
    sessions: { scope: () => ctx },
    get: () => { throw new Error('render faces must resolve lazily, not at apply') },
  }
  exposed.apply(ctx)

  const dicts = seen.locale['skill-menu']
  assert.ok(dicts, 'dictionaries registered under the plugin namespace')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())

  assert.equal(seen.slots.length, 1)
  const { seat, register } = seen.slots[0]
  assert.equal(seat, 'conversation.input.overlay')
  const entry = register()
  assert.equal(entry.options.id, 'slash-menu', 'the stock cell id — first registration wins it')
  assert.equal(typeof entry.component, 'function')
  assert.equal(entry.options.inject.length, 1, 'faces resolve lazily per session')
})

await test('the lazy face wires the session controller verbs', async () => {
  const registrations = await loadClientBundle()
  const stubs = stubModules()
  const exposed = registrations[0].factory((id) => stubs[id])
  const calls = []
  const controller = {
    menu: { subscribe() {}, getSnapshot() { return { open: false, groups: [] } } },
    headers: { subscribe() {}, getSnapshot() { return new Map() } },
    pick: (...a) => calls.push(['pick', ...a]),
    pickCrumb: (...a) => calls.push(['pickCrumb', ...a]),
    hover: (...a) => calls.push(['hover', ...a]),
    dismiss: () => calls.push(['dismiss']),
  }
  const services = { inputTriggers: { sessionOf: () => controller } }
  const captured = []
  const ctx = {
    effect(fn) { fn() },
    inject(names, cb) { cb(ctx); return () => {} },
    locale: { register() {}, bind: (ns) => (key) => `${ns}:${key}` },
    slots: {
      inject(seat, register) { captured.push(register()) },
      register: (options, component) => ({ options, component }),
    },
    sessions: { scope: (id) => ({ id }) },
    get: (name) => services[name],
  }
  exposed.apply(ctx)
  const face = captured[0].options.inject('sess-1')
  assert.deepEqual(Object.keys(face).sort(), ['headers', 'menu', 'onCrumb', 'onDismiss', 'onHover', 'onPick'])
  face.onPick('skill', 3)
  face.onCrumb('skill', 1)
  face.onHover('skill', 2)
  face.onDismiss()
  assert.deepEqual(calls, [
    ['pick', 'skill', 3, undefined],
    ['pickCrumb', 'skill', 1],
    ['hover', 'skill', 2],
    ['dismiss'],
  ])
})

await test('attribution parses the prefix; sectioning groups packages first, local last', async () => {
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
  assert.deepEqual(rows.map((r) => r.pkg), ['watch-positions', 'watch-positions', 'genui', undefined])
  assert.deepEqual(rows.map((r) => r.originalIndex), [0, 2, 3, 1], 'original indices survive re-ordering')
  assert.deepEqual(rows.map((r) => r.item.name), ['watchlist', 'close-recap', 'genui', 'plain'])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
