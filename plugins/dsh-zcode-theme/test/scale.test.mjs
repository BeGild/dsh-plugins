/**
 * Pins the type ladder to ZCode's text-ui-* scale (DESIGN.md) and checks the
 * client artifact repeats the same steps. The two copies cannot import each
 * other: the browser half is a classic script, not an ES module graph.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FONT_ROLES, STEP_PX, fontSizeOf, fontTokenValues, lineHeightOf } from '../lib/scale.js'

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

check('steps match the ZCode defaults at a 14px base', () => {
  assert.deepEqual(STEP_PX, { xl: 18, lg: 16, base: 14, caption: 13, sm: 12, xs: 10 })
})

check('headings collapse onto the ZCode ladder instead of 21/19/18', () => {
  assert.deepEqual(FONT_ROLES['--dsw-font-markdown-h1'], { step: 'xl', weight: 600 })
  assert.deepEqual(FONT_ROLES['--dsw-font-markdown-h2'], { step: 'lg', weight: 600 })
  assert.equal(FONT_ROLES['--dsw-font-markdown-h3'].step, 'base')
  assert.equal(FONT_ROLES['--dsw-font-markdown-h4'].step, 'base')
  // The chrome tokens that make DSH look smaller than ZCode.
  assert.equal(FONT_ROLES['--dsw-font-xs-13'].step, 'caption')
  assert.equal(FONT_ROLES['--dsw-font-xxs-12'].step, 'sm')
  assert.equal(FONT_ROLES['--dsw-font-xxxs-11'].step, 'xs')
})

check('code faces are left alone', () => {
  for (const name of Object.keys(FONT_ROLES)) {
    assert.equal(name.includes('code'), false, `${name} is a code face`)
  }
})

check('every size tracks the content-font delta', () => {
  assert.equal(fontSizeOf('base'), 'calc(14px + var(--dsh-content-font-delta, 0px))')
  assert.equal(lineHeightOf('base'), 'calc(22px + var(--dsh-content-font-delta, 0px))')
  assert.throws(() => fontSizeOf('nope'))
})

check('each role emits the shorthand and the three sub-properties components read', () => {
  const values = fontTokenValues()
  for (const [name, role] of Object.entries(FONT_ROLES)) {
    const size = fontSizeOf(role.step)
    assert.equal(values[`${name}-font-size`], size, name)
    assert.equal(values[`${name}-line-height`], lineHeightOf(role.step), name)
    assert.equal(values[`${name}-font-weight`], String(role.weight), name)
    assert.ok(values[name].startsWith(`${role.weight} ${size}`), name)
  }
  // Family and style stay with the built-in sheet.
  for (const name of Object.keys(values)) {
    assert.equal(name.endsWith('-font-family'), false)
    assert.equal(name.endsWith('-font-style'), false)
  }
})

check('the client artifact repeats the same roles', () => {
  const start = client.indexOf('var FONT_ROLES = {')
  assert.notEqual(start, -1)
  const end = client.indexOf('};', start)
  const body = client.slice(start + 'var FONT_ROLES = '.length, end + 1)
  const roles = Function(`"use strict"; return (${body});`)()
  assert.deepEqual(Object.keys(roles).sort(), Object.keys(FONT_ROLES).sort())
  for (const [name, role] of Object.entries(FONT_ROLES)) {
    assert.deepEqual(roles[name], [role.step, role.weight], name)
  }
  const stepStart = client.indexOf('var STEP_PX = {')
  const stepEnd = client.indexOf('};', stepStart)
  const steps = Function(
    `"use strict"; return (${client.slice(stepStart + 'var STEP_PX = '.length, stepEnd + 1)});`,
  )()
  assert.deepEqual(steps, STEP_PX)
})

if (failed > 0) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nscale ok')
