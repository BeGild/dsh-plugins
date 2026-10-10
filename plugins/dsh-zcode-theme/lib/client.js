/**
 * dsh-zcode-theme — browser half.
 *
 * Paints the DSH Web UI with ZCode's zai palette and type scale. The host half
 * does nothing; every effect here is a `ctx.theme.overrideTokens` layer, which
 * the layout presenter writes onto `body` as inline custom properties. Inline
 * wins over the built-in token sheet, and unloading the plugin drops the layer.
 *
 * Hand-written in the client module format (no bundler, same as
 * dsh-agentos-remote): this file is the artifact `dsh.client` loads.
 *
 * No locale namespace and no settings row. The plugin has nothing to say in the
 * UI — the Appearance rows already switch light/dark and the content size, and
 * both keep working because every size here is offset by
 * `--dsh-content-font-delta`.
 */
window.__ModuleLoader__.load({
  id: "dsh-zcode-theme",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // Same numbers as lib/scale.js STEP_PX / LINE_HEIGHT / FONT_ROLES. Duplicated
    // because the browser module graph cannot import the host file, and a shared
    // module would need its own client registration. test/scale.test.mjs asserts
    // the two copies stay in lockstep.
    var STEP_PX = { xl: 18, lg: 16, base: 14, caption: 13, sm: 12, xs: 10 };
    var LINE_HEIGHT = { xl: 26, lg: 24, base: 22, caption: 20, sm: 18, xs: 16 };
    var FONT_ROLES = {
      "--dsw-font-markdown-h1": ["xl", 600],
      "--dsw-font-markdown-h2": ["lg", 600],
      "--dsw-font-markdown-h3": ["base", 600],
      "--dsw-font-markdown-h4": ["base", 600],
      "--dsw-font-markdown-base": ["base", 400],
      "--dsw-font-markdown-base-strong": ["base", 600],
      "--dsw-font-markdown-base-italic": ["base", 400],
      "--dsw-font-markdown-base-strong-italic": ["base", 600],
      "--dsw-font-markdown-table": ["caption", 400],
      "--dsw-font-markdown-table-head": ["caption", 500],
      "--dsw-font-base-16": ["lg", 400],
      "--dsw-font-base-strong-16": ["lg", 500],
      "--dsw-font-s-14": ["base", 400],
      "--dsw-font-s-strong-14": ["base", 500],
      "--dsw-font-xs-13": ["caption", 400],
      "--dsw-font-xs-strong-13": ["caption", 500],
      "--dsw-font-xxs-12": ["sm", 400],
      "--dsw-font-xxs-strong-12": ["sm", 500],
      "--dsw-font-xxxs-11": ["xs", 400],
      "--dsw-font-xxxs-strong-11": ["xs", 500],
      "--dsw-font-xl-24": ["xl", 600],
      "--dsw-font-l-20": ["lg", 500],
      "--dsw-font-m-18": ["lg", 500],
    };

    function sizeOf(step) {
      return "calc(" + STEP_PX[step] + "px + var(--dsh-content-font-delta, 0px))";
    }

    function lineOf(step) {
      return "calc(" + LINE_HEIGHT[step] + "px + var(--dsh-content-font-delta, 0px))";
    }

    /** Font overrides. Scheme-invariant, so light and dark carry the same value. */
    function fontTokens() {
      var out = {};
      for (var name in FONT_ROLES) {
        var step = FONT_ROLES[name][0];
        var weight = FONT_ROLES[name][1];
        var size = sizeOf(step);
        var line = lineOf(step);
        var shorthand = weight + " " + size + " / " + line + " var(--dsw-font-family)";
        out[name] = pair(shorthand);
        out[name + "-font-size"] = pair(size);
        out[name + "-line-height"] = pair(line);
        out[name + "-font-weight"] = pair(String(weight));
      }
      return out;
    }

    function pair(value) {
      return { light: value, dark: value };
    }

    /**
     * ZCode zai surfaces. Kept inline (not imported) for the same reason as the
     * scale: the client artifact has no module graph of its own. test/palette.test.mjs
     * checks these values against lib/palette.js.
     */
    var SURFACES = {
      "--dsw-alias-bg-base": ["#f8f8f8", "#161616"],
      "--dsw-alias-bg-layer-1": ["#ffffff", "#202020"],
      "--dsw-alias-bg-layer-2": ["#ffffff", "#2b2b2b"],
      "--dsw-alias-bg-layer-3": ["#f0f0f0", "#363636"],
      "--dsw-alias-bg-overlay": ["#ffffff", "#2b2b2b"],
      "--dsw-alias-bg-module-platform": ["#f0f0f0", "#202020"],
      "--dsw-alias-bg-multi-select": ["#e6e6e6", "#363636"],
      "--dsw-alias-bg-skeleton": ["rgba(13, 13, 13, 0.05)", "rgba(255, 255, 255, 0.05)"],
      "--dsw-alias-border-l1": ["rgba(13, 13, 13, 0.06)", "rgba(255, 255, 255, 0.06)"],
      "--dsw-alias-border-l2": ["rgba(13, 13, 13, 0.1)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-alias-border-l2-darkmode-thin": ["rgba(13, 13, 13, 0.1)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-alias-border-l3": ["rgba(13, 13, 13, 0.15)", "rgba(255, 255, 255, 0.15)"],
      "--dsw-alias-border-l4": ["rgba(13, 13, 13, 0.2)", "rgba(255, 255, 255, 0.2)"],
      "--dsw-alias-border-inverted": ["rgba(13, 13, 13, 0.1)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-alias-border-inverted2": ["rgba(13, 13, 13, 0.15)", "rgba(255, 255, 255, 0.15)"],
      "--dsw-alias-label-primary": ["#262626", "#d4d4d4"],
      "--dsw-alias-label-primary-dimmed": ["#404040", "#e5e5e5"],
      "--dsw-alias-label-primary-bluish": ["#262626", "#d4d4d4"],
      "--dsw-alias-label-secondary": ["rgba(38, 38, 38, 0.6)", "rgba(212, 212, 212, 0.6)"],
      "--dsw-alias-label-tertiary": ["rgba(38, 38, 38, 0.4)", "rgba(212, 212, 212, 0.3)"],
      "--dsw-alias-label-caption": ["rgba(38, 38, 38, 0.4)", "rgba(212, 212, 212, 0.3)"],
      "--dsw-alias-label-dimmed": ["rgba(38, 38, 38, 0.4)", "rgba(212, 212, 212, 0.45)"],
      "--dsw-alias-label-primary-foreground": ["#ffffff", "#000000"],
      "--dsw-alias-label-primary-inverted": ["#ffffff", "#262626"],
      "--dsw-alias-brand-primary": ["#000000", "#ffffff"],
      "--dsw-alias-brand-primary-invert": ["#ffffff", "#000000"],
      "--dsw-alias-brand-text": ["#000000", "#ffffff"],
      "--dsw-alias-button-primary-fill": ["#000000", "#ffffff"],
      "--dsw-alias-button-primary-hover": ["#262626", "#e5e5e5"],
      "--dsw-alias-button-primary-dimmed": ["#e6e6e6", "#363636"],
      "--dsw-alias-button-contrast-fill": ["#262626", "#f5f5f5"],
      "--dsw-alias-button-elevated-fill": ["#ffffff", "#2b2b2b"],
      "--dsw-alias-button-floating-fill": ["#ffffff", "#2b2b2b"],
      "--dsw-alias-button-floating-hover": ["#f0f0f0", "#363636"],
      "--dsw-alias-button-ghost-active-border": ["rgba(13, 13, 13, 0.15)", "rgba(255, 255, 255, 0.15)"],
      "--dsw-alias-button-ghost-active-fill": ["rgba(13, 13, 13, 0.05)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-alias-button-ghost-active-hover": ["rgba(13, 13, 13, 0.08)", "rgba(255, 255, 255, 0.14)"],
      "--dsw-alias-interactive-bg-hover": ["rgba(13, 13, 13, 0.05)", "rgba(255, 255, 255, 0.05)"],
      "--dsw-alias-interactive-bg-hover-accent": ["rgba(13, 13, 13, 0.08)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-alias-interactive-bg-hover-solid": ["#f0f0f0", "#363636"],
      "--dsw-alias-interactive-bg-active": ["rgba(13, 13, 13, 0.05)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-alias-markdown-code-block": ["#f8f8f8", "#161616"],
      "--dsw-alias-markdown-code-block-banner": ["#f0f0f0", "#202020"],
      "--dsw-alias-markdown-inline-code": ["#e6e6e6", "#363636"],
      "--dsw-alias-markdown-code-segment-selected": ["#ffffff", "#2b2b2b"],
      "--dsw-alias-markdown-code-segment-unselected": ["#f0f0f0", "#202020"],
      "--dsw-alias-markdown-citation": ["#f0f0f0", "#2b2b2b"],
      "--dsw-alias-markdown-placeholder": ["#f0f0f0", "#2b2b2b"],
      "--dsw-alias-markdown-tag": ["#e6e6e6", "#363636"],
      "--dsw-alias-scrollbar-bg-l1": ["rgba(13, 13, 13, 0.1)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-alias-scrollbar-bg-l2": ["rgba(13, 13, 13, 0.16)", "rgba(255, 255, 255, 0.16)"],
      "--dsw-alias-scrollbar-hover-l1": ["rgba(13, 13, 13, 0.2)", "rgba(255, 255, 255, 0.2)"],
      "--dsw-alias-scrollbar-hover-l2": ["rgba(13, 13, 13, 0.28)", "rgba(255, 255, 255, 0.28)"],
      "--dsw-alias-toast-bg": ["#ffffff", "#2b2b2b"],
      "--dsw-alias-tooltip-bg": ["#f0f0f0", "#2b2b2b"],
      "--dsw-specific-bubble": ["#f0f0f0", "#2b2b2b"],
      "--dsw-specific-bubble-highlight": ["#e6e6e6", "#363636"],
      "--dsw-specific-input-major": ["#ffffff", "#2b2b2b"],
      "--dsw-specific-login-input": ["#ffffff", "#202020"],
      "--dsw-specific-menu": ["#ffffff", "#2b2b2b"],
      "--dsw-specific-selector": ["#f0f0f0", "#363636"],
      "--dsw-specific-sidebar-fill": ["#f0f0f0", "#161616"],
      "--dsw-specific-sidebar-nav-item-active": ["rgba(13, 13, 13, 0.05)", "rgba(255, 255, 255, 0.1)"],
      "--dsw-specific-sidebar-nav-item-active-accent": ["#ebf4ff", "#001d3d"],
      "--dsw-specific-sidebar-nav-item-hover": ["rgba(13, 13, 13, 0.05)", "rgba(255, 255, 255, 0.05)"],
      "--dsw-specific-tip": ["#f0f0f0", "#202020"],
    };

    var ACCENTS = {
      "--dsw-alias-brand-primary-new-colorprimary-new-color": ["#0b7fff", "#4099ff"],
      "--dsw-alias-state-business-primary": ["#0b7fff", "#4099ff"],
      "--dsw-alias-state-business-tertiary": ["#ebf4ff", "#001d3d"],
      "--dsw-alias-button-info-fill": ["#0b7fff", "#4099ff"],
      "--dsw-alias-button-info-hover": ["#0066dd", "#80beff"],
    };

    function surfaceTokens(accent) {
      var out = {};
      var source = accent ? Object.assign({}, SURFACES, ACCENTS) : SURFACES;
      for (var name in source) out[name] = { light: source[name][0], dark: source[name][1] };
      return out;
    }

    function assign(target, source) {
      for (var key in source) target[key] = source[key];
      return target;
    }

    /**
     * Literal chrome sizes the bundled stylesheet writes instead of reading a
     * font token. The settings stepper's own description says it only affects
     * conversation content, so the token layer cannot reach these.
     *
     * Source px → ZCode step. Anything not listed (code faces included) is left
     * exactly as DSH shipped it.
     */
    var CHROME_LADDER = { 16: "lg", 14: "base", 13: "caption", 12: "sm", 11: "xs" };

    /**
     * A rule counts as a code face when it opts into the monospace stack. Those
     * keep their own size, matching ZCode, where code is independent of the
     * interface ladder.
     */
    function isCodeFace(body) {
      return body.indexOf("--ds-font-family-code") !== -1 || body.indexOf("monospace") !== -1;
    }

    /**
     * Rewrite literal `font-size` (and its paired `line-height`) inside one
     * stylesheet's rule bodies. Selectors are preserved verbatim, which is what
     * keeps this working across DSH builds: the class hashes change, the
     * declarations do not. A rule that sets no mapped size comes back unchanged.
     * @param {string} css
     * @returns {string}
     */
    function retuneChromeCss(css) {
      return css.replace(/([^{}]+)\{([^{}]*)\}/g, function (rule, selector, body) {
        if (isCodeFace(body)) return rule;
        var changed = false;
        var next = body.replace(/font-size:\s*(\d+)px/g, function (decl, px) {
          var step = CHROME_LADDER[Number(px)];
          if (!step) return decl;
          changed = true;
          return "font-size:" + sizeOf(step);
        });
        if (!changed) return rule;
        // The size this rule itself declared. A rule with more than one
        // font-size is left with its original leading — guessing which size a
        // line-height belongs to is worse than not touching it.
        var declared = body.match(/font-size:\s*(\d+)px/g);
        var sourcePx = null;
        if (declared && declared.length === 1) {
          var one = Number(declared[0].replace(/[^0-9]/g, ""));
          if (CHROME_LADDER[one]) sourcePx = one;
        }
        if (sourcePx !== null) {
          next = next.replace(/line-height:\s*(\d+)px/g, function (decl, px) {
            var gap = Number(px) - sourcePx;
            return "line-height:calc(" + (STEP_PX[CHROME_LADDER[sourcePx]] + gap) + "px + var(--dsh-content-font-delta, 0px))";
          });
        }
        return selector + "{" + next + "}";
      });
    }

    var STYLE_MARK = "data-zcode-theme";

    /**
     * Retune one stylesheet element and remember the original text on it, so a
     * second pass (and the unload path) can put it back.
     * @param {HTMLStyleElement} tag
     */
    function retuneStyleTag(tag) {
      if (tag.getAttribute(STYLE_MARK) === "1") return;
      if (!tag.textContent || tag.textContent.indexOf("font-size:") === -1) return;
      var tuned = retuneChromeCss(tag.textContent);
      if (tuned === tag.textContent) return;
      tag.setAttribute(STYLE_MARK, "1");
      tag.setAttribute(STYLE_MARK + "-original", "");
      // The original can be large; keep it on the element as a property rather
      // than an attribute so it never round-trips through HTML.
      tag.__zcodeOriginal = tag.textContent;
      tag.textContent = tuned;
    }

    function restoreStyleTag(tag) {
      if (tag.getAttribute(STYLE_MARK) !== "1") return;
      if (typeof tag.__zcodeOriginal === "string") tag.textContent = tag.__zcodeOriginal;
      tag.removeAttribute(STYLE_MARK);
      delete tag.__zcodeOriginal;
    }

    /**
     * Walk the stylesheets already in the document, then watch for ones added
     * later (plugin HMR, lazily mounted features). Both the walk and the
     * observer are disposed with the plugin, and disposal restores every sheet
     * this pass rewrote.
     */
    function installChromeLadder(ctx) {
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
      ctx.effect(function () {
        var touched = [];
        function consider(node) {
          if (!node || node.nodeType !== 1 || node.tagName !== "STYLE") return;
          retuneStyleTag(node);
          if (node.getAttribute(STYLE_MARK) === "1") touched.push(node);
        }
        var present = document.querySelectorAll("style");
        for (var i = 0; i < present.length; i++) consider(present[i]);
        var observer = new MutationObserver(function (records) {
          for (var r = 0; r < records.length; r++) {
            var added = records[r].addedNodes;
            for (var n = 0; n < added.length; n++) consider(added[n]);
          }
        });
        observer.observe(document.head, { childList: true });
        return function () {
          observer.disconnect();
          for (var t = 0; t < touched.length; t++) restoreStyleTag(touched[t]);
        };
      }, "dsh-zcode-theme: chrome type ladder");
    }

    /**
     * @param {object} ctx - client context. `theme` is required.
     * @param {{ fonts?: boolean, palette?: boolean, accent?: boolean }} [config]
     */
    function apply(ctx, config) {
      var fonts = !config || config.fonts !== false;
      var palette = !config || config.palette !== false;
      var accent = !!config && config.accent === true;
      var tokens = {};
      if (palette) assign(tokens, surfaceTokens(accent));
      if (fonts) {
        assign(tokens, fontTokens());
        installChromeLadder(ctx);
      }
      if (Object.keys(tokens).length === 0) return;
      // The runner replaces the source argument with this package's id.
      ctx.theme.overrideTokens("dsh-zcode-theme", tokens);
    }

    exports.apply = apply;
    exports.inject = ["theme"];
    return module.exports;
  },
});
