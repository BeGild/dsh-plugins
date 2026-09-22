#!/usr/bin/env node
/**
 * test-all.mjs — run every plugin's test files and summarise.
 *
 *   node scripts/test-all.mjs            # all plugins
 *   node scripts/test-all.mjs dsh-persistent-repl
 *
 * Child output is inherited rather than captured, so a failing suite streams its
 * diagnostics straight to the CI log.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))

function pluginDirs() {
  const dir = path.join(ROOT, 'plugins')
  if (!existsSync(dir)) return []
  const all = readdirSync(dir)
    .map((n) => path.join(dir, n))
    .filter((p) => statSync(p).isDirectory())
  if (only.length === 0) return all
  return all.filter((p) => only.includes(path.basename(p)))
}

const results = []

for (const dir of pluginDirs()) {
  const testDir = path.join(dir, 'test')
  if (!existsSync(testDir)) continue
  const specs = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.js'))
    .sort()

  for (const spec of specs) {
    const label = `${path.basename(dir)}/${spec}`
    console.log(`\n=== ${label} ===`)
    const run = spawnSync(process.execPath, [path.join(testDir, spec)], {
      cwd: dir,
      stdio: 'inherit',
    })
    results.push({ label, ok: run.status === 0 })
  }
}

console.log('\n──────── test summary ────────')
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}`)
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} suite(s) passed`)
process.exit(failed === 0 ? 0 : 1)
