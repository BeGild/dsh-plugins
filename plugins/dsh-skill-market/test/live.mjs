/**
 * One live install against the public catalogs, into a temp skill root.
 * Not part of `npm test`: it needs the network.
 *
 *   node test/live.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '../lib/catalog.js'
import { apply } from '../lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-skill-market-live-'))
const registered = []
const ctx = {
  tools: { register(tool) { registered.push(tool) } },
  effect() {},
  plugin() { throw new Error('connect was not expected') },
  logger: { warn(message) { console.log('warn', message) } },
}

await apply(ctx, {
  stateDir: join(root, 'state'),
  skillsDir: join(root, 'skills'),
  autoConnect: false,
})
const tool = registered[0]

const searched = await tool.execute({ op: 'search', source: 'workbuddy-skill', query: 'travel-cn', limit: 5 })
console.log(searched.message, searched.entries.map((entry) => entry.id).join(', '))

const installed = await tool.execute({ op: 'install', source: 'workbuddy-skill', id: 'travel-cn' })
console.log(installed.message)
const skill = await readFile(join(root, 'skills', 'travel-cn', 'SKILL.md'), 'utf8')
console.log('frontmatter', skill.split('\n').slice(0, 4).join(' | '))

const zcode = await tool.execute({ op: 'search', source: 'zcode', query: 'github', limit: 3 })
console.log('zcode', zcode.entries.map((entry) => `${entry.id}:${entry.installable}`).join(', '))
const plugin = await tool.execute({ op: 'install', source: 'zcode', id: 'github' })
console.log(plugin.message)

await tool.execute({ op: 'remove', id: 'travel-cn' })
await tool.execute({ op: 'remove', id: 'github' })
await rm(root, { recursive: true, force: true })
console.log('removed and cleaned', root)

const settings = resolveSettings({}, '')
console.log('empty home state', settings.stateDir)
