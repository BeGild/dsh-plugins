# dsh-session-introspect

Model-callable introspection of **live** DeepSeek Harness sessions.

The harness already hands plugins an event-sourced session store on
`ctx.sessions`, but nothing exposes it to the model. This plugin registers one
tool, `session_introspect`, so the model can ask what its own session looks
like, what other sessions are running beside it, and what actually happened in
one of them.

## What it registers

One tool — `session_introspect` — with five operations:

| `op` | Returns |
|---|---|
| `self` | The calling session: id, cwd, event / message / surface counts, fork lineage, delegation depth, agent preset. |
| `list` | Every live session, newest first. Includes subagents and sibling sessions. |
| `events` | A bounded window of one session's event log, with a per-event text preview. Narrow with `fromSeq` / `toSeq` (inclusive) and `type`. |
| `surface` | The event sequence numbers currently visible to the model, after any compaction. |
| `lineage` | Ancestors (walking `parentSession`) and descendants of a session. |

It is **read-only**: the plugin appends no events, writes no files, and opens no
network connections. It cannot change what the model sees on the next turn.

## Configuration

All four keys are optional; the defaults apply when omitted.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxEvents` | number | `50` | Upper bound on events one `events` call may return. |
| `maxSessions` | number | `50` | Upper bound on sessions one `list` call may return. |
| `maxTextChars` | number | `300` | Per-event text preview bound, in characters. |
| `includeChunks` | boolean | `false` | Include token-level `assistant/chunk` events. |

```yaml
- insert:
    - id: dsh-session-introspect
      name: dsh-session-introspect
      config:
        maxEvents: 100
        maxTextChars: 600
```

A DSH patch entry replaces the target row's `config` **wholesale** — it is not a
deep merge — so if you set one key, restate the others you care about.

## Install

```sh
dsh plugin --profile web add dsh-session-introspect
```

Installing a plugin changes the request prefix, which invalidates the prompt
cache from that point on. Expect a slower, more expensive first turn.

## Limits — stated plainly

- **Only sessions live in this process are visible.** A session persisted by an
  earlier run is not reachable through this tool; it is not backed by a
  persistence or search service.
- **`assistant/chunk` events are hidden by default.** They are token-level
  replay fidelity, not conversation; set `includeChunks` to see them.
- **A call with no owning agent must name a session.** `op: self` and any op
  without `sessionId` need `exec.agent`; otherwise the tool fails with a clear
  error rather than guessing.
- **The session API is reached through `ctx` at call time, never imported.**
  DSH starts all-or-nothing, so a plugin that throws while loading takes the
  whole harness down. Reading `ctx.sessions` lazily turns a host without that
  service into a tool error instead. It also means no peer range is guessed
  against a pre-stable package.

## Security

Plugin code is **not** constrained by the harness file-permission tiers
(`read-only` / `workspace-write` / `danger-full-access`) — those gate only
tool requests the model makes. A plugin runs with the user account's full
privileges.

This plugin does not exercise that power: it reads the in-memory session store
and nothing else. There is no filesystem access, no subprocess, and no network
call. Every fact it returns is already in the harness process's memory.

## License

MIT
