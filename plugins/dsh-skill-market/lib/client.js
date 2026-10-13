/**
 * dsh-skill-market — browser half.
 *
 * The marketplace panel: a sidebar row ("global panel" seat
 * `sidebar.panellist`) whose main-panel cell (`main`, keyed by the same id)
 * lists the two catalogs, searches them, and installs or removes entries with
 * one click. The host half serves the JSON routes this panel fetches; a user
 * who prefers typing can still drive the same operations through the
 * `skill_market` model tool.
 *
 * Plain ES2020 in the DSH client-bundle format on purpose: no bundler, no
 * build step — this file IS the artifact. Executing it only REGISTERS a
 * factory; the slots are claimed when the module is first materialized.
 *
 * Colours come from `--dsw-*` design tokens and every string comes from the
 * `skill-market` locale namespace (zh + en), per the client-plugin rules.
 */
window.__ModuleLoader__.load({
  id: "dsh-skill-market",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Locale namespace; also the `locale` registration option of the panel cell. */
    const NS = "skill-market";
    /** Sidebar row id AND the main-panel key it dispatches. */
    const PANEL_ID = "skill-market";
    /** Host routes registered by lib/index.js. */
    const BASE = "/skill-market/api";
    /** Catalog tabs, in display order; the third reads the install records. */
    const TABS = [
      { id: "zcode", key: "tab.zcode" },
      { id: "workbuddy-skill", key: "tab.workbuddy" },
      { id: "installed", key: "tab.installed" },
    ];

    const zh = {
      "panel.label": "技能市场",
      "panel.title": "技能市场",
      "panel.subtitle": "浏览 ZCode 插件与 WorkBuddy 技能,一键装进当前 DSH。ZCode 插件的技能、斜杠命令、hooks 和 MCP 服务器会一并接入。",
      "tab.zcode": "ZCode 插件",
      "tab.workbuddy": "WorkBuddy 技能",
      "tab.installed": "已安装",
      "search.placeholder": "搜索名称或描述…",
      "search.action": "搜索",
      "state.loading": "加载中…",
      "state.empty": "没有匹配的结果",
      "state.unreachable": "读不到市场状态(插件未启用或路由不可达)",
      "action.install": "安装",
      "action.installing": "安装中…",
      "action.remove": "卸载",
      "action.removing": "卸载中…",
      "badge.installed": "已安装",
      "badge.listedOnly": "仅展示",
    };

    const en = {
      "panel.label": "Skill market",
      "panel.title": "Skill market",
      "panel.subtitle": "Browse ZCode plugins and WorkBuddy skills and install them into this DSH with one click. A ZCode plugin brings its skills, slash commands, hooks, and MCP servers along.",
      "tab.zcode": "ZCode plugins",
      "tab.workbuddy": "WorkBuddy skills",
      "tab.installed": "Installed",
      "search.placeholder": "Search name or description…",
      "search.action": "Search",
      "state.loading": "Loading…",
      "state.empty": "Nothing matched",
      "state.unreachable": "Market status unavailable (plugin disabled or route missing)",
      "action.install": "Install",
      "action.installing": "Installing…",
      "action.remove": "Remove",
      "action.removing": "Removing…",
      "badge.installed": "Installed",
      "badge.listedOnly": "Listed only",
    };

    /**
     * One GET against a plugin route, decoded as JSON.
     * @param {string} path - same-origin path under BASE.
     * @returns {Promise<object>} the decoded body.
     */
    async function getJson(path) {
      const res = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /**
     * One JSON POST against a plugin route.
     * @param {string} path - same-origin path under BASE.
     * @param {object} body - the request payload.
     * @returns {Promise<object>} the decoded response.
     */
    async function postJson(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /**
     * The injected business face. Module-level and frozen so its identity is
     * stable across renders — the panel's effects depend on it.
     */
    const API = Object.freeze({
      /** @returns {Promise<{entries: object[], total: number, truncated: boolean}>} one result page, or throws. */
      async search(source, query) {
        const params = new URLSearchParams({ source });
        if (query) params.set("q", query);
        const body = await getJson(`${BASE}/search?${params.toString()}`);
        if (!body?.ok) throw new Error(body?.error || "search failed");
        return body;
      },
      /** @returns {Promise<{entries: object[]}>} the install records, or throws. */
      async installed() {
        const body = await getJson(`${BASE}/installed`);
        if (!body?.ok) throw new Error(body?.error || "installed list unavailable");
        return body;
      },
      /** @returns {Promise<object>} the activation report from the host. */
      async install(source, id) {
        const body = await postJson(`${BASE}/install`, { source, id });
        if (!body?.ok) throw new Error(body?.error || "install failed");
        return body.result;
      },
      /** @returns {Promise<{message: string}>} the removal account. */
      async remove(id) {
        const body = await postJson(`${BASE}/remove`, { id });
        if (!body?.ok) throw new Error(body?.error || "remove failed");
        return body;
      },
    });

    const S = {
      panel: {
        height: "100%", overflowY: "auto", boxSizing: "border-box", padding: "28px 20px 40px",
        background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit",
        display: "flex", flexDirection: "column", alignItems: "center",
      },
      column: { width: "100%", maxWidth: 680, display: "flex", flexDirection: "column", gap: 14 },
      title: { margin: 0, fontSize: 17, fontWeight: 600 },
      subtitle: { margin: "6px 0 0", fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      tabs: { display: "flex", gap: 6, flexWrap: "wrap" },
      tab: {
        padding: "6px 14px", borderRadius: 999, cursor: "pointer", font: "inherit", fontSize: 13,
        border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
      },
      tabActive: {
        border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-primary)", fontWeight: 600,
      },
      searchForm: { display: "flex", gap: 8 },
      searchInput: {
        flex: 1, minWidth: 0, padding: "8px 12px", borderRadius: 8, font: "inherit", fontSize: 13,
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
      },
      button: {
        padding: "7px 16px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 13,
        border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
        color: "var(--dsw-alias-label-primary)",
      },
      buttonPrimary: {
        border: "1px solid transparent", background: "var(--dsw-alias-state-accent-primary, var(--dsw-alias-link))",
        color: "var(--dsw-alias-bg-base)",
      },
      buttonBusy: { opacity: 0.6, cursor: "default" },
      card: {
        padding: "14px 16px", borderRadius: 12, border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
      },
      cardHead: { display: "flex", alignItems: "baseline", gap: 10 },
      name: { fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" },
      meta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 2, overflowWrap: "anywhere" },
      desc: {
        fontSize: 12.5, lineHeight: "19px", color: "var(--dsw-alias-label-secondary)", marginTop: 8,
        display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
      },
      cardFoot: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 },
      badge: {
        display: "inline-flex", alignItems: "center", padding: "2px 9px", borderRadius: 999, fontSize: 11.5,
        background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-tertiary)", flex: "none",
      },
      badgeOn: { color: "var(--dsw-alias-state-success-primary)" },
      status: { fontSize: 12.5, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      error: { fontSize: 12.5, lineHeight: "18px", color: "var(--dsw-alias-state-danger-primary)" },
      iconWrap: { display: "inline-flex", alignItems: "center", justifyContent: "center" },
    };

    /** Market/goods glyph. Sized by the sidebar's owner props. */
    function BagGlyph({ size }) {
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true", focusable: "false",
      },
        h("path", { d: "M4 8h16l-1.2 11a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 8z" }),
        h("path", { d: "M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5" }),
      );
    }

    /**
     * Sidebar row: the glyph. Clicking it opens the panel cell.
     * @param {{size: number, active: boolean}} props - owner props from the sidebar shell.
     */
    function PanelIcon({ size, active }) {
      return h("span", {
        style: {
          ...S.iconWrap,
          color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
        },
      }, h(BagGlyph, { size }));
    }

    /**
     * One catalog card: name, meta, description, and the action button.
     * @param {{t: Function, entry: object, installed: boolean, busy: boolean,
     *          onAction: (kind: 'install'|'remove') => void}} props
     */
    function EntryCard({ t, entry, installed, busy, onAction }) {
      const meta = [
        entry.id,
        entry.version ? `v${entry.version}` : null,
        entry.category || null,
      ].filter(Boolean).join(" · ");
      const kind = installed ? "remove" : "install";
      return h("div", { style: S.card },
        h("div", { style: S.cardHead },
          h("span", { style: S.name }, entry.name || entry.id),
          installed
            ? h("span", { style: { ...S.badge, ...S.badgeOn } }, t("badge.installed"))
            : entry.installable === false
              ? h("span", { style: S.badge, title: entry.reason || "" }, t("badge.listedOnly"))
              : null,
        ),
        meta ? h("div", { style: S.meta }, meta) : null,
        entry.description ? h("div", { style: S.desc }, entry.description) : null,
        entry.installable !== false || installed
          ? h("div", { style: S.cardFoot },
              h("button", {
                style: { ...S.button, ...(kind === "install" ? S.buttonPrimary : {}), ...(busy ? S.buttonBusy : {}) },
                disabled: busy,
                onClick: () => onAction(kind),
              }, busy ? t(kind === "install" ? "action.installing" : "action.removing") : t(`action.${kind}`)),
            )
          : null,
      );
    }

    /**
     * Main-panel cell: tabs, search, and the card list. Rendered only while
     * this panel is selected, so nothing polls once the user goes back to the
     * conversation.
     * @param {{t: Function, api: typeof API}} props - locale seat + injected face.
     */
    function MarketPanel({ t, api }) {
      const [tab, setTab] = React.useState("zcode");
      const [query, setQuery] = React.useState("");
      const [entries, setEntries] = React.useState(null);
      const [total, setTotal] = React.useState(0);
      const [truncated, setTruncated] = React.useState(false);
      const [installedIds, setInstalledIds] = React.useState([]);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState("");
      const [note, setNote] = React.useState("");
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setError("");
        setNote("");
        setEntries(null);
        (async () => {
          try {
            const page = tab === "installed" ? await api.installed() : await api.search(tab, query.trim());
            if (!alive) return;
            setEntries(page.entries ?? []);
            setTotal(page.total ?? (page.entries ?? []).length);
            setTruncated(page.truncated === true);
          } catch (e) {
            if (!alive) return;
            setEntries([]);
            setTotal(0);
            setTruncated(false);
            setError(e.message);
          }
        })();
        return () => { alive = false; };
      }, [tab, nonce, api, query]);

      React.useEffect(() => {
        let alive = true;
        api.installed()
          .then((page) => { if (alive) setInstalledIds((page.entries ?? []).map((entry) => entry.id)); })
          .catch(() => { if (alive) setInstalledIds([]); });
        return () => { alive = false; };
      }, [nonce, api]);

      const installedSet = React.useMemo(() => new Set(installedIds), [installedIds]);

      const run = async (kind, id) => {
        setBusy(id);
        setError("");
        setNote("");
        try {
          if (kind === "install") {
            const result = await api.install(tab, id);
            setNote(result?.message || t("action.install"));
          } else {
            const result = await api.remove(id);
            setNote(result?.message || t("action.remove"));
          }
          setNonce((n) => n + 1);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(null);
        }
      };

      return h("div", { style: S.panel },
        h("div", { style: S.column },
          h("div", null,
            h("h1", { style: S.title }, t("panel.title")),
            h("p", { style: S.subtitle }, t("panel.subtitle")),
          ),
          h("div", { style: S.tabs },
            TABS.map((item) => h("button", {
              key: item.id,
              type: "button",
              style: { ...S.tab, ...(tab === item.id ? S.tabActive : {}) },
              onClick: () => setTab(item.id),
            }, t(item.key))),
          ),
          tab !== "installed"
            ? h("form", {
                style: S.searchForm,
                onSubmit: (event) => { event.preventDefault(); setNonce((n) => n + 1); },
              },
              h("input", {
                style: S.searchInput,
                type: "search",
                value: query,
                placeholder: t("search.placeholder"),
                onChange: (event) => setQuery(event.target.value),
              }),
              h("button", { style: { ...S.button, ...S.buttonPrimary }, type: "submit" }, t("search.action")),
            )
            : null,
          error ? h("div", { style: S.error }, `${t("state.error")}: ${error}`) : null,
          note ? h("div", { style: S.status }, note) : null,
          entries === null
            ? h("div", { style: S.status }, t("state.loading"))
            : entries.length === 0
              ? h("div", { style: S.status }, error ? t("state.unreachable") : t("state.empty"))
              : h("div", { style: { ...S.column, gap: 10 } },
                truncated || total > entries.length
                  ? h("div", { style: S.status }, `${entries.length} / ${total}`)
                  : null,
                entries.map((entry) => h(EntryCard, {
                  key: `${entry.source}/${entry.id}`,
                  t,
                  entry,
                  installed: installedSet.has(entry.id),
                  busy: busy === entry.id,
                  onAction: (kind) => run(kind, entry.id),
                })),
              ),
        ),
      );
    }

    /**
     * Browser-side plugin body: dictionaries, then the two slots that make the
     * entry reachable — the sidebar row and the main cell it dispatches.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-market: dictionaries");
      const t = ctx.locale.bind(NS);
      // A thunk (not a string) so the row label follows a live locale switch
      // without re-registering — the sidebar re-projects it on locale change.
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 100,
        label: () => t("panel.label"),
      }, PanelIcon));
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ api: API }),
      }, MarketPanel));
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
