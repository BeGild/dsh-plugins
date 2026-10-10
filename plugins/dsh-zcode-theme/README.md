# dsh-zcode-theme

Repaints the DSH Web UI with the palette and type scale shipped by ZCode. It changes no behaviour: no tools, no settings rows, no network, no files. Removing the plugin restores the stock look.

ZCode's default theme is `zai-dark` (`packages/ui/src/styles.css`, class `.theme-zai-dark`; `useTheme.ts` folds the plain `dark` preference into it). This plugin copies those surface colours onto the `--dsw-*` tokens DSH paints with, and retunes DSH's font tokens to ZCode's `text-ui-*` ladder (`DESIGN.md`).

## What changes

**Palette.** DSH's dark surfaces are blue-grey (`#151517` page, `#232324` raised). ZCode's are neutral: `#161616` page and sidebar, `#202020` header and panel, `#2b2b2b` cards, popovers and inputs, `#363636` menus. Text is `#d4d4d4` with the same two fade steps ZCode uses (60% secondary, 30% tertiary). Borders are a white hairline at 10%, strengthening to 15%. The primary button and brand mark are white on dark and black on light, matching `--color-brand`. The light palette mirrors `.theme-zai-light` (`#f8f8f8` page, `#f0f0f0` sidebar, white cards).

DSH's own red, green and amber state colours are left alone. Its business blue is also left alone unless `accent` is turned on, in which case links and info buttons take ZCode's `#4099ff` / `#0b7fff`.

**Type scale.** ZCode sizes the whole interface off one base, default 14px:

| ZCode token | At 14px | What it maps in DSH |
| --- | --- | --- |
| `text-ui-xl` | 18px | markdown h1 (was 21px) and the 24px display face |
| `text-ui-lg` | 16px | markdown h2 (was 19px) and the 16px chrome face |
| `text-ui-base` | 14px | body, h3–h4 (were 18px / 14px), and the 14px chrome face |
| `text-ui-caption` | 13px | tables, and the 13px chrome face used by sidebar rows |
| `text-ui-sm` | 12px | the 12px chrome face |
| `text-ui-xs` | 10px | the 11px chrome face |

Headings move down, so a markdown `h1` no longer dwarfs the interface around it. Most chrome sizes already sit on a ZCode step of the same pixel size — DSH's 12px, 13px, 14px and 16px faces are ZCode's `sm`, `caption`, `base` and `lg` — so they keep their size. Only the 11px face has no ZCode counterpart and lands on `xs` at 10px. Sidebar and tool rows read `--dsh-content-font-size-secondary` (13px at the default), which is already the caption step, so they are left alone.

A lot of the chrome does not read a font token at all: the client packages inject stylesheets that write `font-size: 14px`, `12px` and `11px` directly, and DSH's own font-size row says it only affects conversation content. The plugin rewrites those literals in place, keeping each size on the ZCode step it already matched and preserving the gap its line-height had over that size. The sizes therefore stay where they are — what changes is that they now carry `--dsh-content-font-delta` and follow the stepper (see below). Rules that opt into the monospace stack are skipped, so code, code blocks and the terminal stay at DSH's own sizes — ZCode sizes those independently of the interface ladder. The rewrite is undone when the plugin unloads.

The Settings font-size stepper still works, and now moves the chrome that reads a literal size too. Every step is offset by `--dsh-content-font-delta`, which is the stepper's value minus 14, so choosing 16px grows every step by 2px exactly as ZCode's `--ui-font-size` does. Icons, padding and radii do not scale.

## Install

```sh
dsh plugin --profile web add ./plugins/dsh-zcode-theme
```

Then restart that profile. A running profile keeps the bundle set it booted with, so the theme does not appear until the next start.

Confirm the layer is present without booting:

```sh
dsh --profile web --dump-config
```

The output should contain a `# == dsh-zcode-theme` layer.

## Config

All three are optional. Defaults are shown.

```yaml
- id: zcode-theme
  config:
    fonts: true      # retune the type ladder
    palette: true    # repaint surfaces
    accent: false    # also recolour the business blue
```

Set `fonts: false` or `palette: false` to keep one half of the stock look. `accent` is off because DSH's blue is an accent colour rather than part of the surface palette, and replacing it changes every info affordance.

Overrides are per colour scheme, so switching Appearance between light, dark and system keeps both palettes legible. `system` follows `prefers-color-scheme` as before.

## Conflicts

Any other plugin that calls `ctx.theme.overrideTokens` on the same token names stacks with this one; the later layer wins per token. This plugin does not register a theme id, so it does not occupy the Appearance selector.

## Security

The plugin registers no host service, opens no socket, and reads no file. It writes CSS custom properties onto `document.body` through the theme presenter, and it rewrites the text of `style` elements already in the page so literal chrome sizes follow the same ladder. Both are reverted on unload. Like every DSH plugin it runs with the host user's privileges rather than inside the tool sandbox; there is nothing here that uses that.

## Limitations

- Only the Web UI. The terminal and CLI chrome are untouched.
- The chrome rewrite reaches only the stylesheets client packages inject as `style` elements. The Web shell's own stylesheets arrive as `link rel="stylesheet"`, which the rewrite does not touch, so the shell's own literal chrome sizes keep their built-in values. The token half does reach them.
- `--dsw-font-base-16`, `--dsw-font-xl-24` and `--dsw-font-m-18` are declared by DSH but read by no shipped component, so retuning them has no visible effect today.
- Tokens DSH introduces after this was written keep their built-in colours until they are mapped. The mapped set covers the alias and specific tokens the current stylesheet assigns on `body` and `body[data-ds-dark-theme]`.
- ZCode's syntax-highlighting colours inside code blocks are not reproduced. Block backgrounds change; the token colours stay on DSH's shiki theme.
- The values are copied from ZCode's stylesheet at the time of writing. They are not computed from a ZCode install, so a later ZCode palette change does not flow through.
