# dsh-skill-menu

Owns the `/` candidate menu **view**: skill candidates group under their package section with the package's marketplace icon, the `[package]` attribution is stripped from the description line, and everything else about the menu — the trigger framework, the stock `/skill` source, keyboard navigation semantics, breadcrumbs, drill-down, the skill conversation row — keeps running untouched from the official packages.

## How it wins the menu cell

The stock menu is the `conversation.input.overlay` entry (cell id `slash-menu`) registered by `@deepseek-ai/dsh-client-ui-input-trigger`. The slots registry resolves a cell by **first live registration wins**, and app bundles always register before profile plugins — so a same-id entry from a later-loading plugin never shadows it.

This plugin turns that ordering around where it can be turned around: its registration depends only on the early `slots` service (the stock one also waits for `inputTriggers`, which mounts later), and the bundle is ordered **ahead of `@deepseek-ai/dsh-web-app`** in `dsh.profile.bundles`:

```jsonc
"bundles": ["@deepseek-ai/dsh-base", "dsh-skill-menu", "@deepseek-ai/dsh-web-app", /* … */]
```

With that order its overlay entry lands first and owns the cell; the stock `MenuView` registration is silently skipped, and removing this bundle (or loading it late) restores the stock menu as-is. **No official row is disabled and no official file is modified.** The controller faces (menu store, pick, hover, crumbs) resolve lazily at render time from the stock trigger service, which by then is always up.

## What the view renders

- **Sections** — skills whose description starts with a `[package]` attribution (the prefix `dsh-skill-market` writes when a multi-skill package installs) group under their package, in first-seen order; everything else falls into one local section. Pick, hover, and highlight keep speaking the service's original item indices, so re-ordering is display-only.
- **Icons** — each sectioned candidate renders its package's marketplace icon (`/skill-market/api/icon`, trying the ZCode manifest proxy then the WorkBuddy zip proxy; both served by dsh-skill-market's host half). Without that plugin installed every attempt 404s and rows render without art.
- **Parity** — combobox pattern (focus stays in the textarea, rows are mousedown-picked, highlight exposed via `aria-activedescendant`), breadcrumb header above the scrolling list, skeleton rows on first load, and the drill affordance for sources that refine.

## The ordering dependency

If this bundle loads after `dsh-web-app`, the stock `MenuView` wins the cell and this plugin's view silently never renders. Keep the bundle early; `cordis.patch.yml` documents the same note.

## Development

```sh
node test/menu.test.mjs
```

The suite stands in for the browser module loader (fake `window.__ModuleLoader__`, stub modules, stub context) and checks the bundle contract, locale parity, the overlay registration (cell id, lazy faces), the controller verb wiring, and the section re-ordering with original-index preservation.
