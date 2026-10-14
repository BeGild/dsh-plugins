/**
 * dsh-skill-menu — browser half.
 *
 * Owns the '/' candidate menu VIEW: this bundle loads before dsh-web-app
 * (bundle order), registers `conversation.input.overlay` under the stock
 * cell id `slash-menu` depending only on the early `slots` service, and the
 * cell's first-registration-wins rule then keeps the stock MenuView from
 * ever rendering — while the stock trigger framework, its service, its '/'
 * source, and its skill tool row all keep running untouched.
 *
 * The view is a faithful re-implementation of the stock MenuView (combobox
 * pattern, breadcrumbs, skeleton, drill) with one addition: the skill
 * group's candidates are re-ordered into contiguous package sections at
 * render time — the `[package]` attribution prefix dsh-skill-market writes
 * becomes the section header, is stripped from the description line, and
 * renders the package's marketplace icon (ZCode manifest icon or WorkBuddy
 * zip icon, proxied same-origin).
 *
 * Plain ES2020 in the DSH client-bundle format on purpose: no bundler, no
 * build step — this file IS the artifact. Colours come from `--dsw-*` design
 * tokens and every string from the `skill-menu` locale namespace (zh + en).
 */
window.__ModuleLoader__.load({
  id: "dsh-skill-menu",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const P = require("@deepseek-ai/dsh-client-ui-primitives");
    const React = require("react");
    const h = React.createElement;

    // Primitives renamed every glyph for dsh 0.2 (IconXOutline16 ->
    // IconXOutlineMedium/Regular; ReferenceIcon -> ReferenceIconRegular).
    // Pick whichever export this runtime ships; a missing glyph renders as
    // nothing instead of crashing the whole menu entry.
    const pick = (...names) => {
      for (const name of names) if (typeof P[name] === "function") return P[name];
      return undefined;
    };
    const G = {
      think: pick("IconThinkOutline16", "IconThinkOutlineMedium", "IconThinkOutlineRegular"),
      enhance: pick("IconEnhanceOutline16", "IconEnhanceOutlineMedium", "IconEnhanceOutlineRegular"),
      download: pick("IconDownloadOutline16", "IconDownloadOutlineMedium", "IconDownloadOutlineRegular"),
      like: pick("IconLikeOutline16", "IconLikeOutlineMedium", "IconLikeOutlineRegular"),
      goal: pick("IconGoalOutline16", "IconGoalOutlineMedium", "IconGoalOutlineRegular"),
      settings: pick("IconSettingsOutline16", "IconSettingsOutlineMedium", "IconSettingsOutlineRegular"),
      checklist: pick("IconChecklistOutline14", "IconChecklistOutlineMedium", "IconChecklistOutlineRegular"),
      context: pick("IconContextInjectionOutline16", "IconContextInjectionOutlineMedium", "IconContextInjectionOutlineRegular"),
      clock: pick("IconClockOutline16", "IconClockOutlineMedium", "IconClockOutlineRegular"),
      question: pick("IconQuestionOutline14", "IconQuestionOutlineMedium", "IconQuestionOutlineRegular"),
      cordis: pick("IconCordisPluginOutline14", "IconCordisPluginOutlineMedium", "IconCordisPluginOutlineRegular"),
      chevronRight: pick("IconChevronRightOutline14", "IconChevronRightOutlineMedium", "IconChevronRightOutlineRegular"),
      reference: pick("ReferenceIcon", "ReferenceIconRegular"),
    };
    const glyph = (component, size) => (component ? h(component, { size }) : null);

    /** Locale namespace; also the `locale` option of the overlay entry. */
    const NS = "skill-menu";
    /** The attribution prefix dsh-skill-market writes into sub-skills. */
    const PACKAGE_PREFIX = /^\[([^\]]+)\]\s*/;
    /** The trigger-source group whose candidates get package sections. */
    const SKILL_SOURCE = "skill";

    const zh = {
      "crumbs.aria": "层级路径",
      "suggestions.aria": "触发候选建议",
      "loading": "加载中",
      "drill.hint": "细化",
      "drill.key": "Tab",
      "drill.aria": "细化此候选",
      "section.local": "本地技能",
      "skill": "技能",
      "command": "指令",
      "context": "上下文",
      "reference": "引用",
      "genui": "GenUI",
    };

    const en = {
      "crumbs.aria": "Hierarchy trail",
      "suggestions.aria": "Trigger suggestions",
      "loading": "Loading",
      "drill.hint": "refine",
      "drill.key": "Tab",
      "drill.aria": "Refine this candidate",
      "section.local": "Local skills",
      "skill": "Skills",
      "command": "Commands",
      "context": "Context",
      "reference": "References",
      "genui": "GenUI",
    };

    /**
     * Split one skill candidate's package attribution off its description.
     * @param {{description?: string}} item - one skill-group candidate.
     * @returns {{package: string|null, description: string}}
     */
    function attributionOf(item) {
      const raw = item.description ?? "";
      const match = PACKAGE_PREFIX.exec(raw);
      if (!match) return { package: null, description: raw };
      return { package: match[1], description: raw.slice(match[0].length) };
    }

    /**
     * Re-order one group's items so section headers group them: attributed
     * packages first in first-seen order, the local section last, the
     * original rank preserved inside each section. Non-skill groups pass
     * through unchanged.
     */
    function sectioned(items, localLabel) {
      const sections = [];
      const bySection = new Map();
      items.forEach((item, originalIndex) => {
        const key = attributionOf(item).package ?? localLabel;
        if (!bySection.has(key)) {
          bySection.set(key, []);
          sections.push(key);
        }
        bySection.get(key).push({ item, originalIndex });
      });
      const order = [...sections.filter((s) => s !== localLabel), localLabel].filter((s) => bySection.has(s));
      const out = [];
      for (const key of order) {
        for (const entry of bySection.get(key)) {
          out.push({ ...entry, section: key, pkg: key === localLabel ? undefined : key });
        }
      }
      return out;
    }

    /** Design cap on the list height, matching the stock menu. */
    const MAX_HEIGHT = 400;

    /** DOM id of one option row (the aria-activedescendant target). */
    function optionId(source, index) {
      return `dsh-slash-option-${source}-${index}`;
    }

    const M = {
      // Mirrors the stock MenuView.module.css: absolutely positioned above the
      // overlay anchor (drop-UP over the whole composer), full composer width.
      menu: {
        position: "absolute", bottom: "calc(100% + 4px)", left: 0, right: 0, zIndex: 100,
        display: "flex", flexDirection: "column", padding: 4, maxHeight: 400, overflow: "hidden", boxSizing: "border-box",
        borderRadius: 20, border: 0,
        background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2))",
        boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18))",
      },
      viewport: { display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" },
      crumbs: {
        display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", flex: "none",
        padding: "4px 4px 6px", marginBottom: 2,
        borderBottom: ".5px solid var(--dsw-alias-border-l1)",
      },
      crumb: {
        fontFamily: "inherit", fontSize: 12, lineHeight: "18px", maxWidth: "40%",
        padding: "2px 6px", borderRadius: 6, cursor: "pointer",
        border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
      crumbCurrent: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, cursor: "default" },
      crumbSep: { display: "inline-flex", color: "var(--dsw-alias-label-caption)", flex: "none" },
      title: {
        color: "var(--dsw-alias-label-tertiary)", padding: "8px 10px",
        fontSize: 12, lineHeight: "16px",
      },
      sectionTitle: {
        minHeight: 26, color: "var(--dsw-alias-label-tertiary)", flex: "none",
        padding: "6px 10px 2px", fontSize: 12, fontWeight: 500, lineHeight: "18px",
      },
      sectionTitleSpaced: { marginTop: 4 },
      item: {
        display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 34,
        textAlign: "left", font: "inherit", fontSize: 13, lineHeight: "20px",
        border: "none", background: "transparent", cursor: "pointer",
        padding: "6px 8px", borderRadius: "var(--dsw-radius-md, 8px)", color: "var(--dsw-alias-label-primary)",
      },
      itemActive: { background: "var(--dsw-alias-interactive-bg-hover)" },
      itemIcon: {
        width: 14, height: 14, flex: "none", display: "inline-flex",
        alignItems: "center", justifyContent: "center", color: "var(--dsw-alias-label-tertiary)",
      },
      itemImg: { width: 14, height: 14, objectFit: "contain", display: "block", borderRadius: 3 },
      itemName: {
        color: "var(--dsw-alias-label-primary)", flex: "none", maxWidth: "40%",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 13,
      },
      itemDesc: {
        color: "var(--dsw-alias-label-tertiary)", minWidth: 0, flex: 1, textAlign: "right",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12, lineHeight: "18px",
      },
      itemAlias: {
        color: "var(--dsw-alias-label-tertiary)", flex: "none", maxWidth: "20%",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12, lineHeight: "18px",
      },
      trailing: { display: "inline-flex", alignItems: "center", gap: 4, flex: "none", marginLeft: "auto" },
      drillHintText: { color: "var(--dsw-alias-label-caption)", whiteSpace: "nowrap", fontSize: 11, lineHeight: "18px" },
      drillKey: {
        fontFamily: "inherit", fontSize: 11, lineHeight: "18px", padding: "0 5px", borderRadius: 4,
        background: "var(--dsw-alias-interactive-bg-hover)",
        color: "var(--dsw-alias-label-caption)",
      },
      skeletonRow: { display: "flex", alignItems: "center", minHeight: 40, padding: "8px 10px", boxSizing: "border-box" },
      skeletonBar: {
        height: 20, borderRadius: 4, background: "var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-3))",
      },
    };

    /**
     * One candidate's package glyph: tries the ZCode marketplace proxy, then
     * the WorkBuddy zip proxy, then gives up (no icon). Both routes come from
     * dsh-skill-market's host half; when that plugin is absent every attempt
     * 404s and the row renders without art.
     * @param {{pkg: string}} props
     */
    function PackageGlyph({ pkg }) {
      const attempts = React.useMemo(() => ([
        `/skill-market/api/icon?source=zcode&id=${encodeURIComponent(pkg)}`,
        `/skill-market/api/icon?source=workbuddy-skill&id=${encodeURIComponent(pkg)}`,
      ]), [pkg]);
      const [at, setAt] = React.useState(0);
      if (at >= attempts.length) return null;
      return h("span", { style: M.itemIcon, "aria-hidden": true },
        h("img", {
          style: M.itemImg,
          src: attempts[at],
          alt: "",
          loading: "lazy",
          onError: () => setAt((n) => n + 1),
        }),
      );
    }

    /**
     * The skill glyph, verbatim from WorkBuddy's Lucide table (`hammer`, 24×24):
     * handle, strike face, head. Their UI marks every skill with it; ours now
     * does the same for skills without a package icon.
     */
    function HammerGlyph() {
      return h("svg", {
        width: 14, height: 14, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", strokeWidth: 1.6,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
      },
        h("path", { d: "m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" }),
        h("path", { d: "m18 15 4-4" }),
        h("path", { d: "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" }),
      );
    }

    /** Built-in host commands, by name. */
    const COMMAND_ICONS = {
      model: () => glyph(G.think, 16),
      compact: () => glyph(G.enhance, 16),
      export: () => glyph(G.download, 16),
      feedback: () => glyph(G.like, 16),
      goal: () => glyph(G.goal, 16),
      permission: () => glyph(G.settings, 16),
      plan: () => glyph(G.checklist, 14),
      context: () => glyph(G.context, 16),
      undo: () => glyph(G.clock, 16),
      rewind: () => glyph(G.clock, 16),
      btw: () => glyph(G.question, 14),
    };
    /** Fallbacks so every row keeps its leading glyph slot. */
    const COMMAND_DEFAULT = () => glyph(G.cordis, 14);
    const SKILL_DEFAULT = HammerGlyph;

    /**
     * Commands contributed by a market-installed plugin map back to that
     * plugin's icon (e.g. watch-positions's /events renders the plugin's
     * marketplace art, matching its skill section). Populated once from
     * dsh-skill-market's installed records; without that plugin the map stays
     * empty and such commands fall to the plugin glyph.
     */
    const commandPackages = new Map();
    try {
      fetch("/skill-market/api/installed", { headers: { Accept: "application/json" } })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (!body?.ok) return;
          for (const record of body.entries ?? []) {
            for (const command of record.commands ?? []) commandPackages.set(command, record.id);
          }
        })
        .catch(() => {});
    } catch { /* offline hosts keep the empty map */ }

    /** The leading glyph of one row: host face art, marketplace art, a mapped builtin, or a default. */
    function RowGlyph({ group, item, pkg }) {
      if (pkg !== undefined) return h(PackageGlyph, { pkg });
      // dsh 0.2 candidates carry their own icon: a component (the host's
      // builtin faces) or a string reference kind (older groups).
      if (item.icon !== undefined) {
        const art = typeof item.icon === "string"
          ? glyph(G.reference, 14)
          : h(item.icon, { size: 14 });
        return h("span", { style: M.itemIcon, "aria-hidden": true }, art);
      }
      if (group === "command") {
        const pluginPkg = commandPackages.get(item.name);
        if (pluginPkg !== undefined) return h(PackageGlyph, { pkg: pluginPkg });
        const make = COMMAND_ICONS[item.name] ?? COMMAND_DEFAULT;
        return h("span", { style: M.itemIcon, "aria-hidden": true }, make ? make() : null);
      }
      if (group === "context") {
        const make = COMMAND_ICONS[item.name];
        return h("span", { style: M.itemIcon, "aria-hidden": true }, make ? make() : null);
      }
      if (group === "skill") {
        return h("span", { style: M.itemIcon, "aria-hidden": true }, SKILL_DEFAULT());
      }
      return null;
    }

    /**
     * The '/' candidate menu overlay. Renders the trigger service's menu
     * store; see the module doc for the section/icon addition.
     * @param {{menu: object, headers: object, onPick: Function, onCrumb: Function,
     *          onHover: Function, onDismiss: Function, t: Function}} props
     */
    function SlashMenuView(props) {
      if (!props || props.menu === undefined) return null
      const { menu, headers, onPick, onCrumb, onHover, onDismiss, t } = props
      const state = React.useSyncExternalStore(
        (fn) => menu.subscribe(fn),
        () => menu.getSnapshot(),
      );
      const crumbs = React.useSyncExternalStore(
        (fn) => headers.subscribe(fn),
        () => headers.getSnapshot(),
      );
      const listRef = React.useRef(null);
      const maxHeight = P.useAnchoredMaxHeight(listRef, MAX_HEIGHT, state);
      const highlight = state.open ? state.highlight : null;
      React.useEffect(() => {
        if (highlight === null) return;
        document.getElementById(optionId(highlight.source, highlight.index))?.scrollIntoView({ block: "nearest" });
      }, [highlight]);
      React.useEffect(() => {
        if (!state.open) return;
        const onPointerDown = (ev) => {
          if (!(ev.target instanceof Node)) return;
          if (listRef.current?.contains(ev.target)) return;
          if (listRef.current?.closest("[data-composer-card]")?.contains(ev.target)) return;
          onDismiss();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
      }, [state.open, onDismiss]);
      if (!state.open) return null;
      return h("div", { ref: listRef, style: { ...M.menu, maxHeight }, "data-trigger-menu": "" },
        state.groups.map((group) => {
          const trail = crumbs.get(group.source);
          if (trail === void 0) return null;
          return h("nav", { key: `crumbs-${group.source}`, style: M.crumbs, "aria-label": t("crumbs.aria") },
            trail.map((crumb, index) =>
              h(React.Fragment, { key: `${index}-${crumb.value}` },
                index > 0 ? h("span", { style: M.crumbSep, "aria-hidden": true }, glyph(G.chevronRight, 14)) : null,
                h("button", {
                  type: "button",
                  style: { ...M.crumb, ...(crumb.current === true ? M.crumbCurrent : {}) },
                  "aria-current": crumb.current === true ? "location" : undefined,
                  disabled: crumb.current === true,
                  onMouseDown: (ev) => {
                    ev.preventDefault();
                    onCrumb(group.source, index);
                  },
                }, crumb.label),
              ),
            ),
          );
        }),
        h("div", {
          role: "listbox",
          style: M.viewport,
          "aria-label": t("suggestions.aria"),
          "aria-activedescendant": highlight !== null ? optionId(highlight.source, highlight.index) : undefined,
        },
          state.groups.map((group) => {
            if (group.status === "ready" && group.items.length === 0) return null;
            const isSkills = group.source === SKILL_SOURCE;
            const rows = isSkills
              ? sectioned(group.items, t("section.local"))
              : group.items.map((item, originalIndex) => ({ item, originalIndex, section: item.section, pkg: undefined }));
            const hasSections = rows.some((row) => row.section !== void 0);
            const children = [];
            if (group.showGroupTitle === false || hasSections) {
              /* a sectioned group carries its own headers */
            } else {
              children.push(h("div", {
                key: "title", role: "presentation", "data-source": group.source, style: M.title,
              }, t(group.source)));
            }
            if (group.status === "pending" && group.items.length === 0) {
              children.push(h("div", { key: "loading", role: "status", "aria-label": t("loading"), "data-source": group.source },
                h("div", { style: M.skeletonRow }, h("span", { style: { ...M.skeletonBar, width: "32%" } })),
                h("div", { style: M.skeletonRow }, h("span", { style: { ...M.skeletonBar, width: "48%" } })),
              ));
            } else {
              let display = -1;
              let previousRow = null;
              for (const row of rows) {
                display += 1;
                const item = row.item;
                // pick/hover/highlight speak the service's ORIGINAL item index;
                // only the display order was re-arranged into sections.
                const index = row.originalIndex;
                const active = highlight !== null && highlight.source === group.source && highlight.index === index;
                if (row.section !== void 0 && row.section !== previousRow?.section) {
                  children.push(h("div", {
                    key: `s-${display}`,
                    role: "presentation",
                    style: children.length > 0 ? { ...M.sectionTitle, ...M.sectionTitleSpaced } : M.sectionTitle,
                  }, row.section));
                }
                previousRow = row;
                const description = isSkills ? attributionOf(item).description : item.description;
                children.push(h("button", {
                  key: optionId(group.source, index),
                  id: optionId(group.source, index),
                  type: "button",
                  role: "option",
                  "aria-selected": active,
                  style: { ...M.item, ...(active ? M.itemActive : {}) },
                  onMouseDown: (ev) => {
                    ev.preventDefault();
                    onPick(group.source, index);
                  },
                  onMouseMove: active ? undefined : () => onHover(group.source, index),
                },
                  h(RowGlyph, { group: group.source, item, pkg: row.pkg }),
                  h("span", { style: M.itemName }, item.label ?? item.name),
                  item.label !== undefined && item.label.toLowerCase() !== item.name.toLowerCase()
                    ? h("span", { style: M.itemAlias }, item.name)
                    : null,
                  description !== undefined ? h("span", { style: M.itemDesc }, description) : null,
                  item.drill === true && active ? h("span", { style: M.trailing },
                    h("span", { style: M.drillHintText, "aria-hidden": true }, t("drill.hint")),
                    h("kbd", { style: M.drillKey, "aria-hidden": true }, t("drill.key")),
                    h("span", {
                      role: "button",
                      "aria-label": t("drill.aria"),
                      style: { display: "inline-flex", color: "var(--dsw-alias-label-tertiary)" },
                      onMouseDown: (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        onPick(group.source, index, "drill");
                      },
                    }, glyph(G.chevronRight, 14)),
                  ) : null,
                ));
              }
            }
            return h(React.Fragment, { key: group.source }, children);
          }),
        ),
      );
    }

    /**
     * Client plugin body: dictionaries, then the overlay entry. Registration
     * depends only on `slots` (available before the trigger framework mounts
     * its service), so with this bundle ahead of dsh-web-app the entry lands
     * before the stock MenuView's and the first-wins cell rule keeps ours.
     * The controller faces resolve lazily at render time, by which point the
     * trigger framework is up.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      const diag = (stage, err) => {
        try { (window.__smDiag = window.__smDiag || []).push(`${stage}: ${err && (err.stack || err.message || String(err))}`) } catch (e) {}
      }
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-menu: dictionaries");

        ctx.inject(["slots"], (scope) => {
          scope.slots.inject("conversation.input.overlay", () => scope.slots.register({
            name: "conversation.input.overlay",
            id: "slash-menu",
            order: 0,
            locale: NS,
            inject: (sessionId) => {
              try {
                const actx = ctx.sessions?.scope?.(sessionId)
                const inputTriggers = ctx.get("inputTriggers")
                diag("faces", `sid=${sessionId} actx=${actx && typeof actx} svc=${inputTriggers && typeof inputTriggers}`)
                if (!actx || !inputTriggers) return {}
                const controller = inputTriggers.sessionOf(actx)
                return {
                  menu: controller.menu,
                  headers: controller.headers,
                  onPick: (source, index, action) => controller.pick(source, index, action),
                  onCrumb: (source, index) => controller.pickCrumb(source, index),
                  onHover: (source, index) => controller.hover(source, index),
                  onDismiss: () => controller.dismiss(),
                }
              } catch (e) { diag("inject", e); return {} }
            },
          }, SlashMenuView));
        })
      } catch (e) { diag("apply", e) }
    }

    exports.apply = apply;
    exports.attributionOf = attributionOf;
    exports.sectioned = sectioned;
    exports.inject = ["slots", "locale", "sessions"];
    return module.exports;
  },
});
