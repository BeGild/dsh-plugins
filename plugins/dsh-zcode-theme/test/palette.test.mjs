/**
 * The host palette (lib/palette.js) is the source the README quotes. The
 * browser half inlines the same pairs because the client artifact has no
 * module graph. This test fails when the two copies diverge.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ACCENT_TOKENS, SURFACE_TOKENS, buildTokens } from '../lib/palette.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const client = readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8')

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

/** Pull `var NAME = { ... };` out of the client artifact and eval it. */
function extractTable(name) {
  const marker = `var ${name} = {`
  const start = client.indexOf(marker)
  assert.notEqual(start, -1, `client.js has no ${marker}`)
  const end = client.indexOf('};', start)
  const body = client.slice(start + `var ${name} = `.length, end + 1)
  return Function(`"use strict"; return (${body});`)()
}

check('every surface token is inlined in the client with both modes', () => {
  const table = extractTable('SURFACES')
  const missing = []
  for (const [name, pair] of Object.entries(SURFACE_TOKENS)) {
    const row = table[name]
    if (!row || row[0] !== pair.light || row[1] !== pair.dark) missing.push(name)
  }
  assert.deepEqual(missing, [], `diverged: ${missing.join(', ')}`)
  assert.equal(Object.keys(table).length, Object.keys(SURFACE_TOKENS).length)
})

check('every accent token is inlined the same way', () => {
  const table = extractTable('ACCENTS')
  for (const [name, pair] of Object.entries(ACCENT_TOKENS)) {
    assert.deepEqual(table[name], [pair.light, pair.dark], name)
  }
  assert.equal(Object.keys(table).length, Object.keys(ACCENT_TOKENS).length)
})

check('accent is off unless asked for', () => {
  const plain = buildTokens()
  const withAccent = buildTokens({ accent: true })
  assert.equal('--dsw-alias-state-business-primary' in plain, false)
  assert.equal(withAccent['--dsw-alias-state-business-primary'].dark, '#4099ff')
  assert.equal(Object.keys(withAccent).length, Object.keys(plain).length + Object.keys(ACCENT_TOKENS).length)
})

check('the dark page background is ZCode zai-dark, not the DSH bluish ramp', () => {
  assert.equal(SURFACE_TOKENS['--dsw-alias-bg-base'].dark, '#161616')
  assert.equal(SURFACE_TOKENS['--dsw-specific-sidebar-fill'].dark, '#161616')
  assert.equal(SURFACE_TOKENS['--dsw-alias-bg-layer-2'].dark, '#2b2b2b')
  assert.equal(SURFACE_TOKENS['--dsw-alias-brand-primary'].dark, '#ffffff')
  assert.equal(SURFACE_TOKENS['--dsw-alias-brand-primary'].light, '#000000')
})

check('every token carries both modes as non-empty strings', () => {
  for (const [name, pair] of Object.entries({ ...SURFACE_TOKENS, ...ACCENT_TOKENS })) {
    assert.equal(typeof pair.light, 'string', name)
    assert.equal(typeof pair.dark, 'string', name)
    assert.ok(pair.light.length > 0 && pair.dark.length > 0, name)
  }
})

if (failed > 0) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\npalette ok')
