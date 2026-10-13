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
    const MAX_HEIGHT = 320;

    /** DOM id of one option row (the aria-activedescendant target). */
    function optionId(source, index) {
      return `dsh-slash-option-${source}-${index}`;
    }

    const M = {
      menu: {
        boxSizing: "border-box", minWidth: 260, maxWidth: 460, maxHeight: 320, overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 2, padding: "6px 4px",
        borderRadius: 12, border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2)", boxShadow: "0 8px 24px rgba(0,0,0,.18)",
      },
      crumbs: { display: "flex", alignItems: "center", gap: 2, padding: "2px 8px 4px", flexWrap: "wrap" },
      crumb: {
        font: "inherit", fontSize: 11.5, padding: "1px 7px", borderRadius: 6, cursor: "pointer",
        border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary)",
      },
      crumbCurrent: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, cursor: "default" },
      crumbSep: { display: "inline-flex", color: "var(--dsw-alias-label-caption)", flex: "none" },
      title: {
        fontSize: 11, fontWeight: 500, letterSpacing: ".04em", textTransform: "uppercase",
        color: "var(--dsw-alias-label-caption)", padding: "6px 10px 2px",
      },
      sectionTitle: {
        fontSize: 11, color: "var(--dsw-alias-label-caption)", padding: "6px 10px 1px",
        borderTop: "1px solid var(--dsw-alias-border-l1)", marginTop: 4,
      },
      item: {
        display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
        font: "inherit", border: "none", background: "transparent", cursor: "pointer",
        padding: "5px 10px", borderRadius: 8, color: "var(--dsw-alias-label-primary)",
      },
      itemActive: { background: "var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3))" },
      itemIcon: {
        width: 16, height: 16, flex: "none", display: "inline-flex",
        alignItems: "center", justifyContent: "center", color: "var(--dsw-alias-label-tertiary)",
      },
      itemImg: { width: 16, height: 16, objectFit: "contain", display: "block", borderRadius: 3 },
      itemName: {
        color: "var(--dsw-alias-label-primary)", flex: "none",
        fontSize: "var(--dsh-content-font-size-secondary, 13px)",
      },
      itemDesc: {
        color: "var(--dsw-alias-label-tertiary)", minWidth: 0, flex: 1,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        fontSize: "var(--dsh-content-font-size-secondary, 13px)",
      },
      trailing: { display: "inline-flex", alignItems: "center", gap: 4, flex: "none" },
      drillHintText: { fontSize: 11, color: "var(--dsw-alias-label-caption)" },
      drillKey: {
        font: "inherit", fontSize: 10.5, padding: "0 5px", borderRadius: 4, lineHeight: "16px",
        border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-tertiary)",
      },
      skeletonRow: { display: "flex", padding: "6px 10px" },
      skeletonBar: {
        height: 10, borderRadius: 999,
        background: "var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3))",
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
     * The '/' candidate menu overlay. Renders the trigger service's menu
     * store; see the module doc for the section/icon addition.
     * @param {{menu: object, headers: object, onPick: Function, onCrumb: Function,
     *          onHover: Function, onDismiss: Function, t: Function}} props
     */
    function SlashMenuView({ menu, headers, onPick, onCrumb, onHover, onDismiss, t }) {
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
                index > 0 ? h("span", { style: M.crumbSep, "aria-hidden": true }, h(P.IconChevronRightOutline14, {})) : null,
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
                  children.push(h("div", { key: `s-${display}`, role: "presentation", style: M.sectionTitle }, row.section));
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
                  row.pkg !== undefined ? h(PackageGlyph, { pkg: row.pkg }) : null,
                  item.icon !== undefined ? h("span", { style: M.itemIcon, "aria-hidden": true }, h(P.ReferenceIcon, { kind: item.icon, size: 16 })) : null,
                  h("span", { style: M.itemName }, item.name),
                  description !== undefined ? h("span", { style: M.itemDesc }, description) : null,
                  item.drill === true ? h("span", { style: M.trailing },
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
                    }, h(P.IconChevronRightOutline14, {})),
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
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-menu: dictionaries");

      ctx.inject(["slots"], (scope) => {
        scope.slots.inject("conversation.input.overlay", () => scope.slots.register({
          name: "conversation.input.overlay",
          id: "slash-menu",
          order: 0,
          locale: NS,
          inject: (sessionId) => {
            const actx = ctx.sessions?.scope?.(sessionId);
            const inputTriggers = ctx.get("inputTriggers");
            if (!actx || !inputTriggers) return {};
            const controller = inputTriggers.sessionOf(actx);
            return {
              menu: controller.menu,
              headers: controller.headers,
              onPick: (source, index, action) => controller.pick(source, index, action),
              onCrumb: (source, index) => controller.pickCrumb(source, index),
              onHover: (source, index) => controller.hover(source, index),
              onDismiss: () => controller.dismiss(),
            };
          },
        }, SlashMenuView));
      })
    }

    exports.apply = apply;
    exports.attributionOf = attributionOf;
    exports.sectioned = sectioned;
    exports.inject = ["slots", "locale", "sessions"];
    return module.exports;
  },
});
