/**
 * dsh-skill-market tests. Run with: node test/market.test.mjs
 *
 * Catalog parsing, connector mapping, and the zip reader are exercised on
 * fixtures. One test installs a real WorkBuddy skill into a temp directory
 * and removes it, so the download path is covered without touching ~/.dsh.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import {
  detailEntry,
  hasHooks,
  isSkillName,
  packageSkillFiles,
  parseCommandFile,
  parseWorkbuddySkills,
  parseZcodeMarketplace,
  pluginHooksDocument,
  pluginMcpConfig,
  resolveSettings,
  searchEntries,
  skillDocument,
} from '../lib/catalog.js'
import { activatePlugin } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(HERE, '..')

/** Load lib/client.js the way the browser loader does: register the factory. */
async function loadClientBundle() {
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) { registrations.push(registration) },
    },
  }
  try {
    await import(`file://${join(ROOT_DIR, 'lib', 'client.js').replace(/\\/g, '/')}?t=${Date.now()}`)
  } finally {
    delete globalThis.window
  }
  return registrations
}

import { listZip, readZipText } from '../lib/fetch.js'
import { removeBundles, safeChild, writeBundles } from '../lib/store.js'

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

function crc32(bytes) {
  let crc = -1
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ -1) >>> 0
}

/** A one-entry stored or deflated zip, enough for the reader. */
function zipWith(name, content, method) {
  const data = Buffer.from(content)
  const payload = method === 8 ? deflateRawSync(data) : data
  const nameBytes = Buffer.from(name)
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(46 + nameBytes.length, 12)
  end.writeUInt32LE(30 + nameBytes.length + payload.length, 16)
  return Buffer.concat([local, nameBytes, payload, central, nameBytes, end])
}

console.log('dsh-skill-market tests\n')

await test('settings fall back to the public catalogs and the dsh skill root', () => {
  const settings = resolveSettings({}, 'C:/Users/me/.dsh')
  assert.equal(settings.skillsDir, 'C:/Users/me/.dsh/skills')
  assert.equal(settings.stateDir, 'C:/Users/me/.dsh/skill-market')
  assert.match(settings.zcodeMarketplaceUrl, /^https:\/\/cdn-zcode\.z\.ai\//)
  assert.equal(settings.autoConnect, true)
})

await test('a zcode marketplace separates downloadable plugins from built-ins', () => {
  const entries = parseZcodeMarketplace({
    plugins: [
      { name: 'github', version: '0.1.2', description: 'GitHub workflows.', source: { type: 'zip', url: 'https://cdn/github.zip', sha256: 'abc' }, icon: 'https://cdn/icon.png', author: { name: 'Z.ai' }, keywords: ['git'] },
      { name: 'browser-use', description: 'Built in.', source: 'filesystem' },
    ],
  })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].installable, true)
  assert.equal(entries[0].downloadUrl, 'https://cdn/github.zip')
  assert.equal(entries[0].icon, 'https://cdn/icon.png')
  assert.deepEqual(entries[0].keywords, ['git'])
  assert.equal(entries[0].author, 'Z.ai')
  assert.equal(entries[1].installable, false)
  assert.match(entries[1].reason, /built into/)
})

await test('a plugin MCP server maps to stdio and a ZCode-hosted server is refused', () => {
  const mapped = pluginMcpConfig(
    'github',
    'remote',
    { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { PORT: '1' } },
    { CLAUDE_PLUGIN_ROOT: '/plugins/github' },
  )
  assert.equal(mapped.ok, true)
  assert.equal(mapped.config.transport, 'stdio')
  assert.deepEqual(mapped.config.args, ['/plugins/github/server.js'])
  assert.equal(mapped.config.serverName, 'github-remote')

  const hosted = pluginMcpConfig('app', 'image', { command: 'ZCode.exe', args: ['__zcode-plugin-host'] }, {})
  assert.equal(hosted.ok, false)
  assert.match(hosted.reason, /ZCode process/)

  const authed = pluginMcpConfig('app', 'search', { url: 'https://example/mcp', auth: { type: 'zcode_official' } }, {})
  assert.equal(authed.ok, false)
  assert.match(authed.reason, /ZCode/)
})

await test('hooks are rewritten to the installed directory and empty hooks are ignored', () => {
  const rewritten = pluginHooksDocument(
    { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run.cmd"' }] }] } },
    '/opt/plugins/superpowers',
  )
  assert.equal(rewritten.missing.length, 0)
  assert.equal(hasHooks(rewritten.document), true)
  assert.match(JSON.stringify(rewritten.document), /\/opt\/plugins\/superpowers\/hooks\/run\.cmd/)
  assert.equal(hasHooks({ hooks: {} }), false)
})

await test('a process-style ZCode hook is folded into a command string', () => {
  const rewritten = pluginHooksDocument(
    { hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [
      { type: 'process', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/run.cjs', 'scan.mjs', 'two words'] },
    ] }] } },
    '/opt/p',
  )
  const hook = rewritten.document.hooks.PreToolUse[0].hooks[0]
  assert.equal(hook.type, 'command')
  assert.equal(hook.args, undefined)
  assert.equal(hook.command, 'node /opt/p/hooks/run.cjs scan.mjs "two words"')
})

await test('a command file becomes a slash command whose body is the prompt', () => {
  const command = parseCommandFile(
    '---\ndescription: Start the loop.\nargument-hint: "[goal]"\n---\n\nUse the skill.\n\n$ARGUMENTS\n',
    'android-dev',
  )
  assert.equal(command.name, 'android-dev')
  assert.equal(command.argumentHint, '[goal]')
  assert.equal(command.prompt, 'Use the skill.')
  assert.equal(isSkillName('Not A Name'), false)
})

await test('a package skill with a legal frontmatter is kept verbatim', () => {
  const original = '---\nname: travel-cn\ndescription: 旅行信息查询\n---\n\n# 正文\n'
  const document = skillDocument({ id: 'travel-cn', title: '旅行', description: '别的', original })
  assert.equal(document.markdown, original)
})

await test('search matches the description and reports truncation', () => {
  const entries = parseWorkbuddySkills({ skills: [
    { source: 'travel-cn', name: '旅行', description_zh: '机票酒店', version: '1.0.2', examples_zh: ['查机票'], tags_en: ['travel'] },
    { source: 'other', name: '其他', description_zh: '无关' },
  ] })
  assert.deepEqual(entries[0].examples, ['查机票'])
  assert.deepEqual(entries[0].keywords, ['travel'])
  const detail = detailEntry(entries[0])
  assert.equal(detail.hasIcon, true)
  assert.equal(detail.examples[0], '查机票')
  const page = searchEntries(entries, '机票', 1)
  assert.equal(page.total, 1)
  assert.equal(page.entries[0].id, 'travel-cn')
  const all = searchEntries(entries, '', 1)
  assert.equal(all.truncated, true)
  assert.equal(all.total, 2)
})

await test('the zip reader handles a deflated entry and package paths stay inside skills/', () => {
  const archive = zipWith('skills/demo/SKILL.md', '---\nname: demo\n', 8)
  const entries = listZip(archive)
  assert.equal(entries.length, 1)
  assert.equal(readZipText(archive, 'skills/demo/SKILL.md'), '---\nname: demo\n')
  assert.deepEqual(
    packageSkillFiles(['github/skills/commit/SKILL.md', 'github/hooks/pre.mjs', 'skills/../escape']),
    [{ from: 'github/skills/commit/SKILL.md', to: 'commit/SKILL.md' }],
  )
})

await test('writing a bundle cannot escape the skill root', () => {
  assert.throws(() => safeChild('/tmp/skills', '../secrets'))
  assert.throws(() => safeChild('/tmp/skills', 'demo/../../secrets'))
})

await test('activating a plugin registers its command and submits the prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-market-'))
  const submitted = []
  const registered = []
  const ctx = {
    commands: {
      register(definition) {
        registered.push(definition)
        return () => registered.splice(registered.indexOf(definition), 1)
      },
    },
  }
  try {
    const files = {
      'demo/.zcode-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        mcpServers: { local: { command: 'node', args: ['server.js'] } },
      }),
      'demo/skills/commit/SKILL.md': '---\nname: commit\ndescription: Make a commit.\n---\n',
      'demo/commands/commit.md': '---\ndescription: Commit the work.\nargument-hint: "[message]"\n---\n\nCommit now.\n',
      'demo/hooks/hooks.json': JSON.stringify({ hooks: {} }),
    }
    const activated = await activatePlugin(
      ctx,
      { skillsDir: join(root, 'skills'), pluginsDir: join(root, 'plugins') },
      new Map(),
      'demo',
      join(root, 'plugins', 'demo'),
      files,
      { current: ctx.commands },
    )
    assert.deepEqual(activated.skills, ['commit'])
    assert.deepEqual(activated.commands, ['commit'])
    assert.equal(activated.hooks, false)
    assert.equal(activated.servers.length, 0)
    assert.match(activated.skipped[0], /local:/)

    const agent = { followup(message) { submitted.push(message) } }
    const result = registered[0].handler({ agent, rawInput: ' fix the typo' })
    assert.equal(result.kind, 'success')
    assert.match(submitted[0].content[0].text, /Commit now\.\n\nfix the typo/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('a bundle written under the skill root is removed with the record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-market-'))
  try {
    const roots = await writeBundles(root, { 'demo/SKILL.md': '---\nname: demo\ndescription: one\n---\n' })
    assert.deepEqual(roots, ['demo'])
    const text = await readFile(join(root, 'demo', 'SKILL.md'), 'utf8')
    assert.match(text, /name: demo/)
    await removeBundles(root, roots)
    await assert.rejects(readFile(join(root, 'demo', 'SKILL.md'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('the client bundle registers one factory under the package name, as a classic script', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh?.client?.platform, 'web')
  const registrations = await loadClientBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, pkg.name)
  const source = readFileSync(join(ROOT_DIR, 'lib', 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  // A classic script cannot carry module syntax; the loader would reject it.
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:import|export)\s[^\s*]/)
})

/** Stub react: the only module the client may require. */
function stubReact() {
  const h = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } })
  return Object.assign(h, {
    Fragment: 'fragment',
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  })
}

await test('the client registers matching dictionaries and both reachability slots', async () => {
  const registrations = await loadClientBundle()
  const required = []
  const exposed = registrations[0].factory((id) => {
    required.push(id)
    if (id !== 'react') throw new Error(`unexpected require("${id}")`)
    return stubReact()
  })
  assert.deepEqual(required, ['react'])
  assert.deepEqual(exposed.inject, ['slots', 'locale'])

  const seen = { locale: {}, slots: [] }
  const ctx = {
    effect(fn) { fn() },
    locale: {
      register(ns, dicts) { seen.locale[ns] = dicts },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject(seat, register) { seen.slots.push({ seat, register }) },
      register: (options, component) => ({ options, component }),
    },
  }
  exposed.apply(ctx)
  const dicts = seen.locale['skill-market']
  assert.ok(dicts, 'dictionaries registered under the plugin namespace')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())
  assert.deepEqual(seen.slots.map((entry) => entry.seat).sort(), ['main', 'sidebar.panellist'])
  for (const entry of seen.slots) {
    const { options, component } = entry.register()
    assert.equal(typeof component, 'function')
    assert.ok(options.id === 'skill-market' || options.key === 'skill-market')
  }
})

await test('the client fetches exactly the routes the host registers', async () => {
  const client = readFileSync(join(ROOT_DIR, 'lib', 'client.js'), 'utf8')
  const host = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8')
  const fetched = new Set([...client.matchAll(/\$\{BASE\}\/(\w+)/g)].map((m) => m[1]))
  const served = new Set([...host.matchAll(/API_BASE}\/(\w+)/g)].map((m) => m[1]))
  assert.deepEqual(fetched, served)
  assert.deepEqual([...fetched].sort(), ['icon', 'install', 'installed', 'remove', 'search'])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
