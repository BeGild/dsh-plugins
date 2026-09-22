# dsh-persistent-repl

A **persistent Node.js REPL** for DeepSeek Harness.

Adds one tool, `node_repl`, which evaluates JavaScript in a long-lived child
process. Top-level bindings **survive between calls**, so a multi-step
computation keeps its state instead of re-deriving it every turn:

```
node_repl: const rows = await (await fetch(url)).json()
node_repl: const bad = rows.filter(r => r.status !== 'ok')
node_repl: bad.length          → 3
node_repl: bad.map(r => r.id)  → [ 'a1', 'b7', 'c9' ]
```

## Why this exists

DSH's builtin `run_code` (PTC preset) runs each snippet in isolation — by design
its runs are "isolate[d] from one another", so nothing carries over. That is
right for programmatic tool calling, but it means there is no general-purpose
**Node.js** REPL you can build on. This plugin fills that specific gap: a real
persistent JavaScript session.

## Parameters

| Parameter    | Type    | Required | Meaning                                                                   |
| ------------ | ------- | -------- | ------------------------------------------------------------------------- |
| `code`       | string  | yes      | JavaScript to evaluate. The final expression's value is returned.         |
| `timeout_ms` | number  | no       | Execution budget (default `defaultTimeoutMs`, capped by `maxTimeoutMs`).  |
| `reset`      | boolean | no       | Kill and restart the REPL first, discarding all existing bindings.        |

`console.log` / `console.error` / `process.stdout.write` output is captured and
returned alongside the result rather than leaking to the harness's own stdout.

## Configuration

| Key                | Type   | Default | Meaning                                                     |
| ------------------ | ------ | ------- | ----------------------------------------------------------- |
| `defaultTimeoutMs` | number | `30000` | Budget applied when a call omits `timeout_ms`.              |
| `maxTimeoutMs`     | number | `120000`| Upper bound a call may request.                             |
| `maxOutputChars`   | number | `20000` | Cap on the returned value plus captured logs.               |
| `cwd`              | string | `''`    | REPL working directory (empty = harness cwd); base for `require`. |

## Behaviour and limits

- **Persistence**: `var`, `function`, `let` and `const` declared at the top level
  all persist, because every snippet runs in one long-lived `vm` context (the
  same semantics a browser gives two `<script>` tags). Re-declaring an existing
  `const`/`let` throws, exactly as it does in a real REPL.
- **Top-level `await` is supported.** A snippet that uses it is re-run wrapped in
  an async function, and the trailing expression is returned. Because of that
  wrapper, top-level `let`/`const` declared *in an `await`-using snippet do not
  persist* — assign to an existing binding, or use `var`, if you need them to.
- **Timeouts**: a synchronous runaway loop is stopped by the `vm` timeout. An
  *asynchronous* hang cannot be (the `vm` timeout only covers synchronous
  execution), so the parent enforces a wall-clock deadline and then **kills and
  restarts** the REPL process. State from that call is lost; the next call works
  from a clean process. Pass a larger `timeout_ms` for genuinely long work.
- **Isolation is process-level, not a security boundary.** The REPL is a child
  process, so a crash, an OOM or a `process.exit()` there cannot take down the
  harness — but the evaluated code still runs with your own user permissions. See
  the security note below.
- `require` and `loadModule(specifier)` resolve relative to `cwd`; `loadModule`
  exists because dynamic `import()` is unavailable inside a `vm` context.

## Install

```sh
dsh plugin --profile web add dsh-persistent-repl             # npm
dsh plugin --profile web add ./dsh-persistent-repl-0.1.0.tgz # tarball
```

## Verification

```sh
node test/repl.test.mjs     # 18 checks; spawns real child processes
```

The suite covers module shape, tool registration, the effect disposer, state
persistence across calls (`const`, `var`, function, object mutation), log
capture, thrown and syntax errors, top-level `await` (including the
single-line `stmt; expr` and un-semicoloned multi-line forms), `reset`,
synchronous and asynchronous timeout handling with restart, and rendering.

## Security note — this plugin is not sandboxed

DSH's file sandbox (`read-only` / `workspace-write` / `danger-full-access`)
governs **model-initiated tool requests**; it does not constrain plugin code.
This plugin executes arbitrary JavaScript with the harness process's own
permissions — the same trust level as the built-in shell tool. It performs **no
network access of its own** (though evaluated code can, via `fetch`), and reads
no credentials by itself.

## Scope and limits

- One REPL process per plugin instance (i.e. per harness process); it is not
  partitioned per session or per agent.
- The child process is killed when the plugin unloads (registered via
  `ctx.effect`), so no orphaned Node process is left behind.
- Not a sandboxed code interpreter: do not treat it as one.

## License

MIT
