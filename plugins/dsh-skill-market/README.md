# dsh-skill-market

Install a ZCode plugin or a WorkBuddy skill into the DeepSeek Harness profile you are running.

Two faces over one implementation:

- **A web panel** (web profiles). A sidebar row opens a marketplace page: two catalog tabs, live search, and a compact card grid. Every card carries the package icon — ZCode icons come from the marketplace manifest, WorkBuddy icons from the catalog zip, both proxied same-origin so nothing loads from a third party — and clicking a card opens a detail sheet with the full description, kind, source, version, category, author, keywords, and (for WorkBuddy skills) usage examples. Install and remove are one click. The panel talks to same-origin JSON routes (`/skill-market/api/*`) the host half registers on the profile's web server.
- **A model tool**, `skill_market`, with the same operations for conversational use.

A ZCode plugin is installed whole, not just its skills:

- Skills are copied into the scanned skill directory.
- Each `commands/*.md` file registers a slash command on `ctx.commands`. Running it submits the command's body, followed by the text you typed after the name, to the receiving agent with `followup`, so it enters that agent's loop as the next prompt.
- `hooks/hooks.json` is rewritten so `${CLAUDE_PLUGIN_ROOT}` points at the installed directory, then started through `@deepseek-ai/dsh-hooks-claude-code`. Those are Claude Code command hooks, and that bridge runs them at the session, prompt, tool, and stop points of the agent loop. A plugin with an empty hooks file installs nothing.
- Each `mcpServers` entry is started through `@deepseek-ai/dsh-mcp-client`. A stdio server keeps its command, arguments, and environment. An HTTP server uses Streamable HTTP. Tools appear as `mcp__<plugin>-<server>__<tool>`.

A server that authenticates with a ZCode account, or whose command is `ZCode.exe` hosting a plugin inside the ZCode process, is skipped and named in the install result. Both have no standalone entry DSH can run. Hooks and MCP servers of installed plugins start again when the harness boots. Set `autoConnect: false` to leave them stopped.

## Sources

| Source | Where it comes from | What install does |
|---|---|---|
| `zcode` | `https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json` | Downloads the plugin zip and activates skills, commands, hooks, and MCP servers. A plugin built into the ZCode client has no zip and is listed as not installable. |
| `workbuddy-skill` | the public WorkBuddy skill-marketplace zip | Installs `skills/<id>/` verbatim when its frontmatter is a legal DSH skill. |

WorkBuddy connectors and experts are not offered. A connector authenticates through a WorkBuddy account, and a curated expert ships no package.

## Using it

`sources` explains the two catalogs. `search` takes `source` and an optional `query`. `install` takes `source` and `id`. `installed` lists what this plugin installed, and `remove` deletes the bundles, unregisters the commands, and stops the hooks and MCP servers.

Records and unpacked plugins live in the state directory, which defaults to `$DSH_HOME/skill-market`.

## Config

Every value that two deployments might want to differ on is a config field. A patch row replaces `config` wholesale, so restate every key you set.

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `$DSH_HOME/skill-market` | Install records and unpacked plugin trees. |
| `skillsDir` | `$DSH_HOME/skills` | Where skill bundles are written. |
| `zcodeMarketplaceUrl` | the ZCode CDN marketplace | Marketplace document. |
| `workbuddySkillZipUrl` | the WorkBuddy skill zip | Skill catalog archive. |
| `requestTimeoutMs` | `60000` | One catalog download. |
| `maxResults` | `30` | One search page. |
| `autoConnect` | `true` | Restart installed hooks and MCP servers at boot. |

## What this plugin does not do

It does not sign in to ZCode, so a server whose `auth` is `zcode_official` stays disconnected. It does not run prompt, agent, HTTP, or MCP-tool hook handlers; the hook bridge runs command hooks only and skips the rest with a warning. It does not install WorkBuddy connectors or experts.

Installing a plugin adds its skill descriptions and its MCP tool schemas to the prompt prefix, which invalidates the prompt cache from that point. The downloaded package runs with the privileges of the DSH process. Read a package before installing it if you do not trust its publisher.

## Development

```sh
node test/market.test.mjs
```

`test/live.mjs` installs one real skill and one real plugin into a temporary directory and deletes them. It needs the network and is not part of the test script.

`test/e2e.mjs` drives a **live profile server** through the panel's own routes, every source and component type, asserting the real effects:

```sh
node test/e2e.mjs http://127.0.0.1:PORT TOKEN
```

| Case | Package | What it proves |
|---|---|---|
| zcode skills-only | `github` | 10 skill bundles land in the scanned root; record, tree, and cleanup |
| zcode full | `mimosa` | skill + 3 slash commands + hooks.json folded to `type:"command"` and rooted at the install |
| zcode MCP | `disk-cleaner` | a stdio MCP server is spawned as a real child process and dies on removal (no EBUSY) |
| workbuddy-skill | `airbnb` | verbatim skill with legal frontmatter; icon and examples in the API |

Hook execution inside a real turn was verified by hand: with mimosa installed, a model turn that writes a file produces `hook/invoked`/`hook/result` pairs (`decision: "pass"`) in the session log at the UserPromptSubmit and Stop points.
