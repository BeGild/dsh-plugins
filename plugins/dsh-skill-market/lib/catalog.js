/**
 * Pure catalog, install-plan, and connector-mapping helpers.
 *
 * Nothing here touches the network, the filesystem, or Cordis. The plugin
 * entry fetches bytes and writes files; this module decides what those bytes
 * mean and what a safe install looks like.
 *
 * @module dsh-skill-market/catalog
 */

/** Sources `skill_market` accepts. */
export const SOURCES = ['zcode', 'workbuddy-skill']

/** Kinds one catalog entry can have. */
export const KINDS = ['skill', 'plugin']

/** Operations the one tool accepts. */
export const OPS = ['sources', 'search', 'install', 'remove', 'installed']

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g

/** Default public catalogs. Every one is a Config field so a deployment can retarget it. */
export const DEFAULTS = {
  stateDir: '',
  zcodeMarketplaceUrl: 'https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json',
  workbuddySkillZipUrl:
    'https://download.codebuddy.cn/skill-marketplace/skill-marketplace-66396a74-7070-456a-8be0-f05ae0cbb466.zip',
  requestTimeoutMs: 60_000,
  maxResults: 30,
  autoConnect: true,
}

/**
 * Resolve config against {@link DEFAULTS}. An empty `stateDir` means "ask the
 * host for $DSH_HOME at call time"; the caller passes that in.
 * @param {Partial<typeof DEFAULTS>} config
 * @param {string} dshHome
 */
export function resolveSettings(config, dshHome) {
  const home = (dshHome || '').replace(/[\\/]+$/, '')
  const stateDir = text(config?.stateDir) || (home ? joinPath(home, 'skill-market') : '')
  return {
    stateDir,
    // The default skill provider scans <dshHome>/skills one level deep, so an
    // installed bundle has to land there to be usable without a profile edit.
    skillsDir: text(config?.skillsDir) || (home ? joinPath(home, 'skills') : ''),
    pluginsDir: stateDir ? joinPath(stateDir, 'plugins') : '',
    zcodeMarketplaceUrl: text(config?.zcodeMarketplaceUrl) || DEFAULTS.zcodeMarketplaceUrl,
    workbuddySkillZipUrl: text(config?.workbuddySkillZipUrl) || DEFAULTS.workbuddySkillZipUrl,
    requestTimeoutMs: positiveInt(config?.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    maxResults: positiveInt(config?.maxResults, DEFAULTS.maxResults),
    autoConnect: config?.autoConnect !== false,
  }
}

/** Join with forward slashes, then let the host normalise. */
function joinPath(left, right) {
  return `${left.replace(/[\\/]+$/, '')}/${right.replace(/^[\\/]+/, '')}`
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.trunc(value)
}

/** True when DSH's skill provider will accept this name. */
export function isSkillName(name) {
  return SKILL_NAME.test(name)
}

/**
 * Project one ZCode `mcpServers` record onto a dsh-mcp-client config.
 *
 * A server that needs a ZCode login (`auth.type` of `zcode_official`, or a URL
 * built from `${ZCODE_BASE_URL}`) cannot be reached from DSH and is refused.
 * `${CLAUDE_PLUGIN_ROOT}`-style placeholders in a command are substituted from
 * `vars`; an unknown placeholder refuses the server rather than launching a
 * broken command.
 *
 * @param {string} id plugin id, prefixed onto the server name to stay unique.
 * @param {string} serverKey the key inside `mcpServers`.
 * @param {object} server the server record.
 * @param {Record<string, string>} vars placeholder values such as CLAUDE_PLUGIN_ROOT.
 */
export function pluginMcpConfig(id, serverKey, server, vars) {
  if (!server || typeof server !== 'object') return { ok: false, reason: 'empty MCP server record' }
  const auth = server.auth?.type || server.auth
  if (typeof auth === 'string' && auth && auth !== 'none') {
    return { ok: false, reason: `authentication "${auth}" is issued by ZCode, not by DSH` }
  }
  if (/zcode-plugin-host|ZCode\.exe/i.test(text(server.command))) {
    return { ok: false, reason: 'this server runs inside the ZCode process and has no standalone entry' }
  }
  const serverName = serverNameFor(`${id}-${serverKey}`)
  if (!serverName) return { ok: false, reason: `server name "${serverKey}" is not a legal MCP namespace` }

  const { value, missing } = fillPlaceholders(server, vars)
  if (missing.length > 0) return { ok: false, reason: 'unresolved placeholder', missing }

  const type = String(value.type || '').toLowerCase()
  const command = text(value.command)
  const url = text(value.url)
  const timeout = positiveInt(value.timeout ?? value.timeoutMs, 0)

  if (url && !command) {
    const config = { transport: 'streamable-http', serverName, url, headers: stringRecord(value.headers) }
    if (timeout > 0) config.toolCallTimeoutMs = timeout
    return { ok: true, config }
  }
  if (!command || (type && type !== 'stdio')) {
    return { ok: false, reason: `unsupported MCP transport "${value.type || 'unknown'}"` }
  }
  const config = {
    transport: 'stdio',
    serverName,
    command,
    args: Array.isArray(value.args) ? value.args.map(String) : [],
    env: stringRecord(value.env),
  }
  if (text(value.cwd)) config.cwd = text(value.cwd)
  if (timeout > 0) config.toolCallTimeoutMs = timeout
  return { ok: true, config }
}

/**
 * The Claude Code hooks.json written for one installed plugin.
 * ZCode hooks are Claude Code command hooks with `${CLAUDE_PLUGIN_ROOT}`
 * already rewritten to the installed directory, which is what
 * `dsh-hooks-claude-code` runs inside the agent loop.
 */
export function pluginHooksDocument(hooksJson, pluginRoot) {
  const document = hooksJson && typeof hooksJson === 'object' ? structuredClone(hooksJson) : { hooks: {} }
  const rewritten = fillPlaceholders(document, {
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    ZCODE_PLUGIN_ROOT: pluginRoot,
  })
  return { document: rewritten.value, missing: rewritten.missing }
}

/** True when a hooks document declares at least one hook. */
export function hasHooks(document) {
  const groups = document?.hooks ?? document
  if (!groups || typeof groups !== 'object') return false
  return Object.values(groups).some((group) => Array.isArray(group) && group.length > 0)
}

/**
 * One slash command from a ZCode/Claude command markdown file.
 * The body becomes the prompt a `/name` invocation submits to the agent.
 */
export function parseCommandFile(markdown, fallbackName) {
  if (typeof markdown !== 'string') return undefined
  const data = parseFlatYaml(frontmatterOf(markdown))
  const description = unquote(data.description)
  if (!description) return undefined
  const declared = unquote(data.name)
  const name = isSkillName(declared) ? declared : serverNameFor(fallbackName).toLowerCase()
  if (!isSkillName(name)) return undefined
  const body = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/\$ARGUMENTS/g, '')
    .trim()
  return {
    name,
    description,
    argumentHint: unquote(data['argument-hint'] || ''),
    prompt: body || description,
  }
}

/** A catalog id that is also a legal mcp-client serverName. */
export function serverNameFor(id) {
  const raw = String(id || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return SERVER_NAME.test(raw) ? raw : ''
}

/** `${NAME}` placeholders inside one connector document. */
export function placeholdersOf(value) {
  const found = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(PLACEHOLDER)) found.add(match[1])
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item)
    } else if (node && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item)
    }
  }
  walk(value)
  return [...found]
}

/** Substitute `${NAME}` from a secret map. Unresolved placeholders stay put. */
export function fillPlaceholders(value, secrets) {
  const missing = new Set()
  const replace = (input) =>
    input.replace(PLACEHOLDER, (whole, name) => {
      const secret = secrets?.[name]
      if (typeof secret !== 'string' || secret.length === 0) {
        missing.add(name)
        return whole
      }
      return secret
    })
  const walk = (node) => {
    if (typeof node === 'string') return replace(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(node)) out[key] = walk(item)
      return out
    }
    return node
  }
  return { value: walk(value), missing: [...missing] }
}

/**
 * Project one WorkBuddy `mcp.json` server record onto a dsh-mcp-client config.
 *
 * Returns `{ ok: false, reason }` when the record cannot be a live DSH server:
 * an unresolved secret, a URL that is itself a placeholder, or a transport
 * dsh-mcp-client does not implement. Legacy SSE is attempted as Streamable
 * HTTP and reported as such; the connect step says so when the server refuses.
 *
 * @param {string} id connector id, used as the server namespace.
 * @param {object} server one `mcpServers` value.
 * @param {Record<string, string>} secrets saved connector secrets.
 */
export function toMcpConfig(id, server, secrets) {
  const serverName = serverNameFor(id)
  if (!serverName) return { ok: false, reason: `connector id "${id}" is not a legal MCP server name` }
  if (!server || typeof server !== 'object') return { ok: false, reason: 'mcp.json has no server record' }

  const { value, missing } = fillPlaceholders(server, secrets)
  if (missing.length > 0) {
    return { ok: false, reason: 'missing secrets', missing }
  }

  const type = String(value.type || '').toLowerCase()
  const command = text(value.command)
  const url = text(value.url)
  const timeout = positiveInt(value.timeout, 0)

  if (command && (type === '' || type === 'stdio')) {
    const config = {
      transport: 'stdio',
      serverName,
      command,
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      env: stringRecord(value.env),
    }
    if (text(value.cwd)) config.cwd = text(value.cwd)
    if (timeout > 0) config.toolCallTimeoutMs = timeout
    return { ok: true, config, adapted: false }
  }

  if (!url) return { ok: false, reason: `unsupported MCP transport "${value.type || 'unknown'}"` }
  if (PLACEHOLDER.test(url)) return { ok: false, reason: 'the endpoint URL still contains a placeholder' }

  const httpTypes = new Set(['', 'http', 'streamablehttp', 'streamable-http', 'sse', 'url'])
  if (!httpTypes.has(type)) {
    return { ok: false, reason: `unsupported MCP transport "${value.type}"` }
  }
  const config = {
    transport: 'streamable-http',
    serverName,
    url,
    headers: stringRecord(value.headers),
  }
  if (timeout > 0) config.toolCallTimeoutMs = timeout
  return { ok: true, config, adapted: type === 'sse' }
}

function stringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/** First server record of a WorkBuddy mcp.json, plus its key. */
export function firstServer(document) {
  const servers = document?.mcpServers
  if (!servers || typeof servers !== 'object') return undefined
  const key = Object.keys(servers)[0]
  if (!key) return undefined
  return { key, server: servers[key] }
}

/** The YAML block between the opening fences, or ''. */
function frontmatterOf(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(typeof markdown === 'string' ? markdown : '')
  return match ? match[1] : ''
}

/** Parse a SKILL.md into `{ name, description, body }`, or undefined. */
export function parseSkillFile(markdown) {
  if (typeof markdown !== 'string') return undefined
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown.trimStart())
  if (!match) return undefined
  const data = parseFlatYaml(match[1])
  const name = unquote(data.name)
  const description = unquote(data.description)
  if (!name || !description) return undefined
  return { name, description, body: markdown.slice(match[0].length) }
}

/**
 * A tiny YAML reader for the flat frontmatter DSH itself accepts.
 * Handles `key: value`, quoted values, and one level of block scalars is
 * deliberately not attempted: a skill DSH would reject is rejected here too.
 */
function parseFlatYaml(text) {
  const data = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const split = line.indexOf(':')
    if (split <= 0) continue
    const key = line.slice(0, split).trim()
    const value = line.slice(split + 1).trim()
    if (value === '' || value === '|' || value === '>') continue
    data[key] = value
  }
  return data
}

function unquote(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Normalise one ZCode marketplace.json into catalog entries. */
export function parseZcodeMarketplace(document) {
  const plugins = Array.isArray(document?.plugins) ? document.plugins : []
  const entries = []
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string') continue
    const source = plugin.source
    const zip = source && typeof source === 'object' && source.type === 'zip' ? text(source.url) : ''
    entries.push({
      source: 'zcode',
      kind: 'plugin',
      id: plugin.name,
      name: text(plugin.displayName) || plugin.name,
      description: text(plugin.description_i18n?.['zh-CN']) || text(plugin.description),
      version: text(plugin.version),
      category: text(plugin.category),
      installable: zip.length > 0,
      components: ['skills', 'commands', 'hooks', 'mcp'],
      reason: zip ? '' : 'built into the ZCode client; there is no package to download',
      downloadUrl: zip,
      sha256: zip ? text(source.sha256) : '',
      requiresPaidPlan: plugin.requiresPaidPlan === true,
      icon: text(plugin.icon),
      author: text(plugin.author?.name),
      keywords: Array.isArray(plugin.keywords) ? plugin.keywords.map(text).filter(Boolean) : [],
    })
  }
  return entries
}

/** Normalise a WorkBuddy skill marketplace.json. `source` is the directory name. */
export function parseWorkbuddySkills(document) {
  const skills = Array.isArray(document?.skills) ? document.skills : []
  const entries = []
  for (const skill of skills) {
    const id = text(skill?.source)
    if (!id) continue
    entries.push({
      source: 'workbuddy-skill',
      kind: 'skill',
      id,
      name: text(skill.name) || id,
      description: text(skill.description_zh) || text(skill.description),
      version: text(skill.version),
      category: Array.isArray(skill.tags_zh) ? skill.tags_zh.join(', ') : '',
      installable: true,
      reason: '',
      examples: Array.isArray(skill.examples_zh) ? skill.examples_zh.map(text).filter(Boolean) : [],
      keywords: Array.isArray(skill.tags_en) ? skill.tags_en.map(text).filter(Boolean) : [],
    })
  }
  return entries
}

/**
 * The API entry the panel renders: the public fields plus the icon
 * availability and the explanation fields (author, keywords, examples) the
 * detail view shows. The model tool keeps the compact publicEntry form —
 * its output schema sits in the request prefix.
 * @param {object} entry - one catalog entry.
 */
export function detailEntry(entry) {
  const base = {
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
  return {
    ...base,
    hasIcon: entry.source === 'zcode' ? Boolean(entry.icon) : true,
    author: entry.author || undefined,
    keywords: entry.keywords?.length ? entry.keywords : undefined,
    examples: entry.examples?.length ? entry.examples : undefined,
  }
}

/** Case-insensitive search over id, name, description, and category. */
export function searchEntries(entries, query, limit) {
  const needle = text(query).toLowerCase()
  const matched = needle
    ? entries.filter((entry) =>
        [entry.id, entry.name, entry.description, entry.category]
          .join('\n')
          .toLowerCase()
          .includes(needle),
      )
    : entries
  const cap = positiveInt(limit, matched.length || 1)
  return { entries: matched.slice(0, cap), total: matched.length, truncated: matched.length > cap }
}

/**
 * The SKILL.md written for one install.
 *
 * ZCode and WorkBuddy packages keep their own file when it is already a legal
 * DSH skill. An expert, or a package whose frontmatter DSH would reject, gets
 * a generated file so the install still shows up in the session catalog.
 */
export function skillDocument({ id, title, description, original }) {
  const parsed = original ? parseSkillFile(original) : undefined
  if (parsed && isSkillName(parsed.name)) return { fileName: parsed.name, markdown: original }
  const name = isSkillName(id) ? id : serverNameFor(id).toLowerCase()
  if (!isSkillName(name)) {
    throw new Error(`cannot install "${id}": its name is not a legal DSH skill name`)
  }
  const safeDescription = (description || title || name).replace(/\s+/g, ' ').trim()
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${yamlQuote(safeDescription)}`,
    '---',
    '',
    `# ${title || name}`,
    '',
  ]
  if (parsed?.body) lines.push(parsed.body.trim(), '')
  else lines.push(safeDescription, '')
  return { fileName: name, markdown: lines.join('\n') }
}

function yamlQuote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Make every file sit inside a `<name>/...` bundle.
 * A package that already ships `name/SKILL.md` is kept; a loose `SKILL.md`
 * is placed under `fallback`.
 */
export function asBundles(fallback, files) {
  const bundled = {}
  for (const [relative, content] of Object.entries(files)) {
    const normalised = String(relative).replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalised || normalised.split('/').includes('..')) {
      throw new Error(`refusing package path "${relative}"`)
    }
    bundled[normalised.includes('/') ? normalised : `${fallback}/${normalised}`] = content
  }
  return bundled
}

/** Top-level bundle directories an install wrote, so removal deletes only those. */
export function bundleRoots(files) {
  return [...new Set(Object.keys(files).map((relative) => relative.split('/')[0]))]
}

/**
 * Files inside one downloaded package that belong in the installed skill directory.
 * ZCode packages nest them at `<plugin>/skills/<name>/...`; a package that
 * already starts at `skills/` is accepted too. Anything else is left behind,
 * because hooks and commands have no runtime here.
 */
export function packageSkillFiles(paths) {
  const selected = []
  for (const filePath of paths) {
    const normalised = filePath.replace(/\\/g, '/')
    const parts = normalised.split('/')
    if (normalised.endsWith('/') || parts.includes('..')) continue
    const at = parts.lastIndexOf('skills')
    if (at < 0 || at === parts.length - 1) continue
    selected.push({ from: filePath, to: parts.slice(at + 1).join('/') })
  }
  return selected
}
