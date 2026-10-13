# dsh-skill-menu

Replaces the stock `/` skill menu with a richer one: candidates are grouped under their **package section**, so a multi-skill package like `watch-positions` shows up as its own group instead of six loose names, and the `[package]` prefix is stripped from the description line once the header carries it. Everything else keeps the stock behavior — same trigger name, same pick semantics, same conversation row for the `skill` tool.

## How it replaces the stock menu

The stock menu is the browser half of `@deepseek-ai/dsh-client-ui-skill`, whose row id in the composed profile is `ui-skill`. The input-trigger registry refuses two sources with the same trigger + name (`slash source "/skill" is already registered`), so a replacement cannot coexist with it. This bundle's patch layer therefore **disables the stock row** and inserts its own — the same pattern `dsh-win32` uses for stock rows it takes over. No file inside any official package is touched; removing this bundle (or disabling its row) restores the stock menu untouched.

## What the menu shows

| Field | Behavior |
|---|---|
| `section` | Skills whose description starts with a `[package]` attribution — the prefix `dsh-skill-market` writes when a multi-skill package installs — group under their package; everything else falls into one local section. The host menu renderer draws the section headers. |
| `description` | The attribution prefix is stripped in the menu (the section header carries it); non-model-invocable skills keep the `仅用户 ·` marker. |

Per-candidate icons are **not** possible in this menu: the host renderer draws only `session` / `file` / `folder` reference glyphs, none of which reads as a skill, so the plugin passes no `icon` rather than a misleading one.

Picking a candidate inserts `/name ` exactly as before, and the `agent-preset/selected` / `connection/reset` invalidation, subagent suppression, and lexicon subscription protocols mirror the stock source.

## The conversation row

Disabling the stock row also removes its `skill` tool row, so this plugin re-owns it: a compact disclosure with the state icon (running / failed / stopped), the fixed "Skill" title, the invoked skill name, and the loaded instructions behind a click. Faithful reimplementation, not a copy of the official bundle.

A conversation-repaint plugin that draws its own tool rows (e.g. `dsh-ekko-ui`) shadows this row exactly as it shadowed the stock one — same seat, same key, same layering, no regression either way.

## Config

None. The bundle is a straight replacement; everything it does is on by default.

## Development

```sh
node test/menu.test.mjs
```

The suite stands in for the browser module loader (fake `window.__ModuleLoader__`, stub modules, stub context) and checks the bundle contract, locale parity, slot and source registration, sectioning, and candidate shaping.
