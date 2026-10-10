/**
 * Loads lib/client.js the way the browser module system does: the script only
 * registers a factory, and the loader materializes it later. Checks the three
 * things that would otherwise fail only in a browser — the bundle id, that it
 * asks for no extra modules, and that apply() hands theme.overrideTokens one
 * well-formed layer that honours the config switches.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_FILE = path.join(ROOT, 'lib', 'client.js')

let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

async function loadBundle() {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load(registration) { registrations.push(registration) } } }
  await import(`${pathToFileURL(CLIENT_FILE).href}?t=${Date.now()}-${Math.random()}`)
  return registrations
}

function materialize(registration) {
  const requested = []
  const require = (specifier) => {
    requested.push(specifier)
    throw new Error(`bundle requested a module: ${specifier}`)
  }
  const exports = registration.factory(require)
  return { exports, requested }
}

/** A theme seat that records the one call this plugin makes. */
function themeSeat() {
  const calls = []
  return {
    calls,
    overrideTokens(source, tokens) {
      calls.push({ source, tokens })
      return () => {}
    },
  }
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

await check('the bundle id is the package name', async () => {
  const registrations = await loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, pkg.name)
})

await check('it requests nothing and injects theme', async () => {
  const [registration] = await loadBundle()
  const { exports, requested } = materialize(registration)
  assert.deepEqual(requested, [])
  assert.deepEqual(exports.inject, ['theme'])
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

await check('the default layer overrides surfaces and font sub-properties', async () => {
  const [registration] = await loadBundle()
  const { exports } = materialize(registration)
  const theme = themeSeat()
  exports.apply({ theme })
  assert.equal(theme.calls.length, 1)
  const { tokens } = theme.calls[0]
  const base = tokens['--dsw-alias-bg-base']
  assert.deepEqual(base, { light: '#f8f8f8', dark: '#161616' })
  const body = tokens['--dsw-font-markdown-base-font-size']
  assert.equal(body.light, body.dark)
  assert.match(body.light, /^calc\(14px \+ var\(--dsh-content-font-delta, 0px\)\)$/)
  // Code *faces* stay on the built-in sheet. Code-block surface colours are
  // part of the palette and are expected to be here.
  for (const name of Object.keys(tokens)) {
    if (name.startsWith('--dsw-font-')) assert.equal(name.includes('code'), false, name)
  }
  // Accent is opt-in.
  assert.equal('--dsw-alias-state-business-primary' in tokens, false)
})

await check('config switches remove whole groups', async () => {
  const [registration] = await loadBundle()
  const { exports } = materialize(registration)

  const fontsOnly = themeSeat()
  exports.apply({ theme: fontsOnly }, { palette: false })
  assert.equal(Object.keys(fontsOnly.calls[0].tokens).some((n) => n.startsWith('--dsw-alias-')), false)
  assert.ok('--dsw-font-xs-13-font-size' in fontsOnly.calls[0].tokens)

  const paletteOnly = themeSeat()
  exports.apply({ theme: paletteOnly }, { fonts: false, accent: true })
  const names = Object.keys(paletteOnly.calls[0].tokens)
  assert.equal(names.some((n) => n.startsWith('--dsw-font-')), false)
  assert.equal(paletteOnly.calls[0].tokens['--dsw-alias-state-business-primary'].dark, '#4099ff')

  const neither = themeSeat()
  exports.apply({ theme: neither }, { fonts: false, palette: false })
  assert.equal(neither.calls.length, 0)
})

await check('literal chrome sizes move onto the ladder and code faces do not', async () => {
  const [registration] = await loadBundle()
  const { exports } = materialize(registration)
  // The rewriter is closed over inside the bundle. Drive it through the
  // stylesheet it would edit: a jsdom-free stand-in that records textContent.
  const sheets = []
  const tags = []
  function makeTag(css) {
    const tag = {
      nodeType: 1,
      tagName: 'STYLE',
      textContent: css,
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value },
      getAttribute(name) { return this.attrs[name] ?? null },
      removeAttribute(name) { delete this.attrs[name] },
    }
    tags.push(tag)
    return tag
  }
  const css = [
    '._button_x{font-size:14px;line-height:22px;color:red}',
    '._code_x{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}',
    '._hint_x{font-size:12px;line-height:18px}',
    '._tiny_x{font-size:11px;line-height:16px}',
  ].join('')
  let observed = false
  let disconnected = false
  globalThis.document = {
    querySelectorAll() { return [makeTag(css)] },
    head: {},
  }
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb }
    observe() { observed = true }
    disconnect() { disconnected = true }
  }
  const disposers = []
  exports.apply({
    theme: themeSeat(),
    effect(fn) { disposers.push(fn()) },
  })
  assert.equal(observed, true)
  const tuned = tags[0].textContent
  assert.match(tuned, /font-size:calc\(14px \+ var\(--dsh-content-font-delta, 0px\)\)/)
  assert.match(tuned, /font-size:calc\(12px \+ var\(--dsh-content-font-delta, 0px\)\)/)
  assert.match(tuned, /font-size:calc\(10px \+ var\(--dsh-content-font-delta, 0px\)\)/)
  // The code face is untouched, selector and all.
  assert.match(tuned, /\._code_x\{font-family:var\(--ds-font-family-code\);font-size:12px;line-height:18px\}/)
  // Leading keeps its gap over the new size: 22 - 14 = 8, so base (14) leads at 22.
  assert.match(tuned, /\._button_x\{font-size:calc\(14px \+ var\(--dsh-content-font-delta, 0px\)\);line-height:calc\(22px \+ var\(--dsh-content-font-delta, 0px\)\);color:red\}/)

  for (const dispose of disposers) dispose()
  assert.equal(disconnected, true)
  assert.equal(tags[0].textContent, css)
  delete globalThis.document
  delete globalThis.MutationObserver
})

await check('every override value is a { light, dark } pair of strings', async () => {
  const [registration] = await loadBundle()
  const { exports } = materialize(registration)
  const theme = themeSeat()
  exports.apply({ theme }, { accent: true })
  for (const [name, value] of Object.entries(theme.calls[0].tokens)) {
    assert.equal(typeof value?.light, 'string', name)
    assert.equal(typeof value?.dark, 'string', name)
  }
})

if (failed > 0) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nclient ok')
