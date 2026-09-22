/**
 * dsh-apply-patch — apply a structured multi-file patch in one call.
 *
 * Registers the `apply_patch` tool: parse a Codex/ZCode-style structured patch,
 * plan every file change, and only then write. A patch that cannot be applied in
 * full changes nothing, so a multi-file edit is never left half-applied.
 *
 * This plugin reads and writes files directly, so it is NOT constrained by the
 * harness file sandbox (see the README's security note). `rootDir` +
 * `allowOutsideRoot` are the guard rails, and they are configurable.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PatchError, describeChanges, parsePatch, planChanges } from './patch.js'

export const name = 'dsh-apply-patch'
export const inject = ['tools']

/**
 * @typedef {object} Config
 * @property {string}  rootDir           Root that relative patch paths resolve against. Empty = the process cwd.
 * @property {boolean} allowOutsideRoot  Allow patches to touch paths outside `rootDir`. Off by default.
 * @property {number}  maxFilesPerPatch  Refuse patches that change more files than this in one call.
 * @property {number}  maxPatchChars     Refuse patch text larger than this many characters.
 * @property {boolean} createParentDirs  Create missing parent directories for added files.
 */

export const Config = Schema.object({
  rootDir: Schema.string().default(''),
  allowOutsideRoot: Schema.boolean().default(false),
  maxFilesPerPatch: Schema.number().default(50),
  maxPatchChars: Schema.number().default(400_000),
  createParentDirs: Schema.boolean().default(true),
})

/** Resolve a patch path against the configured root and enforce containment. */
function resolveTarget(root, target, allowOutsideRoot) {
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target)
  if (!allowOutsideRoot) {
    const relative = path.relative(root, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new PatchError(
        `path escapes the configured rootDir (${root}): ${target}. ` +
          'Use a path inside the root, or set allowOutsideRoot in this plugin\'s config.',
      )
    }
  }
  return absolute
}

/** Read a file as text, or null when it does not exist. Directories are rejected. */
function readTextOrNull(absolute, display) {
  if (!existsSync(absolute)) return null
  const stats = statSync(absolute)
  if (stats.isDirectory()) throw new PatchError(`${display} is a directory, not a file`)
  return readFileSync(absolute, 'utf8')
}

const FORMAT_HELP = [
  'Structured patch text. Required shape:',
  '',
  '  *** Begin Patch',
  '  *** Add File: path/to/new.txt',
  '  +first line',
  '  *** Update File: path/to/existing.txt',
  '  @@ optional hint @@',
  '   unchanged context line',
  '  -removed line',
  '  +added line',
  '  *** Delete File: path/to/old.txt',
  '  *** Move File: old/path.txt -> new/path.txt',
  '  *** End Patch',
  '',
  '"*** Begin Patch" and "*** End Patch" are optional. In an update section every',
  'body line must start with a single space (context), "-" (remove) or "+" (add);',
  'an empty line means an empty context line. Context lines must match the file as',
  'it is on disk right now, so read the file first.',
].join('\n')

export function apply(ctx, config) {
  const settings = {
    rootDir: config?.rootDir && config.rootDir !== '' ? path.resolve(config.rootDir) : process.cwd(),
    allowOutsideRoot: config?.allowOutsideRoot ?? false,
    maxFilesPerPatch: config?.maxFilesPerPatch ?? 50,
    maxPatchChars: config?.maxPatchChars ?? 400_000,
    createParentDirs: config?.createParentDirs ?? true,
  }

  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description:
      'Apply a structured patch that adds, updates, deletes or moves one or more files in a single atomic call. ' +
      'Prefer this over many separate edit calls when a change spans several files or several places in one file: ' +
      'the whole patch is parsed and planned before anything is written, so if any hunk does not match, no file is ' +
      'modified at all. ' +
      FORMAT_HELP,
    parameters: {
      patch_text: { type: 'string', required: true, description: FORMAT_HELP },
      dry_run: {
        type: 'boolean',
        description: 'Validate and plan the patch, report what would change, but write nothing.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean' },
          summary: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                additions: { type: 'number' },
                deletions: { type: 'number' },
                movedTo: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const patchText = args.patch_text
      if (patchText.length > settings.maxPatchChars) {
        throw new PatchError(
          `patch_text is ${patchText.length} characters, above the configured maxPatchChars (${settings.maxPatchChars}). ` +
            'Split the work into smaller patches.',
        )
      }

      const ops = parsePatch(patchText)
      if (ops.length > settings.maxFilesPerPatch) {
        throw new PatchError(
          `patch touches ${ops.length} file sections, above the configured maxFilesPerPatch (${settings.maxFilesPerPatch}). ` +
            'Split the work into smaller patches.',
        )
      }

      // Resolve every path up front so a containment violation aborts before planning.
      const resolved = new Map()
      const absoluteOf = (target) => {
        if (!resolved.has(target)) resolved.set(target, resolveTarget(settings.rootDir, target, settings.allowOutsideRoot))
        return resolved.get(target)
      }
      for (const op of ops) {
        absoluteOf(op.path)
        if (op.to) absoluteOf(op.to)
      }

      const changes = planChanges(ops, (target) => readTextOrNull(absoluteOf(target), target))

      const dryRun = args.dry_run === true
      if (!dryRun) {
        for (const change of changes) {
          if (change.kind === 'delete') {
            rmSync(absoluteOf(change.path), { force: true })
            continue
          }
          const target = change.kind === 'move' ? change.movedTo : change.path
          const absolute = absoluteOf(target)
          if (settings.createParentDirs) mkdirSync(path.dirname(absolute), { recursive: true })
          writeFileSync(absolute, change.newContent, 'utf8')
          if (change.kind === 'move') rmSync(absoluteOf(change.path), { force: true })
        }
      }

      const lines = describeChanges(changes)
      const verb = dryRun ? 'would apply' : 'applied'
      const summary = [
        `${verb} ${changes.length} file change${changes.length === 1 ? '' : 's'}${dryRun ? ' (dry run, nothing written)' : ''}:`,
        ...lines.map((line) => `  ${line}`),
      ].join('\n')

      return {
        applied: !dryRun,
        summary,
        files: changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          additions: change.additions,
          deletions: change.deletions,
          ...(change.movedTo ? { movedTo: change.movedTo } : {}),
        })),
      }
    },
  }))

  ctx.logger?.info?.(`[${name}] registered apply_patch (rootDir=${settings.rootDir})`)
}
