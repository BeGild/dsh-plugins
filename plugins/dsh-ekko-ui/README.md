# dsh-ekko-ui

Renders a DSH conversation's agent output the way the best agent tools do (initial design language from WorkBuddy; more to be absorbed over time). A finished turn collapses to one line naming what it did, and each tool call is a borderless status line instead of a card. It adds no tools, opens no socket, and reads no file.

## What changes

**The turn line.** DSH's compact mode folds a finished turn behind a row that counts: "3 次工具调用 · 1 条消息". This plugin replaces that row. The line is built from the turn's tool calls:

| The turn did | The line says |
| --- | --- |
| read `docs/README.md` | 读取 README.md |
| read two files | 查看 README.md |
| read it and then edit it | 查看文件、修改：README.md |
| search for `auth`, still running | 正在搜索 auth |
| nothing | 已思考 |

One call names its verb and object. Several calls of one kind name that kind. Two kinds name both. More than three kinds with nothing to name count the kinds. Clicking the line still opens and closes the turn's process rows, through the same state DSH keeps for compact mode.

**The tool line.** DSH draws each tool call as a bordered card titled "Read" or "Bash" with the path beside it. This plugin replaces the built-in tools — `read`, `read_image`, `bash`, `pwsh`, `grep`, `glob`, `write`, `edit`, `web_search`, `web_fetch`, `todo_write` — with one line: a 14px mark, a verb, and the file, command, or query. A read says "读取中" while it runs and "已读取" once it settles; a failure says "执行失败". A running verb shimmers. The line expands in place to show the tool's text result, and the arrow appears on hover. A tool this plugin does not list keeps DSH's own card.

## Build

`lib/client.js` inlines the syntax highlighter. To rebuild it after editing `highlight-entry.mjs`:

    pnpm install --no-save esbuild@0.24.2
    pnpm run build:hl

Then re-inline the generated `lib/highlight.bundle.js` into `lib/client.js` (the `var wbhl = (function () {…})()` block at the top) and bump the version.

## Install

```sh
dsh plugin --profile web add ./plugins/dsh-ekko-ui
```

Then restart that profile. A running profile keeps the bundle set it booted with, so the rows do not change until the next start.

Confirm the layer is present without booting:

```sh
dsh --profile web --dump-config
```

The output should contain a `# == dsh-ekko-ui` layer.

## Conflicts

The plugin occupies `conversation.chat.node` at `turn-process` and `tool.call.toolview` at each built-in tool name above. A later plugin that registers the same key replaces that one row; this plugin does not stack with it. It does not register a theme, so it does not occupy the Appearance selector.

## Security

The plugin registers no host service, opens no socket, and reads no file. It registers a conversation definition and two kinds of row in the Web UI, and it appends one `style` element for those rows. Unloading the plugin drops the registrations and removes the element. Like every DSH plugin it runs with the host user's privileges rather than inside the tool sandbox; there is nothing here that uses that.

## Limitations

- Only the Web UI. The terminal and CLI transcript are untouched.
- The turn line is computed from tool calls. It does not read the assistant's prose to invent a topic the way WorkBuddy does when a call has no object, so a turn whose calls name nothing falls back to the group line ("查看相关文件") or "已思考".
- Replacing a built-in tool row drops that tool's rich card. An edit expands to its text result, not the inline diff DSH draws, and a terminal expands to its text output, not the terminal card.
- A tool registered by another plugin keeps whatever row its owner draws.
- The wording and the decision table are copied from WorkBuddy's chat bundle at the time of writing. A later WorkBuddy change does not flow through.
