/**
 * dsh-ekko-workspace — a default workspace for project-less sessions.
 *
 * DSH groups sessions by workspace with a strict rule: a session belongs to a
 * workspace exactly when its cwd IS the workspace's directory. The Web UI only
 * creates sessions through `sessions.create({workspaceId})`, so every session
 * in a workspace shares one cwd, and a session that names nothing lands
 * wherever the host process was started. WorkBuddy's answer to the same
 * problem is a "default workspace": one aggregate category, with a fresh
 * timestamped scratch folder per session as its pwd.
 *
 * Mapping that onto DSH needs three relaxations of the equality rule, all
 * installed by this plugin's host half and all scoped to the default
 * workspace only:
 *
 *  - `Workspace.attachSession` also accepts a cwd strictly UNDER the default
 *    root (every other workspace keeps native semantics);
 *  - the `sessionIds` membership getter also counts sessions whose remembered
 *    cwd is under the default root (native filtering elsewhere is untouched,
 *    and the durable registry only ever logs filtered candidates, so the
 *    membership survives restarts);
 *  - the registry's `mutate` keeps under-root children through the durable
 *    boundary, whose own strict filter would otherwise strip them on write.
 *
 * `sessionController.create` is wrapped so a create naming the default
 * workspace runs through the cwd branch with `<root>/<YYYY-MM-DD-HH-mm-ss>`
 * (the host mkdir -p's session cwds) and then attaches the session — the wire
 * contract stays `workspaceId xor cwd`, and nothing changes for any other
 * workspace, explicit-cwd create, or SDK caller.
 *
 * At load the plugin mkdir -p's the root, registers the workspace (prepending
 * it to the sidebar order), and titles it — so the category exists before the
 * first session asks for one. Every failure is a warning; the plugin must
 * never be the reason a session cannot be created.
 *
 * @module dsh-ekko-workspace
 */
import { mkdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-ekko-workspace'

export const Config = Schema.object({
  root: Schema.string().default('').description('Backing directory of the default workspace; empty = $DSH_HOME/workspaces.'),
  title: Schema.string().default('默认工作区').description('Sidebar title of the default workspace.'),
})

/** Upper bound on folder-name dedupe attempts within one create. */
const NAME_RETRY_MAX = 8

/**
 * Local-time folder name, WorkBuddy style: `YYYY-MM-DD-HH-mm-ss`.
* @param now - the moment the folder represents.
* @returns the folder segment.
*/
export function stamp(now) {
  const date = now instanceof Date ? now : new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/**
 * The harness home: explicit $DSH_HOME wins, else `~/.dsh` (the same
 * resolution the ekkobuddy bundle uses).
* @returns the DSH home directory.
*/
function dshHome() {
  const env = process.env.DSH_HOME
  if (env !== undefined && env !== null && env.trim() !== '') return path.resolve(env)
  return path.join(homedir(), '.dsh')
}

/**
 * The default workspace's backing directory for a config value.
* @param configured - the config's `root`; empty means "derive".
* @returns the absolute root path.
*/
export function rootFor(configured) {
  if (configured !== undefined && configured !== null && configured.trim() !== '') return path.resolve(configured)
  return path.join(dshHome(), 'workspaces')
}

/** Strip the Windows \\?\ prefix `fs.realpath` produces. */
function canonicalize(value) {
  return String(value).replace(/^\\\\\?\\/, '')
}

/**
 * Equality for directory paths: separators and trailing slashes never matter;
 * drive-letter paths additionally compare case-insensitively.
* @param left - one absolute path.
* @param right - another absolute path.
* @returns whether they name the same directory.
*/
export function samePath(left, right) {
  const normalize = (value) => canonicalize(String(value ?? '')).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  if (a === b) return true
  if (/^[a-z]:\//i.test(a) && /^[a-z]:\//i.test(b)) return a.toLowerCase() === b.toLowerCase()
  return false
}

/**
 * Whether `child` is a directory strictly inside `parent` (one or more
 * segments deeper, never equal).
* @param child - candidate member path.
* @param parent - the default root.
* @returns whether child lives under parent.
*/
export function livesUnder(child, parent) {
  const normalize = (value) => canonicalize(String(value ?? '')).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const a = normalize(child)
  const b = normalize(parent)
  if (a === '' || b === '' || a === b) return false
  if (!a.startsWith(`${b}/`)) return false
  if (/^[a-z]:\//i.test(a) && /^[a-z]:\//i.test(b) && a.slice(0, 2).toLowerCase() !== b.slice(0, 2).toLowerCase()) return false
  return true
}

/**
 * Pick a folder name under `root`, deduplicating inside `taken` (a Set of
 * lower-cased names already used since boot).
* @param taken - lower-cased names to avoid.
* @param base - the preferred name.
* @returns a name not present in `taken`; the caller adds it to the set.
*/
export function nextFolderName(taken, base) {
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; index < 2 + NAME_RETRY_MAX; index++) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * Whether a workspace title is still the untouched default (the path's
 * basename or the full path): renaming those is safe, renaming a user's title
 * is not.
* @param title - the workspace's current title.
* @param folderPath - the workspace's path.
* @returns whether the title was never customized.
*/
export function isRawTitle(title, folderPath) {
  return title === folderPath || title === path.win32.basename(String(folderPath ?? '')) || title === path.posix.basename(String(folderPath ?? ''))
}

/**
 * Canonicalize a path the way the registry does, for the relaxed attach.
* @param value - a session header cwd.
* @returns the realpath'd, prefix-stripped path.
*/
async function realpathOf(value) {
  return canonicalize(await realpath(String(value)))
}

/**
 * Install the default workspace and the two membership relaxations.
 *
* @param deps - { registry, controller } host services plus a logger.
* @param config - the plugin config.
* @returns disposer restoring every patch.
*/
export async function installDefaultWorkspace({ registry, controller, logger }, config) {
  const log = (message) => logger?.info?.(`[dsh-ekko-workspace] ${message}`)
  const warn = (message) => logger?.warn?.(`[dsh-ekko-workspace] ${message}`)
  const root = rootFor(config?.root)
  const title = config?.title === undefined || config?.title === '' ? '默认工作区' : config?.title

  let entity
  try {
    mkdirSync(root, { recursive: true })
    // Idempotent: a repeated canonical path returns the existing entity
    // without touching its title; a new one is prepended to the order.
    entity = await registry.create(root, title)
    if (entity.title === undefined || isRawTitle(entity.title, entity.path)) await entity.setTitle(title)
    log(`default workspace ready at ${entity.path} (${entity.id})`)
  } catch (error) {
    warn(`could not register the default workspace at ${root} (${error.message}); sessions keep native behavior`)
    return () => {}
  }

  const isDefault = (recordPath) => samePath(recordPath, entity.path)
  const proto = Object.getPrototypeOf(entity)
  const disposers = []

  // Relaxation 1: membership counts sessions whose cwd lives strictly under
  // the default root (native equality keeps covering everything else).
  const memberIds = (self) => {
    const record = self.record
    const direct = []
    const nested = []
    for (const id of record.sessionIds) {
      const cwd = self.host.sessionPath(id)
      if (cwd === undefined) continue
      if (cwd === record.path) direct.push(id)
      else if (isDefault(record.path) && livesUnder(cwd, record.path)) nested.push(id)
    }
    return [...direct, ...nested]
  }
  const idsDescriptor = Object.getOwnPropertyDescriptor(proto, 'sessionIds')
  if (idsDescriptor !== undefined && idsDescriptor.get !== undefined) {
    const originalIds = idsDescriptor.get
    Object.defineProperty(proto, 'sessionIds', {
      ...idsDescriptor,
      get() {
        return isDefault(this.record?.path) ? memberIds(this) : originalIds.call(this)
      },
    })
    disposers.push(() => Object.defineProperty(proto, 'sessionIds', idsDescriptor))
  } else {
    warn('workspace sessionIds getter not found; nested members would not group')
  }

  // Relaxation 2: attach accepts a cwd under the default root (native
  // equality keeps covering everything else).
  const attachDescriptor = Object.getOwnPropertyDescriptor(proto, 'attachSession')
  const originalAttach = proto.attachSession
  if (typeof originalAttach === 'function') {
    proto.attachSession = async function relaxedAttach(sessionId) {
      if (!isDefault(this.record?.path)) return originalAttach.call(this, sessionId)
      if (!this.record.sessionIds.includes(sessionId)) {
        const header = await this.host.readSessionHeader(sessionId)
        if (header.cwd === undefined) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its stored header carries no cwd`)
        const cwd = await realpathOf(header.cwd)
        if (cwd !== this.record.path && !livesUnder(cwd, this.record.path)) {
          throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${cwd}'`)
        }
        this.host.rememberSessionPath(sessionId, cwd)
      }
      await this.mutate((record) => (record.sessionIds.includes(sessionId) ? record : { ...record, sessionIds: [sessionId, ...record.sessionIds] }))
    }
    disposers.push(() => Object.defineProperty(proto, 'attachSession', attachDescriptor))
  } else {
    warn('workspace attachSession method not found; rerouted sessions would stay ungrouped')
  }

  // Relaxation 3: the durable boundary. The registry's own `mutate` filters
  // every write's sessionIds by strict cwd equality, so a membership the
  // relaxed attach added would be stripped on persist. For the default
  // workspace the filter keeps under-root children too.
  const mutateDescriptor = Object.getOwnPropertyDescriptor(proto, 'mutate')
  const originalMutate = proto.mutate
  if (typeof originalMutate === 'function') {
    proto.mutate = async function relaxedMutate(fn) {
      if (!isDefault(this.record?.path)) return originalMutate.call(this, fn)
      const next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter((id) => {
          const cwd = this.host.sessionPath(id)
          return cwd === changed.path || livesUnder(cwd, changed.path)
        })
        if (changed === current && sessionIds.length === current.sessionIds.length) return current
        return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
      })
      this.record = next
    }
    disposers.push(() => Object.defineProperty(proto, 'mutate', mutateDescriptor))
  } else {
    warn('workspace mutate method not found; nested members would not persist')
  }

  // Reroute: a create naming the default workspace becomes a cwd-branch create
  // with a fresh timestamped folder, then attaches — the wire contract stays
  // `workspaceId xor cwd`, and everything else passes through untouched.
  const takenNames = new Set()
  const originalCreate = controller.create.bind(controller)
  const createWasOwn = Object.prototype.hasOwnProperty.call(controller, 'create')
  const createOwn = controller.create
  controller.create = async function rerouted(request = {}) {
    if (request.workspaceId !== entity.id) return originalCreate(request)
    const name = nextFolderName(takenNames, stamp(Date.now()))
    takenNames.add(name.toLowerCase())
    const result = await originalCreate({
      cwd: path.join(entity.path, name),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    })
    const fresh = registry.get(entity.id) ?? entity
    try {
      await fresh.attachSession(result.sessionId)
    } catch (error) {
      warn(`session '${result.sessionId}' created in '${fresh.path}' but not grouped (${error.message})`)
    }
    return result
  }
  disposers.push(() => {
    if (createWasOwn) controller.create = createOwn
    else delete controller.create
  })

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

export function apply(ctx, config) {
  ctx.inject(['workspaceRegistry', 'sessionController'], (scope) => {
    let dispose = () => {}
    scope.effect(() => dispose, 'dsh-ekko-workspace: default workspace')
    void installDefaultWorkspace(
      {
        registry: scope.workspaceRegistry ?? scope.get?.('workspaceRegistry'),
        controller: scope.sessionController ?? scope.get?.('sessionController'),
        logger: scope.logger ?? ctx.logger,
      },
      config,
    )
      .then((installed) => {
        dispose = installed
      })
      .catch((error) => {
        ;(scope.logger ?? ctx.logger)?.warn?.(`[dsh-ekko-workspace] install failed (${error.message}); sessions keep native behavior`)
      })
  })
}
