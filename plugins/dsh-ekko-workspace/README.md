# dsh-ekko-workspace

A default workspace for project-less DSH sessions, modeled on WorkBuddy's
answer to the same problem.

DSH groups sessions by workspace with a strict rule: a session belongs to a
workspace exactly when its cwd IS the workspace's directory. The Web UI only
creates sessions through `sessions.create({workspaceId})`, so every session in
a workspace shares one cwd — and the global 新建会话 button opens a session in
the current or most recent workspace, or nothing at all. WorkBuddy's default
workspace gives project-less chats a home instead: one aggregate category,
with a fresh timestamped scratch folder per session as its pwd.

This plugin's **host half** installs that behavior in three moves, all scoped
to the default workspace only:

1. **Register the category.** At load it mkdir -p's the root
   (`$DSH_HOME/workspaces`, configurable) and registers it as a real workspace
   titled 默认工作区 — prepended to the sidebar order, so the native tree
   shows it before anything else, with no UI replaced.
2. **Relax membership for the root.** `Workspace.attachSession` also accepts
   a cwd strictly under the default root, and the `sessionIds` membership
   getter also counts sessions whose remembered cwd is under it. Every other
   workspace keeps native cwd-equality semantics; the durable registry only
   ever logs filtered candidates, so membership survives restarts.
3. **Reroute default-workspace creates.** `sessionController.create` is
   wrapped: a request naming the default workspace runs through the cwd branch
   with `cwd = <root>/YYYY-MM-DD-HH-mm-ss` (local time; `-2`, `-3`… on
   collision — the host mkdir -p's session cwds), then attaches the session.
   The wire contract stays `workspaceId xor cwd`; foreign workspaceIds,
   explicit cwds, and bare SDK creates pass through untouched.

Forks inherit the source session's scratch cwd (DSH semantics), so a forked
conversation keeps working in the same folder. Because DSH binds a session's
workspace to its cwd, a session cannot be moved between workspaces — sessions
that predate this plugin stay where they are (未分组), archivable as usual.
Session folders survive session deletion on purpose — they are deliverables,
not caches.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `root` | `''` | Backing directory; empty = `$DSH_HOME/workspaces`. |
| `title` | `'默认工作区'` | Sidebar title; a user-renamed title is never overwritten. |

## What it touches

Nothing in the browser. On the host:

| Seam | Change |
|---|---|
| `WorkspaceRegistry.create` | one idempotent call at load, to register the root |
| `Workspace.prototype.sessionIds` | getter relaxation, default root only |
| `Workspace.prototype.attachSession` | equality → under-root, default root only |
| `Workspace.prototype.mutate` | durable filter keeps under-root members, default root only |
| `sessionController.create` | workspaceId → timestamped cwd + attach, default id only |

Every patch restores itself when the plugin is disposed, and every failure is
a warning — this plugin must never be the reason a session cannot be created.

## Install

The ekkobuddy loadout installs it as a direct dependency. Manually:

```
dsh plugin --profile <name> add dsh-ekko-workspace-<version>.tgz
```

## Test

```
pnpm test
```
