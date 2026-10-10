/**
 * dsh-agentos-remote browser-half test — run with: node test/client.test.mjs
 *
 * The client half is the one artifact here that no Node import can execute for
 * real: the browser module system evaluates it as a classic <script> that only
 * REGISTERS a factory, and the loader rejects a bundle whose registered id is
 * not the package name. So this test stands in for that loader — a fake
 * `window.__ModuleLoader__`, a recording `require`, and a stub React — and
 * checks the three things that would otherwise fail only in a browser:
 *
 *   1. the bundle declares the id the manifest promises,
 *   2. it requests nothing but the baseline module table (no `dsh.client.external`),
 *   3. applying it registers the sidebar entry and the main panel it dispatches,
 *      with zh/en dictionaries that have identical key sets.
 *
 * It also pins the fetch paths to the routes lib/login-ui.js actually
 * registers, so the two halves cannot drift apart silently.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_FILE = path.join(ROOT, 'lib', 'client.js')
const HOST_UI_FILE = path.join(ROOT, 'lib', 'login-ui.js')

let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message.split('\n').slice(0, 6).join('\n       ')}`)
  }
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** Load lib/client.js the way the browser loader does: register, then materialize. */
async function loadBundle() {
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  await import(`file://${CLIENT_FILE.replace(/\\/g, '/')}?t=${Date.now()}`)
  return registrations
}

/** Stub React: enough of the surface the bundle touches, with inert hooks. */
function stubReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
  })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
}

/** Materialize the bundle with a require that records every specifier it asks for. */
function materialize(registration) {
  const requested = []
  const React = stubReact()
  const require = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return React
    throw new Error(`bundle requested a non-baseline module: ${specifier}`)
  }
  return { exports: registration.factory(require), requested }
}

/** A client ctx just real enough for apply(): it records what the plugin claims. */
function fakeClientCtx() {
  const dictionaries = new Map()
  const registrations = []
  const injected = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register(ns, dicts) {
        dictionaries.set(ns, dicts)
        return () => dictionaries.delete(ns)
      },
      // zh-first resolution: the assertions below read the Chinese copy.
      bind: (ns) => (key) => dictionaries.get(ns)?.zh?.[key] ?? dictionaries.get(ns)?.en?.[key] ?? key,
    },
    slots: {
      inject(slot, callback) {
        injected.push(slot)
        const dispose = callback()
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  return { ctx, dictionaries, registrations, injected, effects }
}

/** Resolve a function component the way React would, so trees expand in the walkers below. */
function resolve(node) {
  return typeof node?.type === 'function' ? node.type(node.props) : node
}

/** Collect every string in a rendered element tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node.type === 'function') return texts(resolve(node), out)
  return texts(node.props?.children, out)
}

/** Find the first element of a given type in a rendered tree. */
function find(node, type) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type)
      if (hit) return hit
    }
    return undefined
  }
  if (typeof node.type === 'function') return find(resolve(node), type)
  if (node.type === type) return node
  return find(node.props?.children, type)
}

console.log('dsh-agentos-remote browser-half tests\n')

const registrations = await loadBundle()

await check('the bundle registers exactly one factory, under the package name', () => {
  assert.equal(registrations.length, 1, 'one __ModuleLoader__.load call')
  assert.equal(
    registrations[0].id,
    pkg.name,
    'the loader rejects a bundle whose registered id is not the resolved package name',
  )
  assert.equal(typeof registrations[0].factory, 'function')
})

await check('the bundle is a classic script (no ESM syntax), as the loader requires', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m, 'defaultLoadBundle appends a classic <script>; import would throw')
  assert.doesNotMatch(source, /^\s*export\s/m, 'no ESM exports — the factory return value IS the module')
})

await check('manifest: dsh.client is declared and ./client points at a shipped file', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.exports?.['./client'], 'dsh.client requires a "./client" export')
  const rel = pkg.exports['./client']
  assert.ok(existsSync(path.join(ROOT, rel)), `${rel} must exist — the host fails activation loudly without it`)
  assert.ok(pkg.files.includes('lib'), 'the client bundle must ship in the published payload')
  assert.equal(path.relative(ROOT, CLIENT_FILE), path.normalize(rel).replace(/\\/g, path.sep))
})

await check('the factory asks only for baseline modules', () => {
  const { exports, requested } = materialize(registrations[0])
  assert.deepEqual(requested, ['react'], 'anything else would need a dsh.client.external declaration')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

await check('apply() claims the two slots that make the entry reachable', () => {
  const { exports } = materialize(registrations[0])
  const { ctx, injected, registrations: made } = fakeClientCtx()
  exports.apply(ctx)

  assert.deepEqual(injected, ['sidebar.panellist', 'main'], 'both are other packages\' seats: wait with inject()')

  const row = made.find((r) => r.options.name === 'sidebar.panellist')
  const panel = made.find((r) => r.options.name === 'main')
  assert.ok(row, 'the sidebar row is the entry point')
  assert.ok(panel, 'selecting a sidebar id with no main cell throws, so both must exist')

  assert.equal(row.options.id, 'agentos-remote')
  assert.equal(row.options.order, 100)
  assert.equal(typeof row.options.label, 'function', 'a thunk follows a live locale switch without re-registering')
  assert.equal(row.options.label(), 'WorkBuddy 远控')

  assert.equal(panel.options.key, row.options.id, 'the sidebar addresses the main cell by the row id')
  assert.equal(panel.options.locale, 'agentos-remote', 'the panel reads t from this namespace')
  assert.deepEqual(Object.keys(panel.options.inject()).sort(), ['api'], 'data reaches the component via inject')
})

await check('zh and en dictionaries carry identical key sets', () => {
  const { exports } = materialize(registrations[0])
  const { ctx, dictionaries } = fakeClientCtx()
  exports.apply(ctx)
  const dicts = dictionaries.get('agentos-remote')
  assert.ok(dicts, 'the namespace must be registered')
  assert.deepEqual(
    Object.keys(dicts.en).sort(),
    Object.keys(dicts.zh).sort(),
    'zh is the key-set source of truth; a missing en key is a user-visible hole',
  )
  for (const [key, value] of Object.entries(dicts.zh)) {
    assert.ok(String(value).trim().length > 0, `zh.${key} is empty`)
  }
  for (const [key, value] of Object.entries(dicts.en)) {
    assert.ok(String(value).trim().length > 0, `en.${key} is empty`)
  }
})

await check('the components render without a renderer (structure smoke test)', () => {
  const { exports } = materialize(registrations[0])
  const { ctx, registrations: made, dictionaries } = fakeClientCtx()
  exports.apply(ctx)
  const t = (key) => dictionaries.get('agentos-remote').zh[key] ?? key

  const icon = made.find((r) => r.options.name === 'sidebar.panellist').Component({ size: 16, active: false })
  assert.ok(find(icon, 'svg'), 'the sidebar row renders a glyph')

  const panel = made.find((r) => r.options.name === 'main').Component({ t, api: made.find((r) => r.options.name === 'main').options.inject().api })
  const copy = texts(panel).join(' ')
  assert.match(copy, /WorkBuddy 手机远控/, 'the panel renders its title from the dictionary')
  assert.match(copy, /读取状态中/, 'with no status yet it says so instead of rendering an empty panel')
})

await check('the panel talks to the routes the host half registers', async () => {
  const { exports } = materialize(registrations[0])
  const { ctx, registrations: made } = fakeClientCtx()
  exports.apply(ctx)
  const api = made.find((r) => r.options.name === 'main').options.inject().api

  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    asked.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, status: { loggedIn: false }, state: 's', authUrl: 'u', qr: 'q' }) }
  }
  try {
    await api.status()
    await api.start()
    await api.poll('state with spaces')
  } finally {
    globalThis.fetch = realFetch
  }

  assert.deepEqual(asked.map((a) => a.url), [
    '/agentos-remote/login/api/status',
    '/agentos-remote/login/api/start',
    '/agentos-remote/login/api/poll?state=state%20with%20spaces',
  ])
  assert.ok(asked.every((a) => a.init?.cache === 'no-store'), 'a cached status would freeze the panel')

  // Pin both halves to the same paths: a rename on one side must fail here.
  const hostUi = readFileSync(HOST_UI_FILE, 'utf8')
  for (const route of ['api/status', 'api/start', 'api/poll']) {
    assert.match(hostUi, new RegExp(`\\$\\{PAGE_PATH\\}/${route.replace('/', '\\/')}`), `host route ${route} is missing`)
  }
})

console.log(failed === 0 ? '\nall browser-half checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
