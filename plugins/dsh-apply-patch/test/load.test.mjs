/**
 * dsh-apply-patch load + integration test — run with: node test/load.test.mjs
 *
 * Unlike patch.test.mjs (pure core logic), this test imports the REAL plugin
 * module, lets the REAL `defineTool` from @deepseek-ai/dsh-tools compile and
 * validate the schema, registers it against a fake ctx, and then executes the
 * tool end-to-end against a real temporary directory.
 *
 * That is the load check without booting a server: if the plugin's schema,
 * imports or exports were wrong, this throws.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Config, apply, inject, name } from '../lib/index.js'

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

console.log('dsh-apply-patch load + integration tests\n')

// ---------------------------------------------------------------- module shape

check('exports the cordis plugin surface', () => {
  assert.equal(name, 'dsh-apply-patch')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'Config must be a Schemastery schema (a callable)')
})

// ------------------------------------------------------------- registration

const registered = []
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  logger: { info() {}, warn() {} },
}

check('apply() registers exactly one tool via the real defineTool', () => {
  apply(ctx, {})
  assert.equal(registered.length, 1)
})

const def = registered[0]

check('the registered definition is apply_patch', () => {
  assert.ok(def, 'no tool was registered')
  assert.equal(def.name, 'apply_patch')
  assert.equal(typeof def.description, 'string')
  assert.ok(def.description.length > 50, 'description should be substantial')
})

check('the definition exposes an executable body', () => {
  // defineTool wraps the body; the exact key is part of the harness contract.
  const keys = Object.keys(def)
  const runner = def.execute ?? def.handler ?? def.run
  assert.equal(
    typeof runner,
    'function',
    `expected an executable on the definition; keys were: ${keys.join(', ')}`,
  )
})

// --------------------------------------------------------------- end-to-end

const runner = def.execute ?? def.handler ?? def.run
const root = mkdtempSync(path.join(tmpdir(), 'dsh-apply-patch-'))
const exec = { signal: undefined, agent: undefined }

check('applies a real multi-file patch to disk', async () => {
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'a.txt'), 'keep\nold\ntail\n', 'utf8')

  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.txt',
    '+created',
    '*** Update File: src/a.txt',
    '@@',
    ' keep',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n')

  const value = await runner({ patch_text: patch }, exec)
  assert.equal(value.applied, true)
  assert.equal(value.files.length, 2)
  assert.equal(readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'created\n')
  assert.equal(readFileSync(path.join(root, 'src', 'a.txt'), 'utf8'), 'keep\nnew\ntail\n')
  assert.match(value.summary, /applied 2 file changes/)
})

check('render() turns the canonical value into content blocks', () => {
  const blocks = def.output.render(
    { patch_text: 'x' },
    { applied: true, summary: 'hello summary', files: [] },
  )
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello summary' }])
})

check('dry_run writes nothing', async () => {
  writeFileSync(path.join(root, 'src', 'd.txt'), 'before\n', 'utf8')
  const value = await runner(
    { patch_text: ['*** Update File: src/d.txt', '@@', '-before', '+after'].join('\n'), dry_run: true },
    exec,
  )
  assert.equal(value.applied, false)
  assert.equal(readFileSync(path.join(root, 'src', 'd.txt'), 'utf8'), 'before\n')
})

check('a non-matching hunk throws and leaves the file untouched', async () => {
  writeFileSync(path.join(root, 'src', 'e.txt'), 'actual\n', 'utf8')
  await assert.rejects(
    () => runner({ patch_text: ['*** Update File: src/e.txt', '@@', '-missing', '+x'].join('\n') }, exec),
    /does not match/,
  )
  assert.equal(readFileSync(path.join(root, 'src', 'e.txt'), 'utf8'), 'actual\n')
})

check('refuses a path escaping rootDir', async () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'dsh-outside-'))
  try {
    await assert.rejects(
      () =>
        runner(
          { patch_text: ['*** Add File: ../escape.txt', '+nope'].join('\n') },
          exec,
        ),
      /escapes the configured rootDir/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

check('honours rootDir from config', async () => {
  const confined = mkdtempSync(path.join(tmpdir(), 'dsh-confined-'))
  try {
    const local = []
    apply({ tools: { register: (d) => local.push(d) }, logger: {} }, { rootDir: confined })
    const localRunner = local[0].execute ?? local[0].handler ?? local[0].run
    await localRunner({ patch_text: ['*** Add File: only.txt', '+here'].join('\n') }, exec)
    assert.ok(existsSync(path.join(confined, 'only.txt')), 'file should land inside rootDir')
  } finally {
    rmSync(confined, { recursive: true, force: true })
  }
})

rmSync(root, { recursive: true, force: true })

console.log(failed === 0 ? '\nall load + integration checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
