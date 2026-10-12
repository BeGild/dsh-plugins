#!/usr/bin/env node
/**
 * run-all.mjs — run every test file in order; stop at the first failure so
 * output stays readable. Exit non-zero when any suite fails.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const dir = path.dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

let failed = 0
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const result = spawnSync(process.execPath, [path.join(dir, suite)], { stdio: 'inherit' })
  if (result.status !== 0) failed++
}
console.log(`\n${suites.length} suite(s): ${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
