/**
 * Drives the host half against fakes shaped like the real services: a
 * WorkspaceRegistry whose entities carry the production `sessionIds` getter
 * and `attachSession` (cwd-equality membership), and a sessionController RPC
 * service delegating to a commands object. Verifies the two membership
 * relaxations, the workspaceId→timestamped-cwd reroute, the scoping to the
 * default workspace only, and the always-restorable patches.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { installDefaultWorkspace, isRawTitle, livesUnder, nextFolderName, rootFor, samePath, stamp } from '../lib/index.js'

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

/**
 * A production-shaped workspace entity class: the `sessionIds` getter filters
 * members by remembered-path equality, and `attachSession` validates the
 * session header's cwd against the workspace path — exactly the two seams the
 * plugin relaxes.
 */
class FakeWorkspace {
  constructor(registry, record) {
    this.registry = registry
    this.record = record
    this.host = registry.host
  }
  get id() { return this.record.id }
  get path() { return this.record.path }
  get title() { return this.record.title }
  get sessionIds() {
    return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path)
  }
  async setTitle(title) {
    await this.mutate((record) => ({ ...record, title }))
  }
  async mutate(mutator) {
    // The production durable boundary: every write filters sessionIds by
    // strict cwd equality — the seam whose relaxation makes nested members
    // persist.
    this.record = await this.host.table().update(this.id, (current) => {
      const changed = mutator(current)
      const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path)
      return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
    })
    this.registry.persist(this.record)
  }
  async attachSession(sessionId) {
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) throw new Error(`cannot attach session '${sessionId}': no cwd`)
      const cwd = this.host.realpath(header.cwd)
      if (cwd !== this.record.path) throw new Error(`cannot attach session '${sessionId}' to '${this.record.path}': its cwd resolves to '${cwd}'`)
      this.host.rememberSessionPath(sessionId, cwd)
    }
    await this.mutate((record) => (record.sessionIds.includes(sessionId) ? record : { ...record, sessionIds: [sessionId, ...record.sessionIds] }))
  }
}

/**
 * A fake world: real temp directories (so realpath behaves), a registry whose
 * host memo mirrors the production one, and an RPC controller delegating to
 * the production command semantics (workspaceId xor cwd; cwd = workspace path).
 */
function makeWorld() {
  const base = mkdtempSync(path.join(tmpdir(), 'ekko-ws-'))
  const headers = new Map()
  const sessionPaths = new Map()
  const records = new Map()
  const created = []
  let minted = 0
  const registry = {
    host: {
      sessionPath: (id) => sessionPaths.get(id),
      readSessionHeader: async (id) => headers.get(id) ?? { cwd: undefined },
      rememberSessionPath: (id, cwdPath) => sessionPaths.set(id, cwdPath),
      realpath: (value) => {
        const resolved = path.resolve(String(value).replace(/^\\\\\?\\/, ''))
        return resolved
      },
      table: () => ({
        async update(id, mutator) {
          const current = records.get(id)
          const next = await mutator(current)
          records.set(id, next)
          return next
        },
      }),
    },
    persist: (record) => records.set(record.id, record),
    async create(root, title) {
      const existing = [...records.values()].find((record) => record.path === root)
      if (existing !== undefined) return existing.entity
      const record = { id: `ws-${records.size + 1}`, path: root, title: title ?? path.basename(root), sessionIds: [] }
      const entity = new FakeWorkspace(registry, record)
      record.entity = entity
      records.set(record.id, record)
      return entity
    },
    get: (id) => records.get(id)?.entity,
  }
  const controller = {
    async create(request = {}) {
      assert.equal(request.workspaceId !== undefined && request.cwd !== undefined, false, 'wire contract: workspaceId xor cwd')
      minted += 1
      const sessionId = request.sessionId ?? `session-${minted}`
      const workspace = request.workspaceId !== undefined ? registry.get(request.workspaceId) : undefined
      const cwd = workspace?.path ?? request.cwd
      mkdirSync(cwd, { recursive: true })
      headers.set(sessionId, { cwd })
      sessionPaths.set(sessionId, cwd)
      created.push({ sessionId, cwd, request })
      return { sessionId }
    },
  }
  const world = { base, registry, controller, created, records }
  world.defaultRoot = path.join(base, 'workspaces')
  return world
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

console.log('dsh-ekko-workspace host half')

await check('stamp formats local time WorkBuddy-style', () => {
  const when = new Date(2026, 9, 12, 9, 5, 3)
  assert.equal(stamp(when), '2026-10-12-09-05-03')
})

await check('rootFor honours a configured root and defaults to <home>/workspaces', () => {
  assert.equal(rootFor('E:\\scratch'), path.resolve('E:\\scratch'))
  assert.equal(rootFor(''), path.join(homedir(), 'workspaces'))
  assert.equal(rootFor(undefined), path.join(homedir(), 'workspaces'))
})

await check('samePath ignores separators and drive-letter case', () => {
  assert.ok(samePath('C:\\a\\.dsh\\workspaces', 'c:/a/.dsh/workspaces/'))
  assert.ok(!samePath('C:\\a\\workspaces', 'C:\\a\\other'))
  assert.ok(!samePath('/srv/a', '/srv/A'))
})

await check('livesUnder accepts strict children only', () => {
  const root = 'C:\\Users\\t\\workspaces'
  assert.ok(livesUnder(`${root}\\2026-10-12-09-05-03`, root))
  assert.ok(livesUnder(`${root.replace(/\\/g, '/')}/2026-10-12-09-05-03`, root))
  assert.ok(livesUnder(`${root}\\a\\b`, root))
  assert.ok(!livesUnder(root, root))
  assert.ok(!livesUnder('C:\\Users\\t', root))
})

await check('nextFolderName dedupes case-insensitively then falls back', () => {
  const taken = new Set(['n'])
  assert.equal(nextFolderName(taken, 'n'), 'n-2')
  taken.add('n-2')
  assert.equal(nextFolderName(taken, 'n'), 'n-3')
  const all = new Set(Array.from({ length: 20 }, (_, index) => `n-${index}`))
  assert.match(nextFolderName(all, 'n-1'), /^n-1-\d+$/)
})

await check('isRawTitle accepts only untouched basenames', () => {
  assert.ok(isRawTitle('workspaces', 'C:\\Users\\t\\workspaces'))
  assert.ok(!isRawTitle('默认工作区', 'C:\\Users\\t\\workspaces'))
  assert.ok(!isRawTitle('My scratch', 'C:\\Users\\t\\workspaces'))
})

await check('install registers the workspace, titled and ordered, and reroutes default creates', async () => {
  const world = makeWorld()
  const dispose = await installDefaultWorkspace({ registry: world.registry, controller: world.controller, logger: undefined }, { root: world.defaultRoot, title: '默认工作区' })
  try {
    const entity = [...world.records.values()].find((record) => record.path === world.defaultRoot)?.entity
    assert.ok(entity !== undefined, 'workspace registered')
    assert.equal(entity.title, '默认工作区')
    const result = await world.controller.create({ workspaceId: entity.id })
    assert.match(result.sessionId, /^session-\d+$/)
    assert.match(world.created[0].cwd, /[/\\]workspaces[/\\]\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/)
    assert.ok(world.created[0].cwd.startsWith(world.defaultRoot))
    // The session is a member of the default workspace despite its nested cwd.
    assert.deepEqual(entity.sessionIds, [result.sessionId])
  } finally {
    dispose()
  }
})

await check('membership relaxations are scoped to the default workspace', async () => {
  const world = makeWorld()
  const dispose = await installDefaultWorkspace({ registry: world.registry, controller: world.controller, logger: undefined }, { root: world.defaultRoot, title: '默认工作区' })
  try {
    const projectRoot = path.join(world.base, 'proj')
    mkdirSync(projectRoot)
    const project = await world.registry.create(projectRoot, 'proj')
    // A project session whose cwd is nested under the project root stays a
    // native attach rejection and never becomes a member.
    const nested = path.join(projectRoot, 'child')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, '.keep'), '')
    world.registry.host.readSessionHeader = async () => ({ cwd: nested })
    await assert.rejects(() => project.attachSession('session-x'), /its cwd resolves to/)
    assert.deepEqual(project.sessionIds, [])
  } finally {
    dispose()
  }
})

await check('foreign workspaceId and explicit cwd pass through untouched', async () => {
  const world = makeWorld()
  const dispose = await installDefaultWorkspace({ registry: world.registry, controller: world.controller, logger: undefined }, { root: world.defaultRoot, title: '默认工作区' })
  try {
    const projectRoot = path.join(world.base, 'proj')
    mkdirSync(projectRoot)
    const project = await world.registry.create(projectRoot, 'proj')
    await world.controller.create({ workspaceId: project.id })
    assert.equal(world.created[0].cwd, projectRoot)
    world.created.length = 0
    await world.controller.create({ cwd: path.join(world.base, 'elsewhere') })
    assert.equal(world.created[0].cwd, path.join(world.base, 'elsewhere'))
  } finally {
    dispose()
  }
})

await check('two default creates in the same second get suffixed folders', async () => {
  const world = makeWorld()
  const dispose = await installDefaultWorkspace({ registry: world.registry, controller: world.controller, logger: undefined }, { root: world.defaultRoot, title: '默认工作区' })
  try {
    const entity = [...world.records.values()].find((record) => record.path === world.defaultRoot)?.entity
    await world.controller.create({ workspaceId: entity.id })
    await world.controller.create({ workspaceId: entity.id })
    assert.equal(world.created[1].cwd, `${world.created[0].cwd}-2`)
    assert.deepEqual(entity.sessionIds, [world.created[1].sessionId, world.created[0].sessionId])
  } finally {
    dispose()
  }
})

await check('a pre-existing user-retitled default workspace keeps its title', async () => {
  const world = makeWorld()
  const pre = await world.registry.create(world.defaultRoot, 'My scratch')
  const dispose = await installDefaultWorkspace({ registry: world.registry, controller: world.controller, logger: undefined }, { root: world.defaultRoot, title: '默认工作区' })
  try {
    assert.equal(pre.title, 'My scratch')
  } finally {
    dispose()
  }
})

await check('the disposer restores the prototype and the controller', async () => {
  const world = makeWorld()
  const dispose = await installDefaultWorkspace({ registry: world.registry, controller: world.controller, logger: undefined }, { root: world.defaultRoot, title: '默认工作区' })
  const entity = [...world.records.values()].find((record) => record.path === world.defaultRoot)?.entity
  const attached = await world.controller.create({ workspaceId: entity.id })
  dispose()
  // Membership reverts to cwd-equality: the nested session drops out of view…
  assert.deepEqual(entity.sessionIds, [])
  // …the record still keeps it (the registry only ever logs filtered members),
  // and a fresh default create goes through the native cwd-equality semantics.
  const native = await world.controller.create({ workspaceId: entity.id })
  assert.equal(world.created.at(-1).cwd, world.defaultRoot)
  void attached
  void native
})

await check('a registry failure disables the reroute without breaking creates', async () => {
  const world = makeWorld()
  const broken = {
    ...world.registry,
    async create() {
      throw new Error('storage unavailable')
    },
  }
  const dispose = await installDefaultWorkspace({ registry: broken, controller: world.controller, logger: undefined }, { root: world.defaultRoot, title: '默认工作区' })
  try {
    const out = await world.controller.create({ cwd: path.join(world.base, 'plain') })
    assert.match(out.sessionId, /^session-\d+$/)
    assert.equal(world.created[0].cwd, path.join(world.base, 'plain'))
  } finally {
    dispose()
  }
})

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
