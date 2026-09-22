/**
 * dsh-apply-patch — structured multi-file patch core.
 *
 * Dependency-free parsing, planning and application of a Codex/ZCode-style
 * structured patch. lib/index.js only adapts this to `defineTool`; everything
 * here is a pure function over an injected reader so it can be unit-tested
 * without a running harness.
 *
 * Wire format:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.txt
 *   +first line
 *   +second line
 *   *** Update File: path/to/existing.txt
 *   @@ optional context hint @@
 *    unchanged context line
 *   -removed line
 *   +added line
 *   *** Delete File: path/to/old.txt
 *   *** Move File: old/path.txt -> new/path.txt
 *   *** End Patch
 *
 * `*** Begin Patch` / `*** End Patch` are optional. A move may also be written
 * as `*** Update File: a` followed by `*** Move to: b` (the Codex spelling).
 */

/** A malformed or unapplicable patch. Always a user/model-facing message. */
export class PatchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PatchError'
  }
}

const ADD_FILE = 'Add File: '
const UPDATE_FILE = 'Update File: '
const DELETE_FILE = 'Delete File: '
const MOVE_FILE = 'Move File: '
const MOVE_TO = 'Move to: '

/** Strip a trailing CR and surrounding whitespace from a directive path. */
function cleanPath(raw) {
  const path = String(raw).replace(/\r$/, '').trim()
  if (path === '') throw new PatchError('a file directive has an empty path')
  return path
}

/** Split text into lines while remembering its EOL style and trailing newline. */
function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const hasTrailing = /\r?\n$/.test(text)
  const body = hasTrailing ? text.replace(/\r?\n$/, '') : text
  return { lines: body === '' ? [] : body.split(/\r?\n/), eol, hasTrailing }
}

/** Inverse of {@link splitLines}. */
function joinLines(lines, eol, hasTrailing) {
  if (lines.length === 0) return hasTrailing ? eol : ''
  return lines.join(eol) + (hasTrailing ? eol : '')
}

/** Count the lines a block of text occupies (for add/delete statistics). */
function countLines(text) {
  if (text === '') return 0
  return splitLines(text).lines.length
}

/**
 * Find `needle` inside `haystack` starting at `from`.
 * @param compare optional per-line equality override.
 */
function findBlock(haystack, needle, from, compare) {
  const n = needle.length
  if (n === 0) return Math.min(from, haystack.length)
  const eq = compare ?? ((a, b) => a === b)
  for (let i = Math.max(0, from); i + n <= haystack.length; i++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      if (!eq(haystack[i + j], needle[j])) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

/**
 * Locate a hunk's original block, degrading from exact to whitespace-tolerant.
 * Models routinely drop trailing whitespace when reproducing context lines, so
 * a strict-only match would reject otherwise-correct patches.
 * @returns `{ index, how }` or `undefined` when the block is absent.
 */
function locateBlock(lines, oldBlock, from) {
  let index = findBlock(lines, oldBlock, from)
  if (index >= 0) return { index, how: 'exact' }
  index = findBlock(lines, oldBlock, 0)
  if (index >= 0) return { index, how: 'exact' }

  const rstrip = (s) => s.replace(/\s+$/, '')
  index = findBlock(lines, oldBlock, from, (a, b) => rstrip(a) === rstrip(b))
  if (index >= 0) return { index, how: 'trailing-whitespace' }
  index = findBlock(lines, oldBlock, 0, (a, b) => rstrip(a) === rstrip(b))
  if (index >= 0) return { index, how: 'trailing-whitespace' }

  const squash = (s) => s.trim().replace(/\s+/g, ' ')
  index = findBlock(lines, oldBlock, 0, (a, b) => squash(a) === squash(b))
  if (index >= 0) return { index, how: 'whitespace-insensitive' }
  return undefined
}

/**
 * Parse structured patch text into an ordered list of file operations.
 * @param {string} text
 * @returns {Array<object>} ops: add | update | delete | move
 */
export function parsePatch(text) {
  const src = String(text ?? '')
  if (src.trim() === '') throw new PatchError('patch_text is empty')

  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const ops = []
  let i = 0

  const skipBlank = () => {
    while (i < lines.length && lines[i].trim() === '') i++
  }
  /** Collect body lines up to (but not including) the next `*** ` directive. */
  const takeBody = () => {
    const body = []
    while (i < lines.length) {
      const line = lines[i]
      if (line.startsWith('*** ')) break
      body.push(line)
      i++
    }
    return body
  }

  skipBlank()
  if (lines[i] === '*** Begin Patch') i++

  while (i < lines.length) {
    skipBlank()
    if (i >= lines.length) break
    const line = lines[i]
    if (line === '*** End Patch') {
      i++
      break
    }
    if (!line.startsWith('*** ')) {
      throw new PatchError(
        `unexpected line outside a file section: ${JSON.stringify(line)}. ` +
          'Every change must start with a "*** Add File:", "*** Update File:", "*** Delete File:" or "*** Move File:" directive.',
      )
    }

    const directive = line.slice(4)
    if (directive.startsWith(ADD_FILE)) {
      const path = cleanPath(directive.slice(ADD_FILE.length))
      i++
      const body = takeBody()
      const content = body.map((raw, index) => {
        if (raw.startsWith('+')) return raw.slice(1)
        if (raw.trim() === '') return ''
        throw new PatchError(
          `added file ${path}: line ${index + 1} of the body must start with "+" (got ${JSON.stringify(raw)})`,
        )
      })
      ops.push({ kind: 'add', path, content })
      continue
    }

    if (directive.startsWith(UPDATE_FILE)) {
      const path = cleanPath(directive.slice(UPDATE_FILE.length))
      i++
      // The Codex spelling puts "*** Move to:" immediately after the update
      // directive and BEFORE the hunks — consume it here so the hunks still parse.
      let to
      if (lines[i] !== undefined && lines[i].startsWith(`*** ${MOVE_TO}`)) {
        to = cleanPath(lines[i].slice(4 + MOVE_TO.length))
        i++
      }
      const body = takeBody()
      const hunks = []
      let current = null
      const openHunk = () => {
        current = { items: [] }
        hunks.push(current)
      }
      for (const raw of body) {
        if (raw.startsWith('@@')) {
          openHunk()
          continue
        }
        // Tolerate a body that omits the leading @@ hint.
        if (current === null) openHunk()
        if (raw.startsWith('+')) current.items.push({ type: 'add', text: raw.slice(1) })
        else if (raw.startsWith('-')) current.items.push({ type: 'remove', text: raw.slice(1) })
        else if (raw.startsWith(' ')) current.items.push({ type: 'context', text: raw.slice(1) })
        else if (raw.trim() === '') current.items.push({ type: 'context', text: '' })
        else if (raw.startsWith('\\')) continue // "\ No newline at end of file"
        else {
          throw new PatchError(
            `updated file ${path}: each body line must start with " " (context), "-" (remove) or "+" (add); got ${JSON.stringify(raw)}`,
          )
        }
      }
      ops.push({ kind: 'update', path, hunks, to })
      continue
    }

    if (directive.startsWith(DELETE_FILE)) {
      const path = cleanPath(directive.slice(DELETE_FILE.length))
      i++
      takeBody()
      ops.push({ kind: 'delete', path })
      continue
    }

    if (directive.startsWith(MOVE_FILE)) {
      const rest = directive.slice(MOVE_FILE.length)
      const arrow = rest.indexOf('->')
      let path
      let to
      if (arrow >= 0) {
        path = cleanPath(rest.slice(0, arrow))
        to = cleanPath(rest.slice(arrow + 2))
      } else {
        path = cleanPath(rest)
      }
      i++
      takeBody()
      ops.push({ kind: 'move', path, to, hunks: [] })
      continue
    }

    if (directive.startsWith(MOVE_TO)) {
      const to = cleanPath(directive.slice(MOVE_TO.length))
      const last = ops[ops.length - 1]
      if (!last) throw new PatchError('"*** Move to:" must follow a file section')
      last.to = to
      i++
      takeBody()
      continue
    }

    throw new PatchError(`unrecognized directive: ${JSON.stringify(line)}`)
  }

  if (ops.length === 0) throw new PatchError('patch_text contains no file operations')
  return ops
}

/**
 * Apply hunks to one file's text.
 *
 * Replacement blocks take their context lines from the FILE, not from the patch.
 * That is what makes fuzzy matching safe: a hunk that only matched after
 * normalising whitespace must not silently rewrite the untouched context lines
 * to the patch author's spelling.
 *
 * @returns `{ text, additions, deletions }`
 */
export function applyHunksToText(text, hunks, path) {
  const { lines, eol, hasTrailing } = splitLines(text)
  let result = lines.slice()
  let cursor = 0
  let additions = 0
  let deletions = 0

  hunks.forEach((hunk, hunkIndex) => {
    const items = hunk.items
    const oldLines = items.filter((item) => item.type !== 'add').map((item) => item.text)

    let index
    if (oldLines.length === 0) {
      index = Math.min(cursor, result.length)
    } else {
      const found = locateBlock(result, oldLines, cursor)
      if (!found) {
        const preview = oldLines.slice(0, 4).map((l) => `    ${JSON.stringify(l)}`).join('\n')
        throw new PatchError(
          `hunk ${hunkIndex + 1} does not match ${path}: the following original line(s) were not found\n${preview}\n` +
            'Re-read the file and regenerate the patch against its current content.',
        )
      }
      index = found.index
    }

    const block = []
    let oldOffset = 0
    for (const item of items) {
      if (item.type === 'add') {
        block.push(item.text)
        additions++
      } else if (item.type === 'remove') {
        oldOffset++
        deletions++
      } else {
        // Context: keep whatever the file actually has at this position.
        block.push(result[index + oldOffset] ?? item.text)
        oldOffset++
      }
    }

    result = result.slice(0, index).concat(block, result.slice(index + oldLines.length))
    cursor = index + block.length
  })

  return { text: joinLines(result, eol, hasTrailing), additions, deletions }
}

/**
 * Turn parsed ops into concrete file changes without touching the disk.
 *
 * Earlier ops in the same patch are visible to later ones (an added file can be
 * updated by a following hunk), and every content-level failure is raised here
 * — before a single byte is written. That is the atomicity guarantee: a patch
 * that cannot be applied in full changes nothing.
 *
 * @param {Array<object>} ops parsed operations
 * @param {(path: string) => string | null} reader returns file text or null
 * @returns {Array<object>} changes to hand to {@link applyChanges}
 */
export function planChanges(ops, reader) {
  const overlay = new Map()
  const read = (path) => (overlay.has(path) ? overlay.get(path) : reader(path))
  const changes = []

  ops.forEach((op) => {
    if (op.kind === 'add') {
      if (read(op.path) !== null) {
        throw new PatchError(`cannot add ${op.path}: the file already exists`)
      }
      const newContent = op.content.length === 0 ? '' : op.content.join('\n') + '\n'
      overlay.set(op.path, newContent)
      changes.push({ kind: 'add', path: op.path, newContent, additions: op.content.length, deletions: 0 })
      return
    }

    if (op.kind === 'delete') {
      const existing = read(op.path)
      if (existing === null) throw new PatchError(`cannot delete ${op.path}: the file does not exist`)
      overlay.set(op.path, null)
      changes.push({ kind: 'delete', path: op.path, additions: 0, deletions: countLines(existing) })
      return
    }

    if (op.kind === 'update' || op.kind === 'move') {
      const existing = read(op.path)
      if (existing === null) throw new PatchError(`cannot ${op.kind} ${op.path}: the file does not exist`)

      let newContent = existing
      let additions = 0
      let deletions = 0
      if (op.hunks && op.hunks.length > 0) {
        const applied = applyHunksToText(existing, op.hunks, op.path)
        newContent = applied.text
        additions = applied.additions
        deletions = applied.deletions
      }

      if (op.to) {
        if (read(op.to) !== null) throw new PatchError(`cannot move ${op.path} to ${op.to}: the target already exists`)
        overlay.set(op.path, null)
        overlay.set(op.to, newContent)
        changes.push({ kind: 'move', path: op.path, movedTo: op.to, newContent, additions, deletions })
        return
      }

      overlay.set(op.path, newContent)
      changes.push({ kind: 'update', path: op.path, newContent, additions, deletions })
      return
    }

    throw new PatchError(`unsupported operation: ${op.kind}`)
  })

  return changes
}

/** Human/model-facing one-line-per-file summary of planned changes. */
export function describeChanges(changes) {
  return changes.map((change) => {
    const stats = `+${change.additions}/-${change.deletions}`
    if (change.kind === 'move') return `M ${change.path} -> ${change.movedTo} (${stats})`
    if (change.kind === 'add') return `A ${change.path} (${stats})`
    if (change.kind === 'delete') return `D ${change.path} (${stats})`
    return `U ${change.path} (${stats})`
  })
}
