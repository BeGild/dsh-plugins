# dsh-loop-runner

Two kinds of scheduled jobs for DeepSeek Harness (DSH), one engine, one native web panel —
and both kinds are creatable by the agent itself through model tools, no UI clicking required.

- **Watch jobs (zero tokens)** — a local JS adapter script runs on a schedule (`interval` /
  5-field `cron` / one-shot). Its output is deduplicated and aggregated into a durable event
  queue; **only when something deserves attention** does an event escalate into a real agent
  session. Polling costs no model tokens.
- **Agent jobs (tokens per run)** — a prompt runs through an agent session on a cron /
  interval / one-shot schedule, optionally pinned to one continuing session for context.

The scheduling semantics are ported from the battle-tested
[loop-runner](https://github.com/BeGild) skill: stable-id dedupe is the delivery authority,
`baseline: ignore` prevents first-poll backlog floods, missed slots are skipped (never
backfilled), and a failed escalation never acknowledges — the event retries with backoff and
can be requeued after the cause is fixed.

## What you get

| Surface | Where |
|---|---|
| `job_create` + 9 more model tools | the agent creates/manages jobs conversationally (`job_list`, `job_status`, `job_pause`, `job_resume`, `job_update`, `job_run_now`, `job_remove`, `events_requeue`, `consume_once`) |
| 「定时任务」 web panel | a native DSH Web sidebar panel (official `sidebar.panellist` seat) with three views: 巡检场景 / Agent 任务 / 升级历史, plus per-job detail (executions, event queue, escalation records) and L1 actions (pause/resume/poll-now/requeue) |
| Escalation ledger | every agent run is recorded (trigger, session id, outcome, text preview) at `$DSH_HOME/loop-runner/state.json` |

## Architecture

```
DSH host process (single plugin, zero runtime deps)
  ticker (ctx.setInterval, default 30s)
   ├─ watch job due → spawn `node adapter.js` child (hard timeout)
   │    → validate JSON-Lines records → dedupe (seen set) → aggregate window → enqueue event
   ├─ agent job due → escalation engine directly
   └─ consumer: pending event → claim (global concurrency cap) → escalate → ack
        escalation: ctx.agents.create / agents.resume → followup → whenIdle
                    → assistant text extracted from the session log → ledger
        failure: event back to pending with exponential backoff; dead after N attempts
```

Everything persists in one JSON state file (atomic tmp+rename writes, self-repairing load,
retention pruning). No SQLite, no native modules, nothing to `allowBuilds`.

## The adapter contract (watch jobs)

A watch adapter is a plain Node script executed as `node adapter.js` with a hard timeout
(default 60s). It must:

- print zero or more **JSON Lines** to stdout, one object per line:
  `{"id": "...", "payload": <any JSON>, "group_key"?: "...", "occurred_at"?: "ISO-8601"}`;
- exit `0` (empty stdout = a quiet, successful poll); diagnostics go to stderr only;
- use **stable ids** across polls — the runtime dedupes on them. For reminder-style watchers
  derive the id from the wall-clock slot (`"rem:2026-10-12:3"`), poll ~5× faster than the
  slot, gate on active hours, and anchor slots to the wall clock so restarts cannot
  double-fire or backfill;
- be **read-only**: never send, approve, move or otherwise mutate the watched source inside
  the adapter — that is the escalated agent's job, under your approval flow;
- read credentials from the environment or an authenticated CLI session, never print them.

`SCENARIO_NOW` in the adapter environment pins the clock for deterministic tests (see the
`job_create` tool description for the condensed contract the model follows).

## Install

```sh
dsh plugin --profile web add dsh-loop-runner        # from npm (once published)
dsh plugin --profile web add ./dsh-loop-runner-0.1.0.tgz
```

Requires a `dsh web` profile (the panel rides the web server) whose host also
provides agent services (`agents` is a hard inject — escalation is the point of
the plugin). On a host without them the plugin parks and the boot fails loudly
instead of escalating into nothing.

## Config (all optional, schemastery defaults)

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `dataDir` | `$DSH_HOME/loop-runner` (else `~/.dsh/loop-runner`) | state file + default scenarios root |
| `scenariosRoot` | `<dataDir>/jobs` | where `adapter.js` files live (one dir per job id) |
| `tickerSeconds` | `30` | scheduling pass cadence (min 5) |
| `maxConcurrentEscalations` | `2` | global in-flight agent escalations |
| `escalationMode` | `fresh` | default per-job session mode (`fresh` \| `pinned`) |
| `escalationProvider` / `escalationModel` | — | default route for escalation sessions (unset = host default) |
| `escalationTimeoutMinutes` | `30` | per-run agent timeout (cancel + settle failed) |
| `consumerMaxAttempts` | `5` | retries before an event is `dead` (requeueable) |
| `seenRetentionDays` / `eventRetentionDays` | `90` / `30` | dedupe / consumed-event pruning |
| `announceToAgent` | `true` | system-prompt section advertising the tools |
| `uiPollMs` | `5000` | panel refresh cadence |

## Security notes (read before installing)

- Like every DSH plugin, this code runs with **your full user privileges** — the harness
  permission tiers do not constrain plugins. It spawns child processes (`node adapter.js`)
  and creates agent sessions on your behalf.
- Adapter scripts are written by your own agent (via `job_create`) or by you; they can do
  anything you can. The read-only rule is a discipline, not a sandbox.
- The panel routes (`/api/dsh-loop-runner/*`) answer **loopback requests only**.
- Escalated agent runs consume tokens; watch-job polling does not.

## Development

```sh
cd plugins/dsh-loop-runner
npm install            # devDependencies only (cordis, dsh-tools, schemastery)
npm test               # 9 suites: schedule/store/engine/consumer/escalation/tools/routes/client/load
```

Fast loop (source, no packaging):

```yaml
# dev/cordis.yml
- insert:
    - id: loop-runner
      name: /absolute/path/to/plugins/dsh-loop-runner/lib/index.js
```

```sh
dsh web --patch ./dev/cordis.yml
```

Slow loop: `npm pack` → `dsh plugin --profile demo add ./dsh-loop-runner-0.1.0.tgz`.

## Status

v0.1.0 — self-built, pre-npm-publish. Peer-tested against `@deepseek-ai/cordis ^4.0.1` and
`@deepseek-ai/dsh-tools` with an explicit prerelease branch (installable on rc hosts).
MIT.
