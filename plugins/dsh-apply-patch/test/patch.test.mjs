/**
 * dsh-apply-patch core tests — run with: node test/patch.test.mjs
 *
 * Exercises parsePatch/planChanges against an in-memory file map, so the
 * behaviour under test is exactly the behaviour the tool relies on.
 */
import assert from 'node:assert/strict'
import { PatchError, applyHunksToText, parsePatch, planChanges } from '../lib/patch.js'

let passed = 0
let failed = 0
const failures = []

function test(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    failures.push({ label, error })
    console.log(`  FAIL ${label}\n       ${error.message.split('\n')[0]}`)
  }
}

/** Build a reader over a plain object of path -> text. */
function readerOf(files) {
  return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null)
}

/** Plan a patch and return a path -> text map of the resulting content. */
function resultOf(patchText, files) {
  const changes = planChanges(parsePatch(patchText), readerOf(files))
  const out = { ...files }
  for (const change of changes) {
    if (change.kind === 'delete') delete out[change.path]
    else if (change.kind === 'move') {
      delete out[change.path]
      out[change.movedTo] = change.newContent
    } else out[change.path] = change.newContent
  }
  return { out, changes }
}

console.log('dsh-apply-patch core tests\n')

// ---------------------------------------------------------------- add

test('adds a new file', () => {
  const { out, changes } = resultOf(
    ['*** Begin Patch', '*** Add File: a.txt', '+hello', '+world', '*** End Patch'].join('\n'),
    {},
  )
  assert.equal(out['a.txt'], 'hello\nworld\n')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].additions, 2)
})

test('refuses to add a file that already exists', () => {
  assert.throws(
    () => resultOf(['*** Add File: a.txt', '+x'].join('\n'), { 'a.txt': 'old\n' }),
    (e) => e instanceof PatchError && /already exists/.test(e.message),
  )
})

// ------------------------------------------------------------- update

test('updates a single hunk', () => {
  const { out } = resultOf(
    [
      '*** Update File: a.txt',
      '@@',
      ' keep',
      '-old',
      '+new',
      ' tail',
    ].join('\n'),
    { 'a.txt': 'keep\nold\ntail\n' },
  )
  assert.equal(out['a.txt'], 'keep\nnew\ntail\n')
})

test('applies multiple hunks in one file', () => {
  const { out, changes } = resultOf(
    [
      '*** Update File: a.txt',
      '@@',
      '-one',
      '+ONE',
      '@@',
      '-three',
      '+THREE',
    ].join('\n'),
    { 'a.txt': 'one\ntwo\nthree\n' },
  )
  assert.equal(out['a.txt'], 'ONE\ntwo\nTHREE\n')
  assert.equal(changes[0].additions, 2)
  assert.equal(changes[0].deletions, 2)
})

test('tolerates trailing-whitespace drift in context lines', () => {
  const { out } = resultOf(
    ['*** Update File: a.txt', '@@', ' ctx', '-old', '+new'].join('\n'),
    { 'a.txt': 'ctx   \nold\n' },
  )
  assert.equal(out['a.txt'], 'ctx   \nnew\n')
})

test('reports a hunk that does not match, without changing anything', () => {
  assert.throws(
    () =>
      resultOf(['*** Update File: a.txt', '@@', '-nope', '+x'].join('\n'), { 'a.txt': 'one\n' }),
    (e) => e instanceof PatchError && /does not match/.test(e.message),
  )
})

test('preserves CRLF line endings', () => {
  const { out } = resultOf(
    ['*** Update File: a.txt', '@@', '-old', '+new'].join('\n'),
    { 'a.txt': 'old\r\nsecond\r\n' },
  )
  assert.equal(out['a.txt'], 'new\r\nsecond\r\n')
})

test('preserves a missing trailing newline', () => {
  const { out } = resultOf(
    ['*** Update File: a.txt', '@@', '-old', '+new'].join('\n'),
    { 'a.txt': 'old' },
  )
  assert.equal(out['a.txt'], 'new')
})

// ------------------------------------------------------------- delete / move

test('deletes a file', () => {
  const { out, changes } = resultOf(['*** Delete File: a.txt'].join('\n'), { 'a.txt': 'x\n' })
  assert.equal(out['a.txt'], undefined)
  assert.equal(changes[0].kind, 'delete')
})

test('refuses to delete a missing file', () => {
  assert.throws(
    () => resultOf('*** Delete File: nope.txt', {}),
    (e) => e instanceof PatchError && /does not exist/.test(e.message),
  )
})

test('moves a file with the arrow spelling', () => {
  const { out } = resultOf('*** Move File: a.txt -> b/c.txt', { 'a.txt': 'body\n' })
  assert.equal(out['a.txt'], undefined)
  assert.equal(out['b/c.txt'], 'body\n')
})

test('moves and edits a file with the Codex spelling', () => {
  const { out } = resultOf(
    ['*** Update File: a.txt', '*** Move to: b.txt', '@@', '-old', '+new'].join('\n'),
    { 'a.txt': 'old\n' },
  )
  assert.equal(out['a.txt'], undefined)
  assert.equal(out['b.txt'], 'new\n')
})

test('refuses to move onto an existing target', () => {
  assert.throws(
    () => resultOf('*** Move File: a.txt -> b.txt', { 'a.txt': 'x\n', 'b.txt': 'y\n' }),
    (e) => e instanceof PatchError && /target already exists/.test(e.message),
  )
})

// ---------------------------------------------------- multi-file + atomicity

test('plans several files in one patch, and later ops see earlier ones', () => {
  const { out, changes } = resultOf(
    [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+first',
      '*** Update File: new.txt',
      '@@',
      '-first',
      '+second',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n'),
    { 'gone.txt': 'bye\n' },
  )
  assert.equal(out['new.txt'], 'second\n')
  assert.equal(out['gone.txt'], undefined)
  assert.equal(changes.length, 3)
})

test('a bad hunk anywhere aborts the whole patch before any write', () => {
  let wrote = false
  const changes = () => {
    wrote = true
  }
  assert.throws(() => {
    const planned = planChanges(
      parsePatch(
        [
          '*** Add File: ok.txt',
          '+fine',
          '*** Update File: bad.txt',
          '@@',
          '-not-there',
          '+x',
        ].join('\n'),
      ),
      readerOf({ 'bad.txt': 'actual\n' }),
    )
    changes(planned)
  }, PatchError)
  assert.equal(wrote, false, 'no change list should have been produced')
})

// ------------------------------------------------------------- parse errors

test('rejects empty patch text', () => {
  assert.throws(() => parsePatch('   '), (e) => e instanceof PatchError && /empty/.test(e.message))
})

test('rejects stray text outside a file section', () => {
  assert.throws(
    () => parsePatch('just some prose'),
    (e) => e instanceof PatchError && /unexpected line/.test(e.message),
  )
})

test('rejects a malformed add body', () => {
  assert.throws(
    () => parsePatch(['*** Add File: a.txt', 'no plus prefix'].join('\n')),
    (e) => e instanceof PatchError && /must start with "\+"/.test(e.message),
  )
})

test('rejects a malformed update body', () => {
  assert.throws(
    () => parsePatch(['*** Update File: a.txt', '@@', 'garbage'].join('\n')),
    (e) => e instanceof PatchError && /must start with/.test(e.message),
  )
})

test('tolerates a patch without Begin/End markers', () => {
  const ops = parsePatch(['*** Add File: a.txt', '+x'].join('\n'))
  assert.equal(ops.length, 1)
})

// ------------------------------------------------------------- hunks helper

test('applyHunksToText inserts when a hunk has no context', () => {
  const { text, additions } = applyHunksToText(
    'a\nb\n',
    [{ items: [{ type: 'add', text: 'x' }] }],
    'f',
  )
  assert.equal(text, 'x\na\nb\n')
  assert.equal(additions, 1)
})

test('applyHunksToText keeps the file context when a hunk matched fuzzily', () => {
  const { text } = applyHunksToText(
    'keep   \nold\n',
    [{ items: [
      { type: 'context', text: 'keep' },
      { type: 'remove', text: 'old' },
      { type: 'add', text: 'new' },
    ] }],
    'f',
  )
  assert.equal(text, 'keep   \nnew\n')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const { label, error } of failures) console.error(`\n--- ${label} ---\n${error.stack}`)
  process.exit(1)
}
