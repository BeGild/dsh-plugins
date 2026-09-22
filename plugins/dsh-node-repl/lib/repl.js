/**
 * dsh-node-repl host manager — owns the persistent evaluation child process.
 *
 * Responsibilities:
 *  - spawn / lazily restart the host (lib/repl-host.cjs) as a separate process;
 *  - frame requests and match replies by id;
 *  - enforce a per-call wall-clock deadline, and KILL + RESTART the host when it
 *    is exceeded, because a hung evaluation blocks the single-threaded child
 *    forever (the vm timeout only covers synchronous execution);
 *  - fail every in-flight call cleanly when the host dies.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOST_PATH = fileURLToPath(new URL('./repl-host.cjs', import.meta.url))
const START_TIMEOUT_MS = 20_000
/** Extra grace on top of the vm timeout before we declare the host hung. */
const TIMEOUT_GRACE_MS = 5_000

export class NodeReplError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NodeReplError'
  }
}

export class NodeReplHost {
  /** @param {{cwd?: string, env?: Record<string,string>}} options */
  constructor(options = {}) {
    this.cwd = options.cwd && options.cwd !== '' ? options.cwd : process.cwd()
    this.extraEnv = options.env ?? {}
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.ready = null
    this.starting = null
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  /** Start the host if it is not already running. */
  async ensureStarted() {
    if (this.running) return
    if (this.starting) return this.starting

    this.starting = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOST_PATH], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.extraEnv, DSH_NODE_REPL_CWD: this.cwd },
      })
      this.child = child
      this.buffer = ''

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.kill('SIGKILL')
        } catch {}
        reject(new NodeReplError(`node_repl host did not become ready within ${START_TIMEOUT_MS} ms`))
      }, START_TIMEOUT_MS)

      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk
        let newline
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, newline)
          this.buffer = this.buffer.slice(newline + 1)
          if (line.trim() === '') continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.ready === true) {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              resolve()
            }
            continue
          }
          const waiter = this.pending.get(message.id)
          if (waiter) {
            this.pending.delete(message.id)
            clearTimeout(waiter.timer)
            waiter.resolve(message)
          }
        }
      })

      child.on('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new NodeReplError(`failed to start node_repl host: ${error.message}`))
          return
        }
        // Generation guard: a replaced child's late event must not tear down its
        // successor (the timeout path kills a child and spawns a new one).
        if (this.child !== child) return
        this.failAll(new NodeReplError(`node_repl host errored: ${error.message}`))
      })

      child.on('exit', (code, signal) => {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').trim()
        const reason =
          `node_repl host exited (code=${code}${signal ? `, signal=${signal}` : ''})` + (detail ? `: ${detail}` : '')
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new NodeReplError(reason))
          return
        }
        if (this.child !== child) return
        this.failAll(new NodeReplError(reason))
      })
    }).finally(() => {
      this.starting = null
    })

    return this.starting
  }

  /** Reject every in-flight request (host died, or was killed on timeout). */
  failAll(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    this.child = null
  }

  /**
   * Evaluate a snippet in the persistent host.
   * @param {string} code
   * @param {number} timeoutMs synchronous execution budget for this snippet
   * @returns {Promise<{ok: boolean, value?: string, error?: string, logs: string[]}>}
   */
  async run(code, timeoutMs) {
    await this.ensureStarted()
    const child = this.child
    if (!child) throw new NodeReplError('node_repl host is not running')

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A hung snippet wedges the single-threaded host: kill it so the next
        // call starts from a clean process rather than queueing behind it.
        try {
          child.kill('SIGKILL')
        } catch {}
        this.failAll(new NodeReplError('node_repl host was restarted after a timeout'))
        reject(
          new NodeReplError(
            `evaluation exceeded ${timeoutMs} ms (plus ${TIMEOUT_GRACE_MS} ms grace). ` +
              'The REPL process was killed and will restart on the next call, so variables from this call are lost. ' +
              'Raise timeout_ms for genuinely long work, or split it into smaller snippets.',
          ),
        )
      }, timeoutMs + TIMEOUT_GRACE_MS)

      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(JSON.stringify({ id, code, timeoutMs }) + '\n')
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new NodeReplError(`failed to send code to node_repl host: ${error.message}`))
      }
    })
  }

  /** Kill the host, discarding all state. */
  async stop() {
    const child = this.child
    this.child = null
    this.failAll(new NodeReplError('node_repl host was reset'))
    if (child && child.exitCode === null) {
      try {
        child.stdin.end()
        child.kill('SIGKILL')
      } catch {}
    }
  }
}
