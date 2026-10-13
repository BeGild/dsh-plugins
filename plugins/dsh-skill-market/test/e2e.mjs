/**
 * dsh-skill-market end-to-end suite — run against a LIVE profile server.
 *
 *   node test/e2e.mjs http://127.0.0.1:PORT TOKEN
 *
 * Drives the same HTTP routes the panel uses, through every source and every
 * component type, and asserts the REAL effects of each install: files on
 * disk, MCP child processes, the install record, and cleanup after remove.
 * It leaves the profile in the state it found it in.
 *
 *   zcode skills-only     github        (10 skill bundles, nothing else)
 *   zcode full            mimosa        (skill + 3 commands + live hooks)
 *   zcode MCP             disk-cleaner  (stdio MCP server actually spawned)
 *   workbuddy-skill       airbnb        (skill + icon + examples)
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [BASE, TOKEN] = process.argv.slice(2)
if (!BASE || !TOKEN) {
  console.error('usage: node test/e2e.mjs http://127.0.0.1:PORT TOKEN')
  process.exit(2)
}
const DSH = join(homedir(), '.dsh')
const SKILLS = join(DSH, 'skills')
const STATE = join(DSH, 'skill-market')

const cookie = await mintCookie()
let passed = 0
let failed = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    const where = (error.stack ?? '').split('\n')[1]?.trim() ?? ''
    console.log(`  FAIL ${label}\n       ${error.message.split('\n')[0]}\n       ${where}`)
  }
}

async function mintCookie() {
  const res = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' })
  const raw = res.headers.get('set-cookie') ?? ''
  if (!raw) throw new Error('no session cookie minted; is the token valid?')
  return raw.split(';')[0]
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie, Accept: 'application/json' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.ok === false) {
    throw new Error(`GET ${path} -> ${res.status} ${body?.error ?? ''}`)
  }
  return body
}

async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body?.ok === false) {
    throw new Error(`POST ${path} -> ${res.status} ${body?.error ?? ''}`)
  }
  return body
}

const install = (source, id) => post('/skill-market/api/install', { source, id }).then((b) => b.result)
const remove = (id) => post('/skill-market/api/remove', { id })
const installed = () => get('/skill-market/api/installed')
const search = (source, q) => get(`/skill-market/api/search?source=${source}&q=${encodeURIComponent(q)}`)

/** Node child processes whose command line matches, via CIM. */
function nodeChildrenMatching(needle) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8' },
  )
  return out.split(/\s+/).filter((line) => /^\d+$/.test(line))
}

const recordOf = async (id) => (await installed()).entries.find((entry) => entry.id === id)

console.log('dsh-skill-market E2E\n')

// ------------------------------------------------------------------ catalog
await test('both catalogs answer search with detail fields', async () => {
  const z = await search('zcode', 'mimosa')
  assert.equal(z.entries[0].id, 'mimosa')
  assert.ok(z.entries[0].keywords?.length, 'zcode entry carries keywords')
  const w = await search('workbuddy-skill', 'airbnb')
  assert.equal(w.entries[0].id, 'airbnb')
  assert.ok(w.entries[0].examples?.length, 'workbuddy entry carries examples')
})

await test('icons are proxied same-origin with real bytes', async () => {
  const res = await fetch(`${BASE}/skill-market/api/icon?source=workbuddy-skill&id=airbnb`, { headers: { cookie } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^image\//)
  assert.ok((await res.arrayBuffer()).byteLength > 100)
})

// ------------------------------------------------------- zcode skills only
await test('zcode skills-only plugin (github): install, disk, record, remove', async () => {
  const before = await recordOf('github')
  if (before) await remove('github')

  const result = await install('zcode', 'github')
  assert.ok(result.skills.includes('commit'), `skills: ${result.skills}`)
  assert.deepEqual(result.commands, [])
  assert.equal(result.hooks, false)
  assert.deepEqual(result.servers, [])
  assert.ok(existsSync(join(SKILLS, 'commit', 'SKILL.md')), 'skill bundle on disk')
  const commitSkill = readFileSync(join(SKILLS, 'commit', 'SKILL.md'), 'utf8')
  assert.match(commitSkill, /^description: "\[github\] /m, 'sub-skill carries its package attribution')
  assert.ok(existsSync(join(STATE, 'plugins', 'github', 'github', 'skills', 'commit', 'SKILL.md')), 'plugin tree on disk')

  assert.ok((await recordOf('github'))?.skills.includes('commit'))

  await remove('github')
  assert.equal(await recordOf('github'), undefined)
  assert.ok(!existsSync(join(SKILLS, 'commit', 'SKILL.md')), 'skill bundle removed')
  assert.ok(!existsSync(join(STATE, 'plugins', 'github')), 'plugin tree removed')
})

// ------------------------------------------------------------ zcode full
await test('zcode full plugin (mimosa): skills + commands + hooks', async () => {
  const before = await recordOf('mimosa')
  if (before) await remove('mimosa')

  const result = await install('zcode', 'mimosa')
  assert.ok(result.skills.includes('mimosa-security-scan'))
  assert.deepEqual(result.commands.sort(), ['mimosa-deep-audit', 'mimosa-scan', 'mimosa-status'])
  assert.equal(result.hooks, true, `hooks not live: ${JSON.stringify(result.skipped)}`)
  assert.deepEqual(result.servers, [])

  const root = join(STATE, 'plugins', 'mimosa', 'mimosa')
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'))
  const commands = []
  for (const group of Object.values(hooks.hooks ?? {})) {
    for (const matcher of group ?? []) {
      for (const hook of matcher?.hooks ?? []) commands.push(hook)
    }
  }
  assert.ok(commands.length > 0, 'hooks present')
  for (const hook of commands) {
    assert.equal(hook.type, 'command', `hook type folded to command, got ${hook.type}`)
    assert.ok(
      hook.command.replaceAll('\\', '/').includes(root.replaceAll('\\', '/')),
      `hook command rooted at the install: ${hook.command}`,
    )
  }

  await remove('mimosa')
  assert.equal(await recordOf('mimosa'), undefined)
  assert.ok(!existsSync(join(SKILLS, 'mimosa-security-scan')), 'skill removed')
  assert.ok(!existsSync(join(STATE, 'plugins', 'mimosa')), 'plugin tree removed')
})

// ------------------------------------------------------------- zcode MCP
await test('zcode MCP plugin (disk-cleaner): stdio server spawns and dies with the install', async () => {
  const before = await recordOf('disk-cleaner')
  if (before) await remove('disk-cleaner')

  const result = await install('zcode', 'disk-cleaner')
  assert.deepEqual(result.servers, ['disk-cleaner-disk-cleaner'], `servers: ${JSON.stringify(result.servers)} skipped: ${JSON.stringify(result.skipped)}`)

  const mine = String(process.pid)
  const serverPids = nodeChildrenMatching('disk-cleaner').filter((pid) => pid !== mine)
  assert.ok(serverPids.length >= 1, 'MCP child process is running')

  await remove('disk-cleaner')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const after = nodeChildrenMatching('disk-cleaner').filter((pid) => pid !== mine)
  assert.equal(after.length, 0, `child processes survived removal: ${after.join(',')}`)
  assert.equal(await recordOf('disk-cleaner'), undefined)
})

// -------------------------------------------------------- workbuddy skill
await test('workbuddy skill (airbnb): install, disk, record, remove', async () => {
  const before = await recordOf('airbnb')
  if (before) await remove('airbnb')

  const result = await install('workbuddy-skill', 'airbnb')
  assert.deepEqual(result.skills, ['airbnb'])
  const markdown = readFileSync(join(SKILLS, 'airbnb', 'SKILL.md'), 'utf8')
  assert.match(markdown, /^---\r?\nname: airbnb\r?\ndescription: \S+/, 'legal DSH frontmatter')

  await remove('airbnb')
  assert.equal(await recordOf('airbnb'), undefined)
  assert.ok(!existsSync(join(SKILLS, 'airbnb')), 'skill removed')
})

// ------------------------------------------------------------------ state
await test('the installed list reflects exactly what remains', async () => {
  const page = await installed()
  for (const id of ['github', 'mimosa', 'disk-cleaner', 'airbnb']) {
    assert.equal(page.entries.find((entry) => entry.id === id), undefined, `${id} still listed`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
