/**
 * The fold line is the whole of what makes a turn read like WorkBuddy, so the
 * cases here are the decision table from its metaFold: one call, one group,
 * two groups, too many categories, and a turn that is still running.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fold = Function(`${readFileSync(path.join(HERE, '../lib/fold.js'), 'utf8')}; return { foldLine, classify, TOOLS }`)()

let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

const readme = { name: 'read', args: { file_path: 'docs/README.md' } }
const auth = { name: 'grep', args: { pattern: 'auth' } }

check('one read names the file', () => {
  assert.equal(fold.foldLine([readme]), '查看文件 docs/README.md')
})

check('one command keeps the command, not a path segment', () => {
  assert.equal(fold.foldLine([{ name: 'bash', args: { command: 'pnpm test' } }]), '运行命令 pnpm test')
})

check('a url is kept whole', () => {
  assert.equal(fold.foldLine([{ name: 'web_fetch', args: { url: 'https://example.com/a' } }]), '读取网页 https://example.com/a')
})

check('a call with no object uses the group fallback', () => {
  assert.equal(fold.foldLine([{ name: 'todo_write', args: {} }]), '整理计划')
})

check('several reads of one group name the group and the first file', () => {
  assert.equal(fold.foldLine([readme, { name: 'read', args: { path: 'src/a.ts' } }]), '查看文件 docs/README.md')
})

check('two groups name both verbs around the topic', () => {
  assert.equal(fold.foldLine([readme, { name: 'edit', args: { file_path: 'docs/README.md' } }]), '查看文件、修改文件：docs/README.md')
})

check('more than three categories with nothing to name count them', () => {
  const calls = [
    { name: 'todo_write', args: {} },
    { name: 'read_lints', args: {} },
    { name: 'send_message', args: {} },
    { name: 'mcp_call_tool', args: {} },
  ]
  assert.equal(fold.foldLine(calls), '4 类操作')
})

check('a running turn says it is in progress', () => {
  assert.equal(fold.foldLine([auth], { running: true }), '正在搜索 auth')
})

check('a turn with no calls says it thought', () => {
  assert.equal(fold.foldLine([]), '已思考')
  assert.equal(fold.foldLine([], { running: true }), '正在处理')
})

check('an unknown tool is not dropped when it names something', () => {
  assert.equal(fold.classify({ name: 'mystery', args: {} }).group, 'other')
})

check('the client bundle carries this exact source', () => {
  const client = readFileSync(path.join(HERE, '../lib/client.js'), 'utf8')
  const source = readFileSync(path.join(HERE, '../lib/fold.js'), 'utf8')
  const body = source.slice(source.indexOf('var GROUP_BARE'))
  const indented = body.split('\n').map((line) => (line ? `    ${line}` : line)).join('\n')
  assert.ok(client.includes(indented), 'lib/client.js drifted from lib/fold.js')
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nfold: all passed')
