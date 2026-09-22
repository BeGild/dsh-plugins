#!/usr/bin/env node
/**
 * validate.mjs — mechanical contract gate for every plugin in this monorepo.
 *
 * Encodes the hard rules from AGENTS.md as executable checks, because the
 * documented "most common rejection reasons" are all mechanically detectable:
 * a missing `dsh.bundle`, a patch file that is not an array, a row whose `name`
 * is not the package name, official packages in `dependencies` instead of
 * `peerDependencies`, and peer ranges that silently exclude every prerelease
 * DSH build.
 *
 *   node scripts/validate.mjs              # all plugins under plugins/
 *   node scripts/validate.mjs plugins/x    # one package
 *   node scripts/validate.mjs --json       # machine-readable
 *
 * Exit code is non-zero when any ERROR is found. WARN never fails the build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const targets = argv.filter((a) => !a.startsWith('--'))

/** Collect one plugin package's findings. */
class Report {
  constructor(dir) {
    this.dir = dir
    this.findings = []
  }
  error(rule, message) {
    this.findings.push({ level: 'error', rule, message })
  }
  warn(rule, message) {
    this.findings.push({ level: 'warn', rule, message })
  }
  info(rule, message) {
    this.findings.push({ level: 'info', rule, message })
  }
  get errors() {
    return this.findings.filter((f) => f.level === 'error')
  }
}

/** Read a file, or undefined when it is absent. */
function readIfPresent(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

/**
 * Structural read of a cordis patch file.
 *
 * Deliberately NOT a full YAML parser: it extracts the facts the contract cares
 * about (is the top level an array? which row ids and row names appear?), which
 * keeps this gate dependency-free. Anything beyond that is out of scope.
 */
function inspectPatch(text) {
  const lines = text.split(/\r?\n/)
  let sawTopLevelArray = false
  const ids = []
  const names = []
  let inComment = false

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') continue
    if (inComment) {
      if (line.includes('*/')) inComment = false
      continue
    }
    if (line.trim().startsWith('/*')) {
      if (!line.includes('*/')) inComment = true
      continue
    }
    if (line.trim().startsWith('#')) continue

    if (!sawTopLevelArray) {
      if (line.startsWith('-')) sawTopLevelArray = true
      else if (/^\S/.test(line)) return { sawTopLevelArray: false, ids, names }
    }

    const id = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line) ?? /^\s*id:\s*(.+?)\s*$/.exec(line)
    if (id) ids.push(unquote(id[1]))
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (name) names.push(unquote(name[1]))
  }

  return { sawTopLevelArray, ids, names }
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/
const LOCAL_SPECIFIER = /^(?:file:|link:|workspace:|portal:|github:|git\+|https?:)/

/** Does a peer range admit prerelease versions? */
function hasPrereleaseBranch(range) {
  return /-[0-9A-Za-z]/.test(range)
}

function validatePlugin(dir) {
  const report = new Report(dir)
  const manifestPath = path.join(dir, 'package.json')
  const raw = readIfPresent(manifestPath)

  if (raw === undefined) {
    report.error('R-package', 'package.json is missing')
    return report
  }

  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (error) {
    report.error('R-package', `package.json is not valid JSON: ${error.message}`)
    return report
  }

  const dirName = path.basename(dir)

  // ---------------------------------------------------------------- identity
  if (!pkg.name) report.error('R-package', 'package.json has no "name"')
  else if (!NPM_NAME.test(pkg.name)) report.error('R-package', `"name" is not a valid npm name: ${pkg.name}`)
  else if (pkg.name !== dirName) report.warn('R-package', `"name" (${pkg.name}) differs from the directory name (${dirName})`)

  if (!pkg.version) report.error('R-package', 'package.json has no "version"')
  else if (!SEMVER.test(pkg.version)) report.error('R-package', `"version" is not semver: ${pkg.version}`)

  // R8: the listing maintainers read the description against the code.
  if (!pkg.description) report.error('R8', 'package.json has no "description"')
  else if (!pkg.description.trim().endsWith('.')) report.error('R8', 'description must end with a period')
  else if (pkg.description.length < 20) report.warn('R8', 'description is very short; make it specific and truthful')

  if (!pkg.license) report.error('R-package', 'package.json has no "license"')
  if (pkg.type !== 'module') report.error('R-package', '"type" must be "module"')
  if (!pkg.engines?.node) report.warn('R-package', 'declare "engines.node"')

  // ------------------------------------------------------------------ entry
  if (!pkg.main) {
    report.error('R-package', 'package.json has no "main"')
  } else if (!existsSync(path.join(dir, pkg.main))) {
    report.error('R-package', `"main" points at a missing file: ${pkg.main}`)
  }

  // R1 — the single most common rejection reason.
  const patchRel = pkg.dsh?.bundle?.patch
  if (!patchRel) {
    report.error('R1', 'missing dsh.bundle.patch — the package installs but activates no layer')
  } else {
    const patchPath = path.join(dir, patchRel)
    const patchText = readIfPresent(patchPath)
    if (patchText === undefined) {
      report.error('R1', `dsh.bundle.patch points at a missing file: ${patchRel}`)
    } else {
      // R2 — top level must be an array, and a row must name the package.
      const { sawTopLevelArray, ids, names } = inspectPatch(patchText)
      if (!sawTopLevelArray) report.error('R2', 'cordis.patch.yml top level must be a YAML array')
      if (pkg.name && !names.includes(pkg.name)) {
        report.error('R2', `no row in cordis.patch.yml has name: ${pkg.name} (rows must use the package name)`)
      }
      const seen = new Set()
      for (const id of ids) {
        if (seen.has(id)) report.error('R2', `duplicate row id in cordis.patch.yml: ${id}`)
        seen.add(id)
      }
      if (ids.length === 0) report.warn('R2', 'cordis.patch.yml declares no row ids')

      if (pkg.files && !pkg.files.some((f) => path.normalize(f) === path.normalize(patchRel))) {
        report.error('R-package', `"files" must include the patch file (${patchRel})`)
      }
    }
  }

  if (pkg.files && pkg.main) {
    const mainDir = path.dirname(pkg.main).split(path.sep)[0]
    if (!pkg.files.some((f) => path.normalize(f).startsWith(mainDir))) {
      report.error('R-package', `"files" must include the build output directory (${mainDir})`)
    }
  }

  // --------------------------------------------------------------- keywords
  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('dsh-plugin')) {
    report.error('R-package', 'keywords must include "dsh-plugin" for discoverability')
  }

  // R4 — official packages are peers, never bundled copies.
  const deps = pkg.dependencies ?? {}
  for (const name of Object.keys(deps)) {
    if (name.startsWith('@deepseek-ai/')) {
      report.error('R4', `${name} is in "dependencies"; official @deepseek-ai/* packages must be peerDependencies`)
    }
  }

  // R7 — anything non-registry in dependencies breaks `npm publish`.
  for (const [name, spec] of Object.entries({ ...deps, ...(pkg.peerDependencies ?? {}) })) {
    if (typeof spec === 'string' && LOCAL_SPECIFIER.test(spec)) {
      report.error('R7', `${name} uses a non-registry specifier (${spec}); publish to npm or ship a tarball`)
    }
  }

  // R5 — the prerelease trap, scoped to packages published as prereleases.
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range !== 'string' || !hasPrereleaseBranch(range)) {
      report.error(
        'R5',
        `peer range for ${name} ("${range}") has no prerelease branch, so it silently excludes every prerelease DSH build`,
      )
    }
  }

  if (!pkg.peerDependencies || Object.keys(pkg.peerDependencies).length === 0) {
    report.warn('R-package', 'no peerDependencies declared')
  }

  // ------------------------------------------------------- listing readiness
  if (!pkg.repository?.url) {
    report.warn('R8', 'no "repository.url" — the curated listing matches plugins to repos by this field')
  } else if (!/^https:\/\/github\.com\//.test(pkg.repository.url)) {
    report.warn('R8', `"repository.url" should be a github.com https URL: ${pkg.repository.url}`)
  }
  if (pkg.publishConfig?.access !== 'public') {
    report.warn('R7', 'publishConfig.access should be "public"')
  }
  if (!pkg.dsh?.engines?.dsh) {
    report.warn('R-package', 'consider dsh.engines.dsh so installers can precheck the host version')
  }

  // Client plugins carry extra hard requirements.
  if (pkg.dsh?.client) {
    if (!pkg.dsh.client.platform) report.error('R-client', 'dsh.client requires "platform"')
    if (!pkg.exports?.['./client']) report.error('R-client', 'dsh.client requires a "./client" export')
  }
  if (pkg.exports && !pkg.exports['./package.json']) {
    report.warn('R-package', '"exports" should include "./package.json"')
  }

  // ------------------------------------------------------------- hygiene
  if (!existsSync(path.join(dir, 'README.md'))) {
    report.warn('R8', 'no README.md')
  } else {
    const readme = readFileSync(path.join(dir, 'README.md'), 'utf8')
    if (readme.length < 400) report.warn('R8', 'README.md is very short; document behaviour and config truthfully')
    if (!/sandbox|权限|permission/i.test(readme)) {
      report.info('R-sec', 'consider a security note: plugin code is NOT constrained by the harness sandbox')
    }
  }

  const testDir = path.join(dir, 'test')
  if (!existsSync(testDir)) {
    report.warn('R-test', 'no test/ directory')
  } else {
    const specs = readdirSync(testDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
    if (specs.length === 0) report.warn('R-test', 'test/ exists but contains no test files')
    else report.info('R-test', `${specs.length} test file(s)`)
  }

  return report
}

// ---------------------------------------------------------------------- main

function findPlugins() {
  if (targets.length > 0) return targets.map((t) => path.resolve(ROOT, t))
  const dir = path.join(ROOT, 'plugins')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((p) => statSync(p).isDirectory())
}

const plugins = findPlugins()
const reports = plugins.map(validatePlugin)

const allIds = new Map()
for (const report of reports) {
  const patchRel = (() => {
    try {
      return JSON.parse(readFileSync(path.join(report.dir, 'package.json'), 'utf8')).dsh?.bundle?.patch
    } catch {
      return undefined
    }
  })()
  if (!patchRel) continue
  const text = readIfPresent(path.join(report.dir, patchRel))
  if (text === undefined) continue
  for (const id of inspectPatch(text).ids) {
    if (allIds.has(id)) {
      report.error('R2', `row id "${id}" is also used by ${path.basename(allIds.get(id))}; ids must be globally unique`)
    } else {
      allIds.set(id, report.dir)
    }
  }
}

const totalErrors = reports.reduce((n, r) => n + r.errors.length, 0)
const totalWarns = reports.reduce((n, r) => n + r.findings.filter((f) => f.level === 'warn').length, 0)

if (asJson) {
  console.log(JSON.stringify({ plugins: reports, totalErrors, totalWarns }, null, 2))
} else {
  if (reports.length === 0) {
    console.log('No plugin packages found under plugins/.')
  }
  for (const report of reports) {
    const label = path.relative(ROOT, report.dir)
    const errs = report.errors.length
    console.log(`\n${errs === 0 ? 'PASS' : 'FAIL'}  ${label}`)
    for (const f of report.findings) {
      const mark = f.level === 'error' ? '  ERROR' : f.level === 'warn' ? '  warn ' : '  info '
      console.log(`${mark} [${f.rule}] ${f.message}`)
    }
  }
  console.log(
    `\n${reports.length} package(s): ${totalErrors} error(s), ${totalWarns} warning(s)`,
  )
  if (totalErrors === 0) {
    console.log('Contract gate passed.')
  } else {
    console.log('Contract gate FAILED — fix the errors above before publishing.')
  }
}

process.exit(totalErrors === 0 ? 0 : 1)
