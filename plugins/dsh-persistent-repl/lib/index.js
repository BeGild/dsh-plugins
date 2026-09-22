/**
 * dsh-persistent-repl — a persistent JavaScript REPL for DeepSeek Harness.
 *
 * Registers `node_repl`: evaluate JavaScript in a long-lived child process whose
 * top-level bindings survive between calls, so a multi-step computation keeps its
 * state instead of re-deriving it every turn.
 *
 * The child is a separate process on purpose — a runaway loop, an OOM or a
 * `process.exit()` in evaluated code kills only the REPL host, and the next call
 * transparently starts a fresh one.
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { NodeReplError, NodeReplHost } from './repl.js'

export const name = 'dsh-persistent-repl'
export const inject = ['tools']

/**
 * @typedef {object} Config
 * @property {number}  defaultTimeoutMs  Budget applied when a call omits `timeout_ms`.
 * @property {number}  maxTimeoutMs      Upper bound a call may request via `timeout_ms`.
 * @property {number}  maxOutputChars    Cap on the returned value + logs, in characters.
 * @property {string}  cwd               Working directory for the REPL process. Empty = harness cwd.
 */

export const Config = Schema.object({
  defaultTimeoutMs: Schema.number().default(30_000),
  maxTimeoutMs: Schema.number().default(120_000),
  maxOutputChars: Schema.number().default(20_000),
  cwd: Schema.string().default(''),
})

/** Clip long output while saying so, rather than silently truncating. */
function clip(text, limit) {
  if (typeof text !== 'string') return text
  if (text.length <= limit) return text
  const dropped = text.length - limit
  return `${text.slice(0, limit)}\n… [truncated ${dropped} more character${dropped === 1 ? '' : 's'}]`
}

const DESCRIPTION = [
  'Execute JavaScript in a persistent Node.js REPL and get the result back.',
  '',
  'State persists across calls: top-level `var`, `function`, `let` and `const` bindings stay',
  'visible to later calls, so you can build a value once and keep working on it. Use this for',
  'computation, data wrangling, parsing, and anything easier to express in JavaScript than in a',
  'shell command. `console.log` output is captured and returned alongside the result.',
  '',
  'Notes: the snippet runs in a separate Node process (a crash there cannot take down the',
  'harness); `require` and `loadModule` resolve relative to the configured working directory;',
  'top-level `await` is supported, but a snippet that uses it cannot persist top-level `let`/',
  '`const` declarations. A call that exceeds its timeout kills and restarts the REPL, losing',
  'its state, so pass `timeout_ms` for genuinely long work.',
].join('\n')

export function apply(ctx, config) {
  const settings = {
    defaultTimeoutMs: config?.defaultTimeoutMs ?? 30_000,
    maxTimeoutMs: config?.maxTimeoutMs ?? 120_000,
    maxOutputChars: config?.maxOutputChars ?? 20_000,
    cwd: config?.cwd ?? '',
  }

  const host = new NodeReplHost({ cwd: settings.cwd })

  // The child process outlives individual calls, so it needs an explicit
  // disposer: unloading the plugin must not leave an orphaned Node process.
  ctx.effect(() => () => {
    void host.stop()
  })

  ctx.tools.register(defineTool({
    name: 'node_repl',
    description: DESCRIPTION,
    parameters: {
      code: {
        type: 'string',
        required: true,
        description:
          'JavaScript to evaluate. The value of the final expression is returned. Declarations at the top level persist for later calls.',
      },
      timeout_ms: {
        type: 'number',
        description: `Execution budget in milliseconds (default ${settings.defaultTimeoutMs}, max ${settings.maxTimeoutMs}). Pass this when the snippet may take a while.`,
      },
      reset: {
        type: 'boolean',
        description: 'Kill and restart the REPL first, discarding all existing bindings.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          value: { type: 'string' },
          logs: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, result) => [{ type: 'text', text: renderResult(result) }],
    },
    async execute(args) {
      if (args.reset === true) await host.stop()

      const requested = args.timeout_ms ?? settings.defaultTimeoutMs
      const timeoutMs = Math.max(1, Math.min(requested, settings.maxTimeoutMs))
      if (requested > settings.maxTimeoutMs) {
        throw new NodeReplError(
          `timeout_ms ${requested} exceeds the configured maxTimeoutMs (${settings.maxTimeoutMs}).`,
        )
      }

      const outcome = await host.run(args.code, timeoutMs)
      const logs = (outcome.logs ?? []).map((line) => clip(line, settings.maxOutputChars))

      if (outcome.ok) {
        return { ok: true, value: clip(outcome.value ?? '', settings.maxOutputChars), logs }
      }
      return {
        ok: false,
        error: clip(outcome.error ?? 'unknown error', settings.maxOutputChars),
        logs,
      }
    },
  }))

  ctx.logger?.info?.(`[${name}] registered node_repl (cwd=${settings.cwd || process.cwd()})`)
}

/** Model-facing rendering: logs first, then the value or the error. */
export function renderResult(result) {
  const parts = []
  if (result.logs && result.logs.length > 0) parts.push(result.logs.join('\n'))
  if (result.ok) {
    if (result.value !== undefined && result.value !== 'undefined') parts.push(result.value)
    else if (parts.length === 0) parts.push('(no output)')
  } else {
    parts.push(`Error: ${result.error}`)
  }
  return parts.join('\n')
}
