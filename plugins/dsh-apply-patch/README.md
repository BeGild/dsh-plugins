# dsh-apply-patch

Apply a **structured multi-file patch** to DeepSeek Harness in a single tool call.

Adds one tool, `apply_patch`, which adds, updates, deletes or moves any number of
files in one go — and, unlike a sequence of `edit` calls, is **atomic at the
content level**: the entire patch is parsed and planned before a single byte is
written, so if any hunk fails to match, *nothing* is modified.

## Why

An agent changing the same logical edit across several files (rename a field,
thread a new parameter through call sites, split a module) currently issues many
independent `edit` calls. Each one can fail on its own, leaving the tree in a
half-applied state that the next turn has to reason about. `apply_patch` turns
that into one all-or-nothing operation.

## Patch format

Codex/ZCode-style structured patch text. `*** Begin Patch` and `*** End Patch`
are optional.

```
*** Begin Patch
*** Add File: src/new-module.ts
+export const answer = 42
*** Update File: src/existing.ts
@@ optional context hint @@
 unchanged context line
-removed line
+added line
*** Delete File: src/obsolete.ts
*** Move File: src/old-name.ts -> src/new-name.ts
*** End Patch
```

Rules:

- In an update section every body line must start with one space (context),
  `-` (remove) or `+` (add). A genuinely empty line means an empty context line.
- Context lines must match the file **as it is on disk right now** — read the
  file first.
- A move may also be spelled `*** Update File: a` followed by `*** Move to: b`
  (which may be combined with hunks, i.e. move-and-edit in one section).

### Matching tolerance

Context matching degrades gracefully so a nearly-correct patch is not rejected
outright: exact match first, then ignoring trailing whitespace, then ignoring
whitespace runs. **Context lines are always taken from the file**, never from the
patch, so a fuzzy match never rewrites whitespace the patch did not ask to
change. Line endings (LF/CRLF) and a missing final newline are preserved.

## Parameters

| Parameter    | Type    | Required | Meaning                                                              |
| ------------ | ------- | -------- | -------------------------------------------------------------------- |
| `patch_text` | string  | yes      | The structured patch, in the format above.                           |
| `dry_run`    | boolean | no       | Validate and plan, report what *would* change, write nothing.        |

## Configuration

Every field is optional; defaults apply when omitted.

| Key                 | Type    | Default    | Meaning                                                        |
| ------------------- | ------- | ---------- | -------------------------------------------------------------- |
| `rootDir`           | string  | `''`       | Root relative paths resolve against. Empty = harness process cwd. |
| `allowOutsideRoot`  | boolean | `false`    | Permit paths outside `rootDir`.                                |
| `maxFilesPerPatch`  | number  | `50`       | Refuse patches touching more file sections than this.           |
| `maxPatchChars`     | number  | `400000`   | Refuse patch text longer than this.                             |
| `createParentDirs`  | boolean | `true`     | `mkdir -p` parent directories for added files.                  |

Paths outside `rootDir` are rejected unless `allowOutsideRoot` is on.

## Install

```sh
dsh plugin --profile web add dsh-apply-patch          # npm
dsh plugin --profile web add ./dsh-apply-patch-0.1.0.tgz   # tarball
```

## Verification

```sh
node test/patch.test.mjs     # 22 core cases, no harness needed
```

The suite covers add/update/delete/move, multi-hunk and multi-file patches,
sequential ops on the same file, CRLF and missing-final-newline preservation,
whitespace-tolerant matching, and the atomicity guarantee (a failing hunk
anywhere produces no write).

## Security note — this plugin is not sandboxed

DSH's file sandbox (`read-only` / `workspace-write` / `danger-full-access`)
governs **model-initiated tool requests**; it does not constrain plugin code.
This plugin reads and writes files directly with the harness process's own
permissions, so the sandbox does not apply to it. `rootDir` and
`allowOutsideRoot` are the guard rails, and both are configurable.

The plugin performs **no network access**, spawns no processes, and reads no
credentials. It touches only the paths named in the patch it is given.

## Scope and limits

- Atomicity is at the **content** level: the whole patch is planned before
  writing. It is not a filesystem transaction — a disk error part-way through
  the write phase can still leave some files written.
- Each file section is applied once, in order; later sections in the same patch
  see the effects of earlier ones (so an added file can be updated afterwards).
- Not a `git apply` replacement: it does not understand arbitrary unified diffs,
  only the structured directive format above.

## License

MIT
