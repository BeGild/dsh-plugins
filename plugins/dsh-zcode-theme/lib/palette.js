/**
 * ZCode surface colours, sampled from packages/ui/src/styles.css.
 *
 * `.theme-zai-dark` and `.theme-zai-light` are the palettes ZCode actually
 * ships (useTheme.ts folds the plain dark/light preferences into them). Values
 * are copied as literals rather than re-expressed through DSH's bluish static
 * ramp, which is a different grey.
 *
 * Only the alias and specific tokens the DSH Web UI reads are mapped. State
 * colours (error / success / warn) stay on DSH's own ramp.
 */

/** @typedef {{ light: string, dark: string }} ModePair */

/** One override entry: the same literal in both palettes. */
function both(value) {
  return { light: value, dark: value }
}

/**
 * ZCode zai surfaces, keyed by the `--dsw-*` variable DSH paints with.
 * @type {Record<string, ModePair>}
 */
export const SURFACE_TOKENS = {
  // --- page, raised surfaces, overlays ---
  '--dsw-alias-bg-base': { light: '#f8f8f8', dark: '#161616' },
  '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#202020' },
  '--dsw-alias-bg-layer-2': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-alias-bg-layer-3': { light: '#f0f0f0', dark: '#363636' },
  '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-alias-bg-module-platform': { light: '#f0f0f0', dark: '#202020' },
  '--dsw-alias-bg-multi-select': { light: '#e6e6e6', dark: '#363636' },
  '--dsw-alias-bg-skeleton': { light: 'rgba(13, 13, 13, 0.05)', dark: 'rgba(255, 255, 255, 0.05)' },

  // --- borders: ZCode uses one 10% hairline, strengthened to 15% on hover ---
  '--dsw-alias-border-l1': { light: 'rgba(13, 13, 13, 0.06)', dark: 'rgba(255, 255, 255, 0.06)' },
  '--dsw-alias-border-l2': { light: 'rgba(13, 13, 13, 0.1)', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-alias-border-l2-darkmode-thin': { light: 'rgba(13, 13, 13, 0.1)', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-alias-border-l3': { light: 'rgba(13, 13, 13, 0.15)', dark: 'rgba(255, 255, 255, 0.15)' },
  '--dsw-alias-border-l4': { light: 'rgba(13, 13, 13, 0.2)', dark: 'rgba(255, 255, 255, 0.2)' },
  '--dsw-alias-border-inverted': { light: 'rgba(13, 13, 13, 0.1)', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-alias-border-inverted2': { light: 'rgba(13, 13, 13, 0.15)', dark: 'rgba(255, 255, 255, 0.15)' },

  // --- text: neutral-800 / neutral-300, not DSH's blue-grey ---
  '--dsw-alias-label-primary': { light: '#262626', dark: '#d4d4d4' },
  '--dsw-alias-label-primary-dimmed': { light: '#404040', dark: '#e5e5e5' },
  '--dsw-alias-label-primary-bluish': { light: '#262626', dark: '#d4d4d4' },
  '--dsw-alias-label-secondary': { light: 'rgba(38, 38, 38, 0.6)', dark: 'rgba(212, 212, 212, 0.6)' },
  '--dsw-alias-label-tertiary': { light: 'rgba(38, 38, 38, 0.4)', dark: 'rgba(212, 212, 212, 0.3)' },
  '--dsw-alias-label-caption': { light: 'rgba(38, 38, 38, 0.4)', dark: 'rgba(212, 212, 212, 0.3)' },
  '--dsw-alias-label-dimmed': { light: 'rgba(38, 38, 38, 0.4)', dark: 'rgba(212, 212, 212, 0.45)' },
  '--dsw-alias-label-primary-foreground': { light: '#ffffff', dark: '#000000' },
  '--dsw-alias-label-primary-inverted': { light: '#ffffff', dark: '#262626' },

  // --- brand is black on light and white on dark (ZCode --color-brand) ---
  '--dsw-alias-brand-primary': { light: '#000000', dark: '#ffffff' },
  '--dsw-alias-brand-primary-invert': { light: '#ffffff', dark: '#000000' },
  '--dsw-alias-brand-text': { light: '#000000', dark: '#ffffff' },

  // --- buttons follow the brand, not DSH's blue ---
  '--dsw-alias-button-primary-fill': { light: '#000000', dark: '#ffffff' },
  '--dsw-alias-button-primary-hover': { light: '#262626', dark: '#e5e5e5' },
  '--dsw-alias-button-primary-dimmed': { light: '#e6e6e6', dark: '#363636' },
  '--dsw-alias-button-contrast-fill': { light: '#262626', dark: '#f5f5f5' },
  '--dsw-alias-button-elevated-fill': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-alias-button-floating-fill': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-alias-button-floating-hover': { light: '#f0f0f0', dark: '#363636' },
  '--dsw-alias-button-ghost-active-border': { light: 'rgba(13, 13, 13, 0.15)', dark: 'rgba(255, 255, 255, 0.15)' },
  '--dsw-alias-button-ghost-active-fill': { light: 'rgba(13, 13, 13, 0.05)', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-alias-button-ghost-active-hover': { light: 'rgba(13, 13, 13, 0.08)', dark: 'rgba(255, 255, 255, 0.14)' },

  // --- hover / active: ZCode's 5% and 10% white (or black) washes ---
  '--dsw-alias-interactive-bg-hover': { light: 'rgba(13, 13, 13, 0.05)', dark: 'rgba(255, 255, 255, 0.05)' },
  '--dsw-alias-interactive-bg-hover-accent': { light: 'rgba(13, 13, 13, 0.08)', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-alias-interactive-bg-hover-solid': { light: '#f0f0f0', dark: '#363636' },
  '--dsw-alias-interactive-bg-active': { light: 'rgba(13, 13, 13, 0.05)', dark: 'rgba(255, 255, 255, 0.1)' },

  // --- markdown surfaces: card / tag / code block ---
  '--dsw-alias-markdown-code-block': { light: '#f8f8f8', dark: '#161616' },
  '--dsw-alias-markdown-code-block-banner': { light: '#f0f0f0', dark: '#202020' },
  '--dsw-alias-markdown-inline-code': { light: '#e6e6e6', dark: '#363636' },
  '--dsw-alias-markdown-code-segment-selected': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-alias-markdown-code-segment-unselected': { light: '#f0f0f0', dark: '#202020' },
  '--dsw-alias-markdown-citation': { light: '#f0f0f0', dark: '#2b2b2b' },
  '--dsw-alias-markdown-placeholder': { light: '#f0f0f0', dark: '#2b2b2b' },
  '--dsw-alias-markdown-tag': { light: '#e6e6e6', dark: '#363636' },

  // --- scrollbars track the border hairline ---
  '--dsw-alias-scrollbar-bg-l1': { light: 'rgba(13, 13, 13, 0.1)', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-alias-scrollbar-bg-l2': { light: 'rgba(13, 13, 13, 0.16)', dark: 'rgba(255, 255, 255, 0.16)' },
  '--dsw-alias-scrollbar-hover-l1': { light: 'rgba(13, 13, 13, 0.2)', dark: 'rgba(255, 255, 255, 0.2)' },
  '--dsw-alias-scrollbar-hover-l2': { light: 'rgba(13, 13, 13, 0.28)', dark: 'rgba(255, 255, 255, 0.28)' },

  // --- chrome pieces that would otherwise keep the bluish ramp ---
  '--dsw-alias-toast-bg': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-alias-tooltip-bg': { light: '#f0f0f0', dark: '#2b2b2b' },
  '--dsw-specific-bubble': { light: '#f0f0f0', dark: '#2b2b2b' },
  '--dsw-specific-bubble-highlight': { light: '#e6e6e6', dark: '#363636' },
  '--dsw-specific-input-major': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-specific-login-input': { light: '#ffffff', dark: '#202020' },
  '--dsw-specific-menu': { light: '#ffffff', dark: '#2b2b2b' },
  '--dsw-specific-selector': { light: '#f0f0f0', dark: '#363636' },
  '--dsw-specific-sidebar-fill': { light: '#f0f0f0', dark: '#161616' },
  '--dsw-specific-sidebar-nav-item-active': { light: 'rgba(13, 13, 13, 0.05)', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: '#ebf4ff', dark: '#001d3d' },
  '--dsw-specific-sidebar-nav-item-hover': { light: 'rgba(13, 13, 13, 0.05)', dark: 'rgba(255, 255, 255, 0.05)' },
  '--dsw-specific-tip': { light: '#f0f0f0', dark: '#202020' },
}

/**
 * Accent ZCode uses for links, the user trajectory, and the ask surface.
 * Opt-in: DSH's business blue is close already, and replacing it changes
 * every "info" affordance, not just the palette.
 * @type {Record<string, ModePair>}
 */
export const ACCENT_TOKENS = {
  '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#0b7fff', dark: '#4099ff' },
  '--dsw-alias-state-business-primary': { light: '#0b7fff', dark: '#4099ff' },
  '--dsw-alias-state-business-tertiary': { light: '#ebf4ff', dark: '#001d3d' },
  '--dsw-alias-button-info-fill': { light: '#0b7fff', dark: '#4099ff' },
  '--dsw-alias-button-info-hover': { light: '#0066dd', dark: '#80beff' },
}

/**
 * Build the token map `ctx.theme.overrideTokens` accepts.
 * @param {{ accent?: boolean }} [options]
 * @returns {Record<string, ModePair>}
 */
export function buildTokens(options = {}) {
  return options.accent === true ? { ...SURFACE_TOKENS, ...ACCENT_TOKENS } : { ...SURFACE_TOKENS }
}

export { both }
