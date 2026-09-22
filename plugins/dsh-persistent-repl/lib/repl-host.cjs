'use strict'
/**
 * dsh-persistent-repl host — a persistent JavaScript evaluation server.
 *
 * Runs as a SEPARATE child process (see lib/repl.js), which is deliberate:
 * a runaway loop, an OOM or a `process.exit()` inside evaluated code kills only
 * this host, never the harness. The parent detects the death and restarts it.
 *
 * Protocol (newline-delimited JSON, one message per line):
 *   in : { "id": 1, "code": "...", "timeoutMs": 30000 }
 *   out: { "id": 1, "ok": true,  "value": "...", "logs": ["..."] }
 *        { "id": 1, "ok": false, "error": "...", "logs": ["..."] }
 *   out: { "ready": true }   once, on startup
 *
 * State persistence: every snippet is compiled as a Script and run in ONE
 * long-lived vm context. Top-level `var`, `function`, `let` and `const` all land
 * in that realm's global environment, so they stay visible to later snippets —
 * the same semantics a browser gives two <script> tags.
 */
const vm = require('node:vm')
const util = require('node:util')
const path = require('node:path')
const { createRequire } = require('node:module')

const CWD = process.env.DSH_NODE_REPL_CWD || process.cwd()

/** Saved before any capture swap so protocol frames can never be swallowed. */
const protocolWrite = process.stdout.write.bind(process.stdout)

const INSPECT = {
  depth: 4,
  maxArrayLength: 100,
  maxStringLength: 20_000,
  breakLength: 100,
  colors: false,
  compact: 3,
}

const requireFromCwd = createRequire(path.join(CWD, '__dsh_node_repl__.js'))

/** Curated globals. `require`/`loadModule` resolve relative to the configured cwd. */
const sandbox = {
  console,
  process,
  Buffer,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  AbortController,
  AbortSignal,
  structuredClone,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  fetch,
  require: requireFromCwd,
  /** ESM loader — dynamic `import()` is unavailable inside a vm context. */
  loadModule: (specifier) => import(specifier),
  __cwd: CWD,
}
sandbox.globalThis = sandbox

const context = vm.createContext(sandbox)

/** True when the only problem is top-level await in a plain script. */
function isTopLevelAwait(error) {
  return error instanceof SyntaxError && /await is only valid in async/i.test(error.message)
}

/** Statement keywords that must not be turned into `return <keyword> ...`. */
const NON_EXPRESSION_START =
  /^(return|const|let|var|if|for|while|do|switch|try|function|class|import|export|throw|\{|\})/
/** A line ending in one of these clearly continues onto the next line. */
const CONTINUES_AFTER = /[+\-*/%&|^=,([{.:?!<>~]$/
/** A line starting with one of these clearly continues the previous line. */
const CONTINUES_BEFORE = /^(\.|\(|\[|\)|\]|\}|,|;|\+|-|\*|\/|%|&|\||\^|=|\?|:|=>|<|>)/

/**
 * Split code into top-level statements, on `;` and on newlines that plainly end
 * a statement. Used only to find a trailing expression to return; the result is
 * compile-checked by the caller, so a mis-split degrades rather than breaks.
 */
function splitStatements(code) {
  const out = []
  let current = ''
  let depth = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  let lastSignificant = ''

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    const next = code[i + 1]

    if (lineComment) {
      current += ch
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += next
        i++
        blockComment = false
      }
      continue
    }
    if (quote) {
      current += ch
      if (ch === '\\') {
        current += next ?? ''
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      current += ch
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      current += ch
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      current += ch
      continue
    }

    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--

    if (depth === 0 && ch === ';') {
      out.push(current)
      current = ''
      lastSignificant = ''
      continue
    }
    if (depth === 0 && ch === '\n') {
      const nextLine = code
        .slice(i + 1)
        .split('\n')
        .find((line) => line.trim() !== '')
      const nextStart = (nextLine ?? '').trimStart()
      if (!CONTINUES_AFTER.test(lastSignificant) && !CONTINUES_BEFORE.test(nextStart)) {
        out.push(current)
        current = ''
        lastSignificant = ''
        continue
      }
    }

    current += ch
    if (!/\s/.test(ch)) lastSignificant = ch
  }

  if (current.trim() !== '') out.push(current)
  return out
}

/**
 * Rewrite a snippet so its final expression becomes the async wrapper's return
 * value. A plain Script yields its completion value, but a function body does
 * not, so the top-level-await path needs this to behave like the sync path.
 *
 * The rewrite is only kept when it still compiles; otherwise the original code
 * is used and the call simply yields `undefined`.
 */
function withTrailingReturn(code) {
  const parts = splitStatements(code)
  for (let i = parts.length - 1; i >= 0; i--) {
    const trimmed = parts[i].trim()
    if (trimmed === '') continue
    if (NON_EXPRESSION_START.test(trimmed)) return code
    parts[i] = `return ${trimmed}`
    const candidate = parts.join('\n')
    try {
      new vm.Script(`(async () => {\n${candidate}\n})()`)
      return candidate
    } catch {
      return code
    }
  }
  return code
}

function formatError(error) {
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`
    if (!error.stack) return head
    const frames = error.stack
      .split('\n')
      .slice(1)
      .filter((line) => !line.includes('node:vm') && !line.includes('node:internal'))
      .slice(0, 6)
    return frames.length > 0 ? `${head}\n${frames.join('\n')}` : head
  }
  return `Thrown: ${util.inspect(error, INSPECT)}`
}

/**
 * Evaluate one snippet, capturing everything it prints.
 * @returns {Promise<{ok: boolean, value?: string, error?: string, logs: string[]}>}
 */
async function evaluate(code, timeoutMs) {
  const logs = []
  const push = (text) => logs.push(text)
  const record = (...args) => push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, INSPECT))).join(' '))
  const capture = { log: record, info: record, warn: record, error: record, debug: record, trace: record, dir: record, table: record, group: record, groupEnd: () => {} }

  const previousConsole = sandbox.console
  const previousOut = process.stdout.write
  const previousErr = process.stderr.write
  const sink = (chunk) => {
    push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }

  sandbox.console = capture
  process.stdout.write = sink
  process.stderr.write = sink

  try {
    let value
    try {
      value = new vm.Script(code, { filename: 'node_repl' }).runInContext(context, { timeout: timeoutMs })
    } catch (error) {
      if (!isTopLevelAwait(error)) throw error
      // Top-level await: re-run wrapped. Note this path cannot persist top-level
      // `let`/`const` (they bind inside the wrapper), which the README documents.
      const wrapped = `(async () => {\n${withTrailingReturn(code)}\n})()`
      value = await new vm.Script(wrapped, { filename: 'node_repl' }).runInContext(context, { timeout: timeoutMs })
    }
    return { ok: true, value: util.inspect(value, INSPECT), logs }
  } catch (error) {
    return { ok: false, error: formatError(error), logs }
  } finally {
    process.stdout.write = previousOut
    process.stderr.write = previousErr
    sandbox.console = previousConsole
  }
}

// ---------------------------------------------------------------- message loop

let queue = Promise.resolve()
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim() === '') continue
    queue = queue.then(() => handle(line))
  }
})
process.stdin.on('end', () => process.exit(0))

async function handle(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const timeoutMs = Number.isFinite(message.timeoutMs) && message.timeoutMs > 0 ? message.timeoutMs : 30_000
  let result
  try {
    result = await evaluate(String(message.code ?? ''), timeoutMs)
  } catch (error) {
    result = { ok: false, error: formatError(error), logs: [] }
  }
  protocolWrite(JSON.stringify({ id: message.id, ...result }) + '\n')
}

protocolWrite(JSON.stringify({ ready: true, cwd: CWD, pid: process.pid }) + '\n')
