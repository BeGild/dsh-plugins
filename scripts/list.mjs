#!/usr/bin/env node
/**
 * list.mjs — inventory of this monorepo's plugins.
 *
 *   node scripts/list.mjs
 *   node scripts/list.mjs --json
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const asJson = process.argv.includes('--json')

const dir = path.join(ROOT, 'plugins')
const dirs = existsSync(dir)
  ? readdirSync(dir)
      .map((n) => path.join(dir, n))
      .filter((p) => statSync(p).isDirectory())
  : []

const rows = dirs.map((p) => {
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(path.join(p, 'package.json'), 'utf8'))
  } catch {
    /* reported by validate.mjs */
  }
  const tests = existsSync(path.join(p, 'test'))
    ? readdirSync(path.join(p, 'test')).filter((f) => f.includes('.test.')).length
    : 0
  return {
    name: pkg.name ?? path.basename(p),
    version: pkg.version ?? '?',
    hasBundle: Boolean(pkg.dsh?.bundle?.patch),
    tests,
    description: pkg.description ?? '',
  }
})

if (asJson) {
  console.log(JSON.stringify({ plugins: rows }, null, 2))
} else {
  console.log(`dsh-plugins — ${rows.length} package(s)\n`)
  for (const r of rows) {
    console.log(`${r.name}@${r.version}${r.hasBundle ? '' : '  [MISSING dsh.bundle!]'}`)
    console.log(`    ${r.description}`)
    console.log(`    tests: ${r.tests} file(s)`)
  }
}
