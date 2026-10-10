/**
 * dsh-agentos-remote load + contract test — run with: node test/load.test.mjs
 *
 * Hermetic on purpose: no network, no harness, and no read of the real WorkBuddy
 * session directory. It imports the REAL plugin module, drives `apply()` against
 * a fake ctx, exercises the one credential-discovery path that needs no I/O, and
 * asserts the bundle contract that scripts/validate.mjs encodes — so a broken
 * manifest, a missing patch row or an undeclared runtime dependency fails here
 * rather than on a user's machine at connect time.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentosRemoteService,
  apply,
  name,
  readWorkbuddySession,
  registerWorkspace,
} from '../lib/index.js'
import { registerLoginUi } from '../lib/login-ui.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message.split('\n').slice(0, 4).join('\n       ')}`)
  }
}

/** A ctx just real enough for apply(): it records logs and the mount call. */
function fakeCtx(overrides = {}) {
  const lines = []
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      warn: (message) => lines.push(`WARN ${message}`),
      debug: () => {},
    },
    plugin: () => {
      throw new Error('ctx.plugin must not be called on this path')
    },
    ...overrides,
  }
}

/**
 * A ctx that guards undeclared property reads the way a real Cordis context
 * does: anything not already on the target throws `cannot get property ...`.
 * `fakeCtx` alone is a plain object, so a read that is fatal on a real host
 * looks harmless here — which is exactly how `apply` returning
 * `ctx.agentosRemote` shipped and then took down every boot.
 */
function guardedCtx(overrides = {}) {
  const target = fakeCtx(overrides)
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string' && !Reflect.has(obj, prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(obj, prop, receiver)
    },
  })
}

/** Run fn with specific env vars set, then restore the previous environment. */
function withEnv(values, fn) {
  const keys = Object.keys(values)
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

console.log('dsh-agentos-remote load + contract tests\n')

// ---------------------------------------------------------------- module shape

check('exports the cordis plugin surface', () => {
  assert.equal(name, 'dsh-agentos-remote')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof AgentosRemoteService, 'function', 'the service class is exported for diagnostics')
  assert.equal(typeof readWorkbuddySession, 'function')
  assert.equal(typeof registerWorkspace, 'function')
})

check('the service injects the web surface it serves the login page on', () => {
  // Documented behaviour, not an accident: the QR login page rides the Web
  // surface, so `dsh web` (or any profile carrying webServer) is required.
  // Agent services are NOT injected — they are read when a task arrives.
  assert.deepEqual(AgentosRemoteService.inject, ['webServer'])
})

// ------------------------------------------------------------- disabled path

check('apply({ enabled: false }) explains itself and mounts nothing', () => {
  const ctx = fakeCtx()
  const result = apply(ctx, { enabled: false })
  assert.equal(result, undefined)
  assert.ok(
    ctx.lines.some((line) => line.includes('disabled by config')),
    'should say why nothing happened',
  )
})

// --------------------------------------------------------------- mount path

check('apply() mounts the service with the documented defaults', () => {
  let mounted
  const ctx = fakeCtx({
    plugin: (klass, config) => {
      mounted = { klass, config }
    },
  })
  apply(ctx, {})
  assert.equal(mounted.klass, AgentosRemoteService)
  assert.equal(mounted.config.enabled, true)
  assert.equal(mounted.config.endpoint, 'https://tencent.sso.codebuddy.cn')
  assert.equal(mounted.config.agentType, 'workbuddy', 'the channel namespace the app enumerates comes from this value')
})

check('caller config overrides the defaults without dropping the rest', () => {
  let mounted
  const ctx = fakeCtx({
    plugin: (klass, config) => {
      mounted = { klass, config }
    },
  })
  apply(ctx, { endpoint: 'https://example.test', deviceName: 'phone-lab' })
  assert.equal(mounted.config.endpoint, 'https://example.test')
  assert.equal(mounted.config.deviceName, 'phone-lab')
  assert.equal(mounted.config.agentType, 'workbuddy', 'untouched keys keep their default')
})

check('apply() touches no ctx property it has not injected', () => {
  // Regression: `apply` used to end with `return ctx.agentosRemote ?? null`.
  // On a real host that read is fatal — the service lives on a CHILD fiber, so
  // the proxy throws `cannot get property "agentosRemote" without inject` and
  // the entire profile fails to boot. Asserted against a guarded ctx, because a
  // plain-object fake cannot see the difference.
  assert.equal(apply(guardedCtx({ plugin: () => {} }), {}), undefined)
})

// ------------------------------------------------- credential discovery (pure)

check('readWorkbuddySession prefers DSH_AGENTOS_ACCESS_TOKEN', () => {
  withEnv(
    {
      DSH_AGENTOS_ACCESS_TOKEN: 'token-from-env',
      DSH_AGENTOS_USER_ID: 'uid-1',
      DSH_AGENTOS_ENTERPRISE_ID: 'ent-1',
      DSH_AGENTOS_DOMAIN: 'example.test',
    },
    () => {
      const session = readWorkbuddySession(fakeCtx().logger, null)
      assert.equal(session.auth.accessToken, 'token-from-env')
      assert.equal(session.auth.domain, 'example.test')
      assert.equal(session.account.uid, 'uid-1')
      assert.equal(session.account.enterpriseId, 'ent-1')
    },
  )
})

check('readWorkbuddySession returns null when nothing is discoverable', () => {
  withEnv({ DSH_AGENTOS_ACCESS_TOKEN: undefined }, () => {
    // An explicit path keeps this hermetic: with no explicit path the reader
    // would scan the real WorkBuddy session directory on this machine.
    const missing = path.join(HERE, 'definitely-not-a-session-file.info')
    assert.equal(readWorkbuddySession(fakeCtx().logger, missing), null)
  })
})

// ------------------------------------------------------------ bundle contract

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patchRel = pkg.dsh?.bundle?.patch
const patchPath = path.join(ROOT, patchRel ?? 'missing')
const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''

check('R1: dsh.bundle.patch is declared and points at a real file', () => {
  assert.equal(patchRel, './cordis.patch.yml')
  assert.ok(existsSync(patchPath), `${patchRel} should exist`)
})

check('R2: the patch is a YAML array whose row names this package', () => {
  const firstMeaningful = patchText.split('\n').find((line) => line.trim() && !line.trim().startsWith('#'))
  assert.ok(firstMeaningful?.startsWith('-'), 'cordis.patch.yml top level must be an array')
  assert.match(patchText, new RegExp(`^\\s*name:\\s*'?${pkg.name}'?\\s*$`, 'm'))
})

check('R4: official packages are peers, never dependencies', () => {
  const official = Object.keys(pkg.dependencies ?? {}).filter((dep) => dep.startsWith('@deepseek-ai/'))
  assert.deepEqual(official, [], 'no @deepseek-ai/* may sit in dependencies')
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/cordis'], 'cordis is the peer the plugin actually imports')
})

check('the lazily-imported runtime dependencies are declared', () => {
  // lib/index.js pulls these in with `await import(...)` when it connects, so a
  // missing declaration would only surface on a user machine, at connect time.
  const source = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  for (const dep of ['centrifuge', 'ws']) {
    assert.match(source, new RegExp(`import\\(["']${dep}["']\\)`), `${dep} is imported dynamically`)
    assert.ok(pkg.dependencies?.[dep], `${dep} must be a declared dependency`)
  }
  assert.ok(pkg.dependencies?.qrcode, 'qrcode backs the login QR code')
})

// -------------------------------------------------- UI status (panel-facing)

/**
 * Call linkStatus on a bare `this`: the snapshot only reads instance fields, so
 * no Cordis service, no init, and no credentials file are needed to pin it.
 */
function linkStatusOf(fields) {
  return AgentosRemoteService.prototype.linkStatus.call({
    linkState: AgentosRemoteService.prototype.linkState,
    ...fields,
  })
}

check('linkStatus reports the facts the in-UI panel renders', () => {
  const status = linkStatusOf({
    config: { endpoint: 'https://example.test', deviceName: 'phone-lab', workspaceDir: null },
    session: undefined,
    subscribed: false,
    stopped: false,
    workspaceDir: '/tmp/proj',
  })
  assert.equal(status.loggedIn, false)
  assert.equal(status.link, 'waiting-login', 'no credentials is the state a fresh machine is in')
  assert.equal(status.device, 'phone-lab', 'config wins over the hostname default')
  assert.equal(status.workspace, 'proj', 'the app sees the directory name, not the full path')
  assert.equal(status.endpoint, 'https://example.test')
})

check('linkStatus never carries a credential', () => {
  // The route rides the same unauthenticated web surface as the login page, so
  // the snapshot is a deliberate allow-list: adding a field here is a leak.
  const status = linkStatusOf({
    config: { endpoint: 'https://example.test', deviceName: null, workspaceDir: null },
    session: { auth: { accessToken: 'SECRET-A', refreshToken: 'SECRET-R' }, account: { uid: 'u1', nickname: 'n1' } },
    subscribed: true,
    stopped: false,
    workspaceDir: '/tmp/proj',
  })
  assert.deepEqual(Object.keys(status).sort(), ['device', 'endpoint', 'link', 'loggedIn', 'nickname', 'uid', 'workspace'])
  assert.equal(status.link, 'subscribed', 'a live channel subscription is what "tasks can arrive" means')
  assert.ok(!JSON.stringify(status).includes('SECRET'), 'no token may appear in the panel payload')
})

check('config.debug adds link diagnostics and still no credential', () => {
  // The device-list failure mode is "registered fine, enumerable never", and the
  // channel NAMESPACE is the only fact that separates the two. It stays out of
  // the default payload; this is the opt-in that makes it observable.
  const status = linkStatusOf({
    config: { endpoint: 'https://example.test', deviceName: null, workspaceDir: null, debug: true, agentType: 'workbuddy' },
    session: { auth: { accessToken: 'SECRET-A' }, account: { uid: 'u1', nickname: 'n1' } },
    subscribed: true,
    stopped: false,
    workspaceDir: '/tmp/proj',
    channel: 'copilot_workbuddy:u1_deadbeef_proj',
    lastError: null,
  })
  assert.equal(status.channelNamespace, 'copilot_workbuddy', 'the namespace is what decides app enumeration')
  assert.equal(status.agentType, 'workbuddy')
  assert.equal(status.registered, true)
  assert.ok(!status.channelNamespace.includes('deadbeef'), 'the namespace prefix must not carry the hostId')
  assert.ok(!JSON.stringify(status).includes('SECRET'), 'debug mode is not a licence to leak the token')
})

check('the service tracks subscription state for linkStatus', () => {
  const source = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.match(source, /sub\.on\("subscribed",\s*\(\)\s*=>\s*\{\s*this\.subscribed = true/, 'subscribed must be recorded')
  assert.match(source, /this\.subscribed = false/, 'and cleared on unsubscribe/teardown')
})

check('the login UI registers the status route the browser half reads', async () => {
  const routes = []
  const webServer = {
    register: (spec) => {
      routes.push(spec)
      return () => {}
    },
  }
  const snapshot = { loggedIn: false, link: 'waiting-login' }
  registerLoginUi(webServer, { onSession: () => {}, status: () => snapshot }, fakeCtx().logger)

  const paths = routes.map((r) => r.path)
  assert.deepEqual(paths, [
    '/agentos-remote/login',
    '/agentos-remote/login/api/start',
    '/agentos-remote/login/api/poll',
    '/agentos-remote/login/api/status',
  ])

  const statusRoute = routes.find((r) => r.path.endsWith('/api/status'))
  assert.equal(statusRoute.kind, 'exact')
  let body
  await statusRoute.handler(
    { url: '/agentos-remote/login/api/status' },
    { writeHead: () => {}, end: (text) => { body = JSON.parse(text) } },
  )
  assert.deepEqual(body, { ok: true, status: snapshot })
})

check('a status provider that throws degrades to ok:false instead of a 500', async () => {
  const routes = []
  const webServer = { register: (spec) => { routes.push(spec); return () => {} } }
  registerLoginUi(webServer, { onSession: () => {}, status: () => { throw new Error('boom') } }, fakeCtx().logger)
  let body
  await routes.find((r) => r.path.endsWith('/api/status')).handler(
    { url: '/agentos-remote/login/api/status' },
    { writeHead: () => {}, end: (text) => { body = JSON.parse(text) } },
  )
  assert.equal(body.ok, false)
  assert.equal(body.error, 'boom')
})

check('listing readiness: keywords, files, repository, truthful description', () => {
  assert.ok(pkg.keywords.includes('dsh-plugin'), 'the curated listing discovers plugins by this keyword')
  assert.ok(pkg.files.includes('cordis.patch.yml'), 'the patch must ship')
  assert.ok(pkg.files.includes('lib'), 'the build output must ship')
  assert.match(pkg.repository?.url ?? '', /^https:\/\/github\.com\//)
  assert.ok(pkg.description.trim().endsWith('.'), 'R8: the listing maintainers read this against the code')
})

console.log(failed === 0 ? '\nall load + contract checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
