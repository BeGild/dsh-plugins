/**
 * ZCode's interface type scale, from DESIGN.md "UI font tokens".
 *
 * ZCode sizes every interface string off one base (`--ui-font-size`, default
 * 14px) and keeps headings inside that same ladder: h1 is base+4, h2 is
 * base+2, h3–h6 stay at base. DSH does the opposite — headings jump to
 * 21/19/18px and the chrome (sidebar, settings, tool rows) is pinned at
 * 11–13px no matter what the content-font setting says.
 *
 * DSH exposes each step as a `--dsw-font-*` shorthand plus five sub-properties
 * (`-font-size`, `-line-height`, `-font-weight`, `-font-family`, `-font-style`).
 * Components read the sub-properties, so retinting the shorthand alone changes
 * nothing. This module rewrites the sub-properties the ladder owns and leaves
 * family, style, and code faces alone.
 *
 * The content-font setting still drives the ladder: every step is
 * `calc(<base>px + var(--dsh-content-font-delta))`, and that delta is
 * `fontSize - 14`. At the default 14 the steps land on ZCode's defaults.
 */

/** ZCode line-height per step. DSH's own ladder uses +6 to +9 over the size. */
const LINE_HEIGHT = {
  xl: 26,
  lg: 24,
  base: 22,
  caption: 20,
  sm: 18,
  xs: 16,
}

/**
 * Which DSH font tokens take which ZCode step.
 *
 * `weight` is written into `-font-weight` and the shorthand. Tokens that are
 * not listed keep DSH's own size (code faces, which ZCode sizes separately).
 * @type {Record<string, { step: keyof typeof LINE_HEIGHT, weight: number }>}
 */
export const FONT_ROLES = {
  // Reading headings. ZCode keeps h3–h6 at body size and separates them by weight.
  '--dsw-font-markdown-h1': { step: 'xl', weight: 600 },
  '--dsw-font-markdown-h2': { step: 'lg', weight: 600 },
  '--dsw-font-markdown-h3': { step: 'base', weight: 600 },
  '--dsw-font-markdown-h4': { step: 'base', weight: 600 },

  // Body copy.
  '--dsw-font-markdown-base': { step: 'base', weight: 400 },
  '--dsw-font-markdown-base-strong': { step: 'base', weight: 600 },
  '--dsw-font-markdown-base-italic': { step: 'base', weight: 400 },
  '--dsw-font-markdown-base-strong-italic': { step: 'base', weight: 600 },

  // Tables sit on the caption step: one below body, still readable.
  '--dsw-font-markdown-table': { step: 'caption', weight: 400 },
  '--dsw-font-markdown-table-head': { step: 'caption', weight: 500 },

  // Chrome. These are the tokens that make DSH look smaller than ZCode.
  '--dsw-font-base-16': { step: 'lg', weight: 400 },
  '--dsw-font-base-strong-16': { step: 'lg', weight: 500 },
  '--dsw-font-s-14': { step: 'base', weight: 400 },
  '--dsw-font-s-strong-14': { step: 'base', weight: 500 },
  '--dsw-font-xs-13': { step: 'caption', weight: 400 },
  '--dsw-font-xs-strong-13': { step: 'caption', weight: 500 },
  '--dsw-font-xxs-12': { step: 'sm', weight: 400 },
  '--dsw-font-xxs-strong-12': { step: 'sm', weight: 500 },
  '--dsw-font-xxxs-11': { step: 'xs', weight: 400 },
  '--dsw-font-xxxs-strong-11': { step: 'xs', weight: 500 },

  // Display sizes used by empty states and settings titles.
  '--dsw-font-xl-24': { step: 'xl', weight: 600 },
  '--dsw-font-l-20': { step: 'lg', weight: 500 },
  '--dsw-font-m-18': { step: 'lg', weight: 500 },
}

/** Pixel size of each step at the 14px base, from DESIGN.md. */
export const STEP_PX = { xl: 18, lg: 16, base: 14, caption: 13, sm: 12, xs: 10 }

/**
 * CSS font-size for one step. The delta is 0 at the default content size, so
 * the computed value equals {@link STEP_PX}.
 * @param {keyof typeof STEP_PX} step
 */
export function fontSizeOf(step) {
  const px = STEP_PX[step]
  if (px === undefined) throw new Error(`dsh-zcode-theme: unknown type step "${step}"`)
  return `calc(${px}px + var(--dsh-content-font-delta, 0px))`
}

/**
 * @param {keyof typeof STEP_PX} step
 */
export function lineHeightOf(step) {
  const px = LINE_HEIGHT[step]
  if (px === undefined) throw new Error(`dsh-zcode-theme: unknown type step "${step}"`)
  return `calc(${px}px + var(--dsh-content-font-delta, 0px))`
}

/**
 * Token overrides that retune the type ladder.
 *
 * The shorthand is included because a few call sites read it whole; the
 * sub-properties are what the compiled styles actually use. Family and style
 * are not touched, so CJK fallbacks and italics survive.
 * @returns {Record<string, string>}
 */
export function fontTokenValues() {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, role] of Object.entries(FONT_ROLES)) {
    const size = fontSizeOf(role.step)
    const line = lineHeightOf(role.step)
    out[name] = `${role.weight} ${size} / ${line} var(--dsw-font-family)`
    out[`${name}-font-size`] = size
    out[`${name}-line-height`] = line
    out[`${name}-font-weight`] = String(role.weight)
  }
  return out
}
