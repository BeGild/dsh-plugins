/**
 * dsh-skill-market — install ZCode plugins and WorkBuddy skills into this profile.
 *
 * Two faces over one implementation: the `skill_market` model tool, and a web
 * panel (lib/client.js) whose buttons drive the JSON routes registered on the
 * profile's web server.
 *
 * A ZCode plugin is installed whole. Its skills land in the skill directory the
 * default provider scans, its slash commands register on `ctx.commands` and
 * submit their prompt into the receiving agent's loop, its Claude Code command
 * hooks are started through `dsh-hooks-claude-code`, and each MCP server it
 * declares is started through `dsh-mcp-client`. A server that authenticates
 * with a ZCode account is reported and skipped.
 *
 * WorkBuddy skills install as skill bundles only. WorkBuddy connectors and
 * experts are not offered: a connector needs that product's account, and an
 * expert ships no package.
 *
 * @module dsh-skill-market
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULTS,
  OPS,
  SOURCES,
  asBundles,
  hasHooks,
  packageSkillFiles,
  parseCommandFile,
  parseWorkbuddySkills,
  parseZcodeMarketplace,
  detailEntry,
  pluginHooksDocument,
  pluginMcpConfig,
  resolveSettings,
  searchEntries,
  skillDocument,
} from './catalog.js'
import { decodeText, fetchBytes, listZip, readZipEntry, readZipText, readZipTree } from './fetch.js'
import {
  readInstalled,
  removeBundles,
  removePluginTree,
  writeBundles,
  writeInstalled,
  writePluginTree,
} from './store.js'

export const name = 'dsh-skill-market'
export const inject = ['tools']

export const Config = Schema.object({
  /** Records and unpacked ZCode plugins. Empty uses $DSH_HOME/skill-market. */
  stateDir: Schema.string().default(DEFAULTS.stateDir),
  /** Where skill bundles are written. Empty uses $DSH_HOME/skills, which the default provider scans. */
  skillsDir: Schema.string().default(''),
  /** ZCode marketplace.json URL. */
  zcodeMarketplaceUrl: Schema.string().default(DEFAULTS.zcodeMarketplaceUrl),
  /** WorkBuddy skill-marketplace zip URL. */
  workbuddySkillZipUrl: Schema.string().default(DEFAULTS.workbuddySkillZipUrl),
  /** Timeout for one catalog download, in milliseconds. */
  requestTimeoutMs: Schema.number().default(DEFAULTS.requestTimeoutMs),
  /** Maximum entries one search returns. */
  maxResults: Schema.number().default(DEFAULTS.maxResults),
  /** Start the MCP servers and hooks of installed ZCode plugins when the harness boots. */
  autoConnect: Schema.boolean().default(DEFAULTS.autoConnect),
})

/** Routes lib/client.js fetches; prefix kind so query strings still match. */
const API_BASE = '/skill-market/api'

const DESCRIPTION = [
  'Install a ZCode plugin or a WorkBuddy skill into this DSH profile.',
  'Ops: sources, search, install, remove, installed.',
  'search takes source (zcode or workbuddy-skill) and an optional query. install takes source and id.',
  'A ZCode plugin installs its skills, registers its slash commands, runs its command hooks inside the agent loop, and connects each MCP server it declares.',
  'A slash command submits the command file as the next prompt, with the text after the command name appended.',
  'A server that logs in through a ZCode account is skipped and named in the result. Hooks and MCP servers reconnect on the next boot.',
].join(' ')

const ENTRY_FIELDS = {
  source: { type: 'string', required: true },
  kind: { type: 'string', required: true },
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  description: { type: 'string', required: true },
  version: { type: 'string' },
  category: { type: 'string' },
  installable: { type: 'boolean', required: true },
  reason: { type: 'string' },
}

/**
 * @param ctx - registrant context. Commands, hooks, and MCP servers attach here.
 * @param config - deployment settings.
 */
export async function apply(ctx, config) {
  const settings = resolveSettings(config, process.env.DSH_HOME || join(homedir(), '.dsh'))

  // The command registry is optional on this host (headless boots carry no
  // commands adapter), so it is captured through a service-inject child rather
  // than declared in `inject` — a missing service must not keep the tool down.
  const commandsRef = { current: undefined }
  ctx.inject(['commands'], (commandsCtx) => {
    commandsRef.current = commandsCtx.commands
    return () => {
      commandsRef.current = undefined
    }
  })

  const market = createMarket(ctx, settings, commandsRef)

  if (settings.autoConnect && settings.stateDir) {
    ctx.effect(() => restoreInstalled(ctx, settings, market), 'skill-market: reconnect installed plugins')
  }

  // Web profiles carry a webServer; a headless boot simply never fires this
  // inject, and the tool below keeps working without the panel.
  ctx.inject(['webServer'], (webCtx) => registerMarketApi(webCtx.webServer, market, settings))

  ctx.tools.register(
    defineTool({
      name: 'skill_market',
      description: DESCRIPTION,
      parameters: {
        op: {
          type: 'string',
          required: true,
          enum: [...OPS],
          description: 'sources | search | install | remove | installed.',
        },
        source: {
          type: 'string',
          enum: [...SOURCES],
          description: 'Which catalog. Required for search and install.',
        },
        id: { type: 'string', description: 'Catalog id returned by search.' },
        query: { type: 'string', description: 'search: case-insensitive match against name and description.' },
        limit: { type: 'integer', description: 'search: page size, capped by the configured maxResults.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: [...OPS] },
            source: { type: 'string' },
            entries: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: ENTRY_FIELDS },
            },
            total: { type: 'integer' },
            truncated: { type: 'boolean' },
            installed: { type: 'boolean' },
            skills: { type: 'array', items: { type: 'string' } },
            commands: { type: 'array', items: { type: 'string' } },
            hooks: { type: 'boolean' },
            servers: { type: 'array', items: { type: 'string' } },
            skipped: { type: 'array', items: { type: 'string' } },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      },
      isConcurrencySafe: (args) => args?.op === 'sources' || args?.op === 'search' || args?.op === 'installed',
      async execute(args) {
        if (!settings.stateDir) throw new Error('skill_market: no state directory; set stateDir or DSH_HOME')
        switch (args.op) {
          case 'sources':
            return { op: args.op, message: await market.sources() }
          case 'search':
            return { op: args.op, ...(await market.search(args)) }
          case 'install':
            return { op: args.op, ...(await market.install(args)) }
          case 'remove':
            return { op: args.op, installed: false, ...(await market.remove(args)) }
          case 'installed':
            return { op: args.op, ...(await market.installed()) }
          default:
            throw new Error(`skill_market: unknown op "${args.op}"; expected one of ${OPS.join(', ')}`)
        }
      },
    }),
  )
}

/**
 * The catalog operations both faces share. Holds the download cache and the
 * live command/hook/MCP handles for this process.
 * @param ctx - registrant context.
 * @param settings - resolved deployment settings.
 */
function createMarket(ctx, settings, commandsRef) {
  const cache = new Map()
  const running = new Map()
  const iconCache = new Map()

  /** Resolve one icon to `{ bytes, contentType }`, or undefined on any miss. */
  const loadIcon = async (source, id) => {
    try {
      if (source === 'zcode') {
        const entry = await market.entryOf(source, id)
        if (!entry?.icon) return undefined
        const bytes = await fetchBytes(entry.icon, settings.requestTimeoutMs)
        return { bytes, contentType: contentTypeFor(entry.icon) }
      }
      if (source === 'workbuddy-skill') {
        const archive = await skillArchive(settings, cache)
        for (const ext of ['svg', 'png', 'webp', 'jpg']) {
          const name = `icons/${id}.${ext}`
          if (!listZip(archive).some((item) => item.name === name)) continue
          return {
            bytes: readZipEntry(archive, listZip(archive).find((item) => item.name === name)),
            contentType: contentTypeFor(name),
          }
        }
        return undefined
      }
      return undefined
    } catch {
      return undefined
    }
  }

  const market = {
    running,
    commandsRef,
    async sources() {
      return [
        'zcode: a plugin installs its skills, its slash commands, its command hooks, and its MCP servers.',
        'workbuddy-skill: a skill installs as a bundle and is usable on the next turn.',
      ].join('\n')
    },

    /** @param {{source?: string, query?: string, limit?: number}} args */
    async search(args) {
      const source = requireSource(args.source)
      const catalog = await loadCatalog(settings, cache, source)
      const page = searchEntries(catalog, args.query, args.limit ?? settings.maxResults)
      return {
        source,
        entries: page.entries.map(publicEntry),
        total: page.total,
        truncated: page.truncated,
        message: page.total === 0 ? 'nothing matched' : `${page.entries.length} of ${page.total}`,
      }
    },

    /** The same page, with the fields only the panel renders. */
    async searchDetail(args) {
      const source = requireSource(args.source)
      const catalog = await loadCatalog(settings, cache, source)
      const page = searchEntries(catalog, args.query, args.limit ?? settings.maxResults)
      return {
        source,
        entries: page.entries.map(detailEntry),
        total: page.total,
        truncated: page.truncated,
      }
    },

    /** @param {{source?: string, id?: string}} args */
    async install(args) {
      const source = requireSource(args.source)
      const id = requireId(args.id)
      const catalog = await loadCatalog(settings, cache, source)
      const entry = catalog.find((item) => item.id === id)
      if (!entry) throw new Error(`skill_market: "${id}" is not in ${source}`)
      if (!entry.installable) throw new Error(`skill_market: "${id}" cannot be installed here. ${entry.reason}`)

      if (source === 'workbuddy-skill') {
        const files = asBundles(id, await workbuddySkillFiles(settings, cache, entry))
        const skills = await writeBundles(settings.skillsDir, files)
        await remember(settings, entry, { skills, commands: [], hooks: false, servers: [], skipped: [] })
        return {
          source,
          installed: true,
          skills,
          commands: [],
          hooks: false,
          servers: [],
          skipped: [],
          message: `installed ${skills.join(', ')} into ${settings.skillsDir}. Usable on the next turn.`,
        }
      }

      const archive = await fetchBytes(entry.downloadUrl, settings.requestTimeoutMs)
      const tree = readZipTree(archive, '')
      const pluginDir = await writePluginTree(settings.pluginsDir, id, tree)
      const activated = await activatePlugin(ctx, settings, running, id, pluginDir, tree, commandsRef)
      await remember(settings, entry, activated)
      return { source, installed: true, ...activated, message: activationMessage(id, activated) }
    },

    /** @param {{id?: string}} args */
    async remove(args) {
      const id = requireId(args.id)
      const records = await readInstalled(settings.stateDir)
      const record = records[id]
      // Stop the runtime FIRST: on Windows an MCP child or a hook process
      // still holds the plugin tree, and removing the directory under it
      // fails with EBUSY.
      await stopRuntime(running, id)
      await removeBundles(settings.skillsDir, record?.skills ?? [])
      await removePluginTree(settings.pluginsDir, id)
      delete records[id]
      await writeInstalled(settings.stateDir, records)
      return { message: `removed ${id}` }
    },

    async installed() {
      const records = await readInstalled(settings.stateDir)
      const entries = Object.values(records).map(publicEntry)
      return {
        entries,
        total: entries.length,
        message: entries.length === 0 ? 'nothing installed by skill_market' : `${entries.length} installed`,
      }
    },

    /**
     * One entry's icon bytes, or undefined. ZCode icons are remote URLs from
     * the marketplace document; WorkBuddy icons live at `icons/<id>.(svg|png)`
     * inside the catalog zip. Results are cached per source/id, misses included.
     */
    async icon(source, id) {
      const key = `${source}/${id}`
      if (iconCache.has(key)) return iconCache.get(key)
      const found = await loadIcon(source, id)
      iconCache.set(key, found)
      return found
    },

    /** The catalog entry one id resolves to, detail form, for icon URLs. */
    async entryOf(source, id) {
      const catalog = await loadCatalog(settings, cache, requireSource(source))
      return catalog.find((item) => item.id === requireId(id))
    },
  }

  return market
}

/** Content type of one icon path, by extension. */
function contentTypeFor(name) {
  const ext = name.split('.').pop().toLowerCase()
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'ico') return 'image/x-icon'
  return 'image/jpeg'
}

/**
 * Serve the panel's JSON routes on one DSH webServer.
 * @param {import('@deepseek-ai/dsh-host-webserver').WebServer} webServer
 * @param {ReturnType<typeof createMarket>} market
 * @param settings - resolved deployment settings.
 * @returns dispose function
 */
function registerMarketApi(webServer, market, settings) {
  const disposers = []

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1 << 20) {
          reject(new Error('request body too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })

  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${API_BASE}/search`,
    handler: async (req, res) => {
      try {
        if (!settings.stateDir) throw new Error('no state directory; set stateDir or DSH_HOME')
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const limitRaw = Number(url.searchParams.get('limit'))
        const page = await market.searchDetail({
          source: url.searchParams.get('source') ?? undefined,
          query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? '',
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
        })
        json(res, 200, { ok: true, ...page })
      } catch (error) {
        json(res, 400, { ok: false, error: error.message })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${API_BASE}/icon`,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const found = await market.icon(
        url.searchParams.get('source') ?? '',
        url.searchParams.get('id') ?? '',
      )
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('no icon')
        return
      }
      res.writeHead(200, {
        'Content-Type': found.contentType,
        'Cache-Control': 'public, max-age=86400',
      })
      res.end(found.bytes)
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/installed`,
    handler: async (_req, res) => {
      try {
        if (!settings.stateDir) throw new Error('no state directory; set stateDir or DSH_HOME')
        const records = await readInstalled(settings.stateDir)
        const entries = Object.values(records).map((record) => ({
          ...detailEntry(record),
          skills: record.skills ?? [],
          commands: record.commands ?? [],
          hooks: record.hooks === true,
          servers: record.servers ?? [],
        }))
        json(res, 200, { ok: true, entries, total: entries.length })
      } catch (error) {
        json(res, 400, { ok: false, error: error.message })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/install`,
    handler: async (req, res) => {
      try {
        if (!settings.stateDir) throw new Error('no state directory; set stateDir or DSH_HOME')
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await market.install({ source: body.source, id: body.id })
        json(res, 200, { ok: true, result })
      } catch (error) {
        json(res, 400, { ok: false, error: error.message })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_BASE}/remove`,
    handler: async (req, res) => {
      try {
        if (!settings.stateDir) throw new Error('no state directory; set stateDir or DSH_HOME')
        const body = JSON.parse((await readBody(req)) || '{}')
        json(res, 200, { ok: true, ...(await market.remove({ id: body.id })) })
      } catch (error) {
        json(res, 400, { ok: false, error: error.message })
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* a route the server already dropped */
      }
    }
  }
}

/**
 * Copy skills into the scanned directory, register commands, and start hooks
 * and MCP servers. Returns the public record of what went live.
 */
export async function activatePlugin(ctx, settings, running, id, pluginDir, files, commandsRef = { current: undefined }) {
  await stopRuntime(running, id)
  const root = pluginContentRoot(pluginDir, files)
  const selected = packageSkillFiles(Object.keys(files))
  const skillFiles = {}
  for (const item of selected) skillFiles[item.to] = files[item.from]
  const skills = await writeBundles(settings.skillsDir, asBundles(id, skillFiles))

  const runtime = { commands: [], hooks: false, servers: [], skipped: [] }
  const disposers = []

  for (const [relative, content] of Object.entries(files)) {
    const normalised = relative.replace(/\\/g, '/')
    if (!/(^|\/)commands\/[^/]+\.md$/.test(normalised)) continue
    const command = parseCommandFile(textOf(content), normalised.split('/').pop().replace(/\.md$/, ''))
    if (!command) {
      runtime.skipped.push(`${normalised}: not a legal command file`)
      continue
    }
    try {
      const registered = registerCommand(commandsRef, command)
      if (!registered) {
        runtime.skipped.push(`/${command.name}: this profile has no command registry`)
        continue
      }
      disposers.push(registered)
      runtime.commands.push(command.name)
    } catch (error) {
      runtime.skipped.push(`/${command.name}: ${error.message}`)
    }
  }

  const hooksPath = Object.keys(files).find((relative) => /(^|\/)hooks\/hooks\.json$/.test(relative))
  if (hooksPath) {
    const rewritten = pluginHooksDocument(JSON.parse(textOf(files[hooksPath])), root)
    if (rewritten.missing.length > 0) {
      runtime.skipped.push(`hooks: unresolved ${rewritten.missing.join(', ')}`)
    } else if (hasHooks(rewritten.document)) {
      const started = await startHooks(ctx, root, rewritten.document)
      if (started.ok) {
        disposers.push(() => started.fiber.dispose?.())
        runtime.hooks = true
      } else {
        runtime.skipped.push(`hooks: ${started.reason}`)
      }
    }
  }

  const manifestPath = Object.keys(files).find((relative) => relative.replace(/\\/g, '/').endsWith('plugin.json'))
  if (manifestPath) {
    const manifest = JSON.parse(textOf(files[manifestPath]))
    const servers = manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {}
    const vars = {
      CLAUDE_PLUGIN_ROOT: root,
      ZCODE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: root,
      ZCODE_PLUGIN_DATA: root,
      // ZCode runs plugin servers from the open project; a DSH profile has no
      // single project, so the plugin root stands in — the cwd rarely matters
      // for a server that resolves its own assets relatively.
      ZCODE_PROJECT_DIR: root,
      CLAUDE_PROJECT_DIR: root,
    }
    for (const [key, server] of Object.entries(servers)) {
      const mapped = pluginMcpConfig(id, key, server, vars)
      if (!mapped.ok) {
        runtime.skipped.push(`${key}: ${mapped.reason}`)
        continue
      }
      const started = await startMcp(ctx, mapped.config)
      if (started.ok) {
        disposers.push(() => started.fiber.dispose?.())
        runtime.servers.push(mapped.config.serverName)
      } else {
        runtime.skipped.push(`${key}: ${started.reason}`)
      }
    }
  }

  running.set(id, { disposers })
  return {
    skills,
    commands: runtime.commands,
    hooks: runtime.hooks,
    servers: runtime.servers,
    skipped: runtime.skipped,
  }
}

/** The directory that contains the plugin manifest, which hooks call their root. */
function pluginContentRoot(pluginDir, files) {
  const manifest = Object.keys(files)
    .map((relative) => relative.replace(/\\/g, '/'))
    .find((relative) => relative.endsWith('.zcode-plugin/plugin.json') || relative.endsWith('.claude-plugin/plugin.json'))
  if (!manifest) return pluginDir
  const parts = manifest.split('/')
  const marker = Math.max(parts.lastIndexOf('.zcode-plugin'), parts.lastIndexOf('.claude-plugin'))
  const prefix = parts.slice(0, marker).join('/')
  return prefix ? join(pluginDir, prefix) : pluginDir
}

/** Register one slash command against the captured registry, when the host has one. */
function registerCommand(commandsRef, command) {
  const commands = commandsRef?.current
  if (!commands || typeof commands.register !== 'function') return undefined
  return commands.register({
    name: command.name,
    description: command.description,
    input: command.argumentHint ? { hint: command.argumentHint } : undefined,
    handler(invocation) {
      const agent = invocation?.agent
      if (!agent || typeof agent.followup !== 'function') {
        return { kind: 'error', text: `/${command.name} has no agent to run in` }
      }
      const text = [command.prompt, invocation.rawInput?.trim()].filter(Boolean).join('\n\n')
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      return { kind: 'success', text: `/${command.name} submitted` }
    },
  })
}

async function startHooks(ctx, pluginDir, document) {
  let plugin
  try {
    plugin = await importFromHost('@deepseek-ai/dsh-hooks-claude-code')
  } catch (error) {
    return { ok: false, reason: `@deepseek-ai/dsh-hooks-claude-code is not installed (${error.message})` }
  }
  const hooksFile = join(pluginDir, 'hooks', 'hooks.json')
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(join(pluginDir, 'hooks'), { recursive: true })
  await writeFile(hooksFile, `${JSON.stringify(document, null, 2)}\n`)
  try {
    const fiber = ctx.plugin(plugin, { configPath: hooksFile, pluginRoot: pluginDir })
    await fiber
    return { ok: true, fiber }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

async function startMcp(ctx, config) {
  let plugin
  try {
    plugin = await importFromHost('@deepseek-ai/dsh-mcp-client')
  } catch (error) {
    return { ok: false, reason: `@deepseek-ai/dsh-mcp-client is not installed (${error.message})` }
  }
  try {
    const fiber = ctx.plugin(plugin, config)
    await fiber
    return { ok: true, fiber }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/**
 * Import a package that ships inside the `dsh` install.
 *
 * A profile's node_modules only contains what that profile added, while the
 * hook bridge and the MCP client are dependencies of the `dsh` package itself.
 * Resolving them from this plugin's own import would miss both.
 */
async function importFromHost(specifier) {
  const require = createRequire(process.argv[1] ?? import.meta.url)
  const resolved = require.resolve(specifier)
  return import(pathToFileURL(resolved).href)
}

async function restoreInstalled(ctx, settings, market) {
  const records = await readInstalled(settings.stateDir)
  for (const record of Object.values(records)) {
    if (record.source !== 'zcode') continue
    try {
      const tree = await readPluginTree(join(settings.pluginsDir, record.id))
      await activatePlugin(ctx, settings, market.running, record.id, join(settings.pluginsDir, record.id), tree, market.commandsRef)
    } catch (error) {
      ctx.logger?.warn?.(`skill_market: restoring ${record.id} failed: ${error.message}`)
    }
  }
}

async function readPluginTree(dir) {
  const { readdir, readFile } = await import('node:fs/promises')
  const files = {}
  const walk = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(current, entry.name), relative)
      else files[relative] = await readFile(join(current, entry.name))
    }
  }
  await walk(dir, '')
  return files
}

async function stopRuntime(running, id) {
  const runtime = running.get(id)
  if (!runtime) return
  running.delete(id)
  for (const dispose of runtime.disposers) {
    try {
      await dispose()
    } catch {
      /* a command or server that already left */
    }
  }
}

async function workbuddySkillFiles(settings, cache, entry) {
  const archive = await skillArchive(settings, cache)
  const tree = readZipTree(archive, `skills/${entry.id}/`)
  const files = {}
  for (const [relative, bytes] of Object.entries(tree)) files[relative] = bytes
  if (!files['SKILL.md']) throw new Error(`skill_market: ${entry.id} has no SKILL.md in the marketplace zip`)
  const generated = skillDocument({
    id: entry.id,
    title: entry.name,
    description: entry.description,
    original: textOf(files['SKILL.md']),
  })
  if (generated.markdown !== textOf(files['SKILL.md'])) {
    delete files['SKILL.md']
    files[`${generated.fileName}/SKILL.md`] = generated.markdown
  }
  return files
}

async function loadCatalog(settings, cache, source) {
  if (source === 'zcode') {
    const bytes = await cachedBytes(cache, settings.zcodeMarketplaceUrl, settings.requestTimeoutMs)
    return parseZcodeMarketplace(JSON.parse(decodeText(bytes)))
  }
  const text = readZipText(await skillArchive(settings, cache), '.codebuddy-skill/marketplace.json')
  if (!text) throw new Error('skill_market: the WorkBuddy skill zip has no marketplace.json')
  return parseWorkbuddySkills(JSON.parse(text))
}

async function skillArchive(settings, cache) {
  return cachedBytes(cache, settings.workbuddySkillZipUrl, settings.requestTimeoutMs)
}

async function cachedBytes(cache, url, timeoutMs) {
  if (!cache.has(url)) cache.set(url, fetchBytes(url, timeoutMs))
  return cache.get(url)
}

function requireSource(source) {
  if (!SOURCES.includes(source)) throw new Error(`skill_market: source must be one of ${SOURCES.join(', ')}`)
  return source
}

function requireId(id) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('skill_market: id is required')
  if (id.includes('/') || id.includes('\\') || id.includes('..')) throw new Error(`skill_market: refusing id "${id}"`)
  return id.trim()
}

async function remember(settings, entry, extra) {
  const records = await readInstalled(settings.stateDir)
  records[entry.id] = { ...publicEntry(entry), ...extra, installedAt: new Date().toISOString() }
  await writeInstalled(settings.stateDir, records)
}

function publicEntry(entry) {
  return {
    source: entry.source,
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.version || undefined,
    category: entry.category || undefined,
    installable: entry.installable === true,
    reason: entry.reason || undefined,
  }
}

function activationMessage(id, activated) {
  const parts = [`installed ${id}`]
  if (activated.skills.length) parts.push(`skills: ${activated.skills.join(', ')}`)
  if (activated.commands.length) parts.push(`commands: ${activated.commands.map((item) => '/' + item).join(', ')}`)
  if (activated.hooks) parts.push('hooks running in the agent loop')
  if (activated.servers.length) parts.push(`MCP: ${activated.servers.join(', ')}`)
  if (activated.skipped.length) parts.push(`skipped: ${activated.skipped.join('; ')}`)
  return parts.join('. ')
}

/** Catalog bytes arrive as Uint8Array; a fixture may pass a string. */
function textOf(content) {
  return typeof content === 'string' ? content : decodeText(content)
}

/** One-line account of a tool result, for the transcript. */
export function renderResult(value) {
  if (!value || typeof value !== 'object') return String(value)
  const lines = [value.message || value.op]
  for (const entry of value.entries ?? []) {
    const flag = entry.installable ? 'installable' : 'listed only'
    lines.push(`- ${entry.source} ${entry.id}: ${entry.name} (${flag})`)
  }
  return lines.join('\n')
}
