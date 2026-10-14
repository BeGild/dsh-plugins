/**
 * dsh-skill-market — browser half.
 *
 * The marketplace panel: a sidebar row ("global panel" seat
 * `sidebar.panellist`) whose main-panel cell (`main`, keyed by the same id)
 * shows the two catalogs as a compact card grid. Each card carries the
 * package icon (served by the host from the marketplace zip or the ZCode
 * manifest), and clicking a card opens a detail overlay with the full
 * description, keywords, and usage examples. Install and remove are one click
 * from the card or the overlay; the host half serves the JSON routes behind
 * both, and the `skill_market` model tool drives the same operations.
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

    /** Secondary text size on the app's content scale; keeps the panel in step
     *  with the harness type ramp when the user changes the content font. */
    const SECONDARY = "var(--dsh-content-font-size-secondary, 13px)";

    const zh = {
      "panel.label": "技能市场",
      "panel.title": "技能市场",
      "panel.subtitle": "浏览 ZCode 插件与 WorkBuddy 技能,一键装进当前 DSH。ZCode 插件的技能、斜杠命令、hooks 和 MCP 服务器会一并接入。",
      "tab.zcode": "ZCode 插件",
      "tab.workbuddy": "WorkBuddy 技能",
      "tab.installed": "已安装",
      "menu.userOnly": "仅用户",
      "search.placeholder": "搜索名称或描述…",
      "search.action": "搜索",
      "state.loading": "加载中…",
      "state.empty": "没有匹配的结果",
      "state.unreachable": "读不到市场状态(插件未启用或路由不可达)",
      "action.install": "安装",
      "action.installing": "安装中…",
      "action.remove": "卸载",
      "action.removing": "卸载中…",
      "action.detail": "详情",
      "action.more": "加载更多",
      "action.close": "关闭",
      "badge.installed": "已安装",
      "badge.listedOnly": "仅展示",
      "detail.examples": "用法示例",
      "detail.includes": "包含技能",
      "detail.keywords": "关键词",
      "detail.author": "作者",
      "detail.source": "来源",
      "detail.version": "版本",
      "detail.category": "分类",
      "detail.kind": "类型",
      "kind.plugin": "插件",
      "kind.skill": "技能",
    };

    const en = {
      "panel.label": "Skill market",
      "panel.title": "Skill market",
      "panel.subtitle": "Browse ZCode plugins and WorkBuddy skills and install them into this DSH with one click. A ZCode plugin brings its skills, slash commands, hooks, and MCP servers along.",
      "tab.zcode": "ZCode plugins",
      "tab.workbuddy": "WorkBuddy skills",
      "tab.installed": "Installed",
      "menu.userOnly": "User only",
      "search.placeholder": "Search name or description…",
      "search.action": "Search",
      "state.loading": "Loading…",
      "state.empty": "Nothing matched",
      "state.unreachable": "Market status unavailable (plugin disabled or route missing)",
      "action.install": "Install",
      "action.installing": "Installing…",
      "action.remove": "Remove",
      "action.removing": "Removing…",
      "action.detail": "Details",
      "action.more": "Load more",
      "action.close": "Close",
      "badge.installed": "Installed",
      "badge.listedOnly": "Listed only",
      "detail.examples": "Examples",
      "detail.includes": "Included skills",
      "detail.keywords": "Keywords",
      "detail.author": "Author",
      "detail.source": "Source",
      "detail.version": "Version",
      "detail.category": "Category",
      "detail.kind": "Kind",
      "kind.plugin": "Plugin",
      "kind.skill": "Skill",
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
      async search(source, query, limit) {
        const params = new URLSearchParams({ source });
        if (query) params.set("q", query);
        if (limit) params.set("limit", String(limit));
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
      /** The same-origin icon URL; the host proxies the marketplace's bytes. */
      iconUrl(source, id) {
        return `${BASE}/icon?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
      },
    });

    const S = {
      panel: {
        height: "100%", overflowY: "auto", boxSizing: "border-box", padding: "28px 20px 40px",
        background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit",
        display: "flex", flexDirection: "column", alignItems: "center",
      },
      column: { width: "100%", maxWidth: 920, display: "flex", flexDirection: "column", gap: 14 },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      subtitle: { margin: "6px 0 0", fontSize: SECONDARY, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      tabs: { display: "flex", gap: 6, flexWrap: "wrap" },
      tab: {
        padding: "6px 14px", borderRadius: 999, cursor: "pointer", font: "inherit", fontSize: SECONDARY,
        border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
      },
      tabActive: {
        border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-primary)", fontWeight: 600,
      },
      searchForm: { display: "flex", gap: 8 },
      searchInput: {
        flex: 1, minWidth: 0, padding: "8px 12px", borderRadius: 8, font: "inherit", fontSize: SECONDARY,
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
      },
      button: {
        padding: "6px 14px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: SECONDARY,
        border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
        color: "var(--dsw-alias-label-primary)", flex: "none",
      },
      buttonPrimary: {
        border: "1px solid transparent", background: "var(--dsw-alias-state-accent-primary, var(--dsw-alias-link))",
        color: "var(--dsw-alias-bg-base)",
      },
      buttonBusy: { opacity: 0.6, cursor: "default" },
      grid: {
        display: "grid", gap: 10,
        gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))",
      },
      card: {
        padding: "12px 12px 10px", borderRadius: 12, border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)", display: "flex", flexDirection: "column", gap: 8,
        cursor: "pointer",
      },
      cardHead: { display: "flex", gap: 10, alignItems: "center", minWidth: 0 },
      iconBox: {
        width: 38, height: 38, borderRadius: 9, flex: "none", overflow: "hidden",
        background: "var(--dsw-alias-bg-layer-2)", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-secondary)",
      },
      iconImg: { width: "100%", height: "100%", objectFit: "contain", display: "block" },
      headText: { minWidth: 0, flex: 1 },
      name: { fontSize: SECONDARY, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      meta: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      badge: {
        display: "inline-flex", alignItems: "center", padding: "1px 8px", borderRadius: 999, fontSize: 11,
        background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-tertiary)", flex: "none",
      },
      badgeOn: { color: "var(--dsw-alias-state-success-primary)" },
      desc: {
        fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        minHeight: 36,
      },
      cardFoot: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
      footLink: {
        fontSize: 11, color: "var(--dsw-alias-link)", background: "none", border: "none",
        padding: 0, cursor: "pointer", font: "inherit",
      },
      status: { fontSize: SECONDARY, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      error: { fontSize: SECONDARY, lineHeight: "18px", color: "var(--dsw-alias-state-danger-primary)" },
      overlay: {
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 24, zIndex: 60,
      },
      modal: {
        width: "100%", maxWidth: 560, maxHeight: "82vh", overflowY: "auto", boxSizing: "border-box",
        padding: "20px 22px", borderRadius: 14, border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
      },
      modalHead: { display: "flex", gap: 14, alignItems: "center" },
      modalIcon: {
        width: 52, height: 52, borderRadius: 12, flex: "none", overflow: "hidden",
        background: "var(--dsw-alias-bg-layer-2)", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 22, fontWeight: 600, color: "var(--dsw-alias-label-secondary)",
      },
      modalName: { margin: 0, fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" },
      modalId: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 3, overflowWrap: "anywhere" },
      closeX: {
        marginLeft: "auto", flex: "none", background: "none", border: "none", cursor: "pointer",
        fontSize: 18, lineHeight: 1, color: "var(--dsw-alias-label-tertiary)", padding: 4,
      },
      modalDesc: { fontSize: SECONDARY, lineHeight: "20px", margin: "14px 0 0", color: "var(--dsw-alias-label-secondary)" },
      facts: { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "5px 14px", margin: "14px 0 0", fontSize: SECONDARY },
      factLabel: { color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" },
      factValue: { color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere" },
      chips: { display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 0" },
      chip: {
        padding: "2px 9px", borderRadius: 999, fontSize: 11,
        background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-tertiary)",
      },
      sectionTitle: { margin: "16px 0 0", fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
      example: {
        margin: "6px 0 0", padding: "7px 10px", borderRadius: 8, fontSize: 12, lineHeight: "18px",
        background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)",
      },
      modalFoot: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 },
      iconWrap: { display: "inline-flex", alignItems: "center", justifyContent: "center" },
      skillList: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 },
      skillRow: { display: "flex", alignItems: "center", gap: 7, minWidth: 0 },
      skillIcon: {
        width: 17, height: 17, borderRadius: 5, flex: "none", overflow: "hidden",
        background: "var(--dsw-alias-bg-layer-2)", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 9.5, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)",
      },
      skillName: {
        fontSize: 11.5, color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis",
      },
      skillPkg: { color: "var(--dsw-alias-label-tertiary)" },
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
     * One package icon, served by the host. Falls back to a letter glyph when
     * the catalog carries none or the bytes fail to load.
     * @param {{source: string, id: string, name: string, style: object}} props
     */
    function EntryIcon({ source, id, name, style }) {
      const [failed, setFailed] = React.useState(false);
      const letter = (name || id || "?").trim().charAt(0).toUpperCase() || "?";
      if (failed) return h("div", { style }, letter);
      return h("div", { style },
        h("img", {
          style: S.iconImg,
          src: API.iconUrl(source, id),
          alt: "",
          loading: "lazy",
          onError: () => setFailed(true),
        }),
      );
    }

    /**
     * One `package:skill` row. WorkBuddy skills carry their own icon; skills
     * inside a ZCode plugin use the plugin's icon (the catalog has no
     * per-sub-skill art for them).
     * @param {{entry: object, skill: string}} props
     */
    function SkillRow({ entry, skill }) {
      const iconId = entry.source === "workbuddy-skill" ? skill : entry.id;
      return h("div", { style: S.skillRow },
        h(EntryIcon, { source: entry.source, id: iconId, name: skill, style: S.skillIcon }),
        h("span", { style: S.skillName },
          h("span", { style: S.skillPkg }, `${entry.id}:`),
          skill,
        ),
      );
    }

    /** The sub-skill rows of one installed package, when it has more than one. */
    function SkillRows({ entry }) {
      if (!entry.skills || entry.skills.length < 2) return null;
      return h("div", { style: S.skillList },
        entry.skills.map((skill) => h(SkillRow, { key: skill, entry, skill })),
      );
    }

    /**
     * One grid card: icon, name, meta, clamped description, sub-skill rows,
     * and the action row. Clicking anywhere opens the detail overlay.
     * @param {{t: Function, entry: object, installed: boolean, busy: boolean,
     *          onAction: (kind: 'install'|'remove') => void, onOpen: () => void}} props
     */
    function EntryCard({ t, entry, installed, busy, onAction, onOpen }) {
      const meta = [entry.id, entry.version ? `v${entry.version}` : null].filter(Boolean).join(" · ");
      const kind = installed ? "remove" : "install";
      return h("div", { style: S.card, onClick: onOpen },
        h("div", { style: S.cardHead },
          h(EntryIcon, { source: entry.source, id: entry.id, name: entry.name, style: S.iconBox }),
          h("div", { style: S.headText },
            h("div", { style: S.name }, entry.name || entry.id),
            h("div", { style: S.meta }, meta),
          ),
          installed
            ? h("span", { style: { ...S.badge, ...S.badgeOn } }, t("badge.installed"))
            : entry.installable === false
              ? h("span", { style: S.badge, title: entry.reason || "" }, t("badge.listedOnly"))
              : null,
        ),
        entry.description ? h("div", { style: S.desc }, entry.description) : null,
        h(SkillRows, { entry }),
        h("div", { style: S.cardFoot },
          h("button", {
            type: "button",
            style: S.footLink,
            onClick: (event) => { event.stopPropagation(); onOpen(); },
          }, t("action.detail")),
          entry.installable !== false || installed
            ? h("button", {
                type: "button",
                style: { ...S.button, ...(kind === "install" ? S.buttonPrimary : {}), ...(busy ? S.buttonBusy : {}) },
                disabled: busy,
                onClick: (event) => { event.stopPropagation(); onAction(kind); },
              }, busy ? t(kind === "install" ? "action.installing" : "action.removing") : t(`action.${kind}`))
            : null,
        ),
      );
    }

    /**
     * The detail overlay: everything the catalog carries about one entry —
     * full description, facts, keywords, and usage examples.
     * @param {{t: Function, entry: object, installed: boolean, busy: boolean,
     *          onAction: (kind: 'install'|'remove') => void, onClose: () => void}} props
     */
    function DetailModal({ t, entry, installed, busy, onAction, onClose }) {
      const kind = installed ? "remove" : "install";
      const facts = [
        [t("detail.kind"), t(entry.kind === "plugin" ? "kind.plugin" : "kind.skill")],
        [t("detail.source"), entry.source],
        [t("detail.version"), entry.version || "—"],
        [t("detail.category"), entry.category || "—"],
        [t("detail.author"), entry.author || "—"],
      ];
      return h("div", { style: S.overlay, onClick: onClose },
        h("div", { style: S.modal, onClick: (event) => event.stopPropagation() },
          h("div", { style: S.modalHead },
            h(EntryIcon, { source: entry.source, id: entry.id, name: entry.name, style: S.modalIcon }),
            h("div", { style: { minWidth: 0, flex: 1 } },
              h("h2", { style: S.modalName }, entry.name || entry.id),
              h("div", { style: S.modalId }, entry.id),
            ),
            installed
              ? h("span", { style: { ...S.badge, ...S.badgeOn, flex: "none" } }, t("badge.installed"))
              : null,
            h("button", { type: "button", style: S.closeX, onClick: onClose, "aria-label": t("action.close") }, "✕"),
          ),
          entry.description ? h("p", { style: S.modalDesc }, entry.description) : null,
          entry.reason ? h("p", { style: S.modalDesc }, entry.reason) : null,
          h("div", { style: S.facts },
            facts.filter(([, value]) => value).map(([label, value]) =>
              h(React.Fragment, { key: label },
                h("span", { style: S.factLabel }, label),
                h("span", { style: S.factValue }, value),
              ),
            ),
          ),
          entry.keywords?.length
            ? h(React.Fragment, null,
                h("div", { style: S.sectionTitle }, t("detail.keywords")),
                h("div", { style: S.chips }, entry.keywords.map((keyword) =>
                  h("span", { key: keyword, style: S.chip }, keyword),
                )),
              )
            : null,
          entry.skills?.length
            ? h(React.Fragment, null,
                h("div", { style: S.sectionTitle }, t("detail.includes")),
                h("div", { style: { ...S.skillList, marginTop: 6 } },
                  entry.skills.map((skill) => h(SkillRow, { key: skill, entry, skill })),
                ),
              )
            : null,
          entry.examples?.length
            ? h(React.Fragment, null,
                h("div", { style: S.sectionTitle }, t("detail.examples")),
                entry.examples.map((example, index) =>
                  h("div", { key: index, style: S.example }, example),
                ),
              )
            : null,
          entry.installable !== false || installed
            ? h("div", { style: S.modalFoot },
                h("button", {
                  type: "button",
                  style: { ...S.button, ...(kind === "install" ? S.buttonPrimary : {}), ...(busy ? S.buttonBusy : {}) },
                  disabled: busy,
                  onClick: () => onAction(kind),
                }, busy ? t(kind === "install" ? "action.installing" : "action.removing") : t(`action.${kind}`)),
              )
            : null,
        ),
      );
    }

    /**
     * Main-panel cell: tabs, live search, and the card grid. Rendered only
     * while this panel is selected, so nothing polls once the user goes back
     * to the conversation.
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
      const [selected, setSelected] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
      // Page size for the visible list; 0 = the server's default page. Reset
      // whenever the tab or query changes, grown by the load-more button.
      const [limit, setLimit] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setError("");
        setNote("");
        setEntries(null);
        (async () => {
          try {
            const page = tab === "installed"
              ? await api.installed()
              : await api.search(tab, query.trim(), limit || undefined);
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
      }, [tab, nonce, api, query, limit]);

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
            const result = await api.install(tab === "installed" ? selected?.source : tab, id);
            setNote(result?.message || t("action.install"));
          } else {
            const result = await api.remove(id);
            setNote(result?.message || t("action.remove"));
          }
          setSelected(null);
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
              : h("div", { style: S.grid },
                truncated || total > entries.length
                  ? h("div", { style: { ...S.status, gridColumn: "1 / -1" } }, `${entries.length} / ${total}`)
                  : null,
                entries.map((entry) => h(EntryCard, {
                  key: `${entry.source}/${entry.id}`,
                  t,
                  entry,
                  installed: installedSet.has(entry.id),
                  busy: busy === entry.id,
                  onAction: (kind) => run(kind, entry.id),
                  onOpen: () => setSelected(entry),
                })),
                tab !== "installed" && total > entries.length
                  ? h("button", {
                      key: "load-more",
                      type: "button",
                      style: {
                        ...S.button, ...S.buttonPrimary, ...S.buttonBusy,
                        gridColumn: "1 / -1", cursor: "pointer", opacity: 1,
                      },
                      onClick: () => setLimit((current) => (current || entries.length) + 30),
                    }, `${t("action.more")} · ${entries.length} / ${total}`)
                  : null,
              ),
        ),
        selected
          ? h(DetailModal, {
              t,
              entry: selected,
              installed: installedSet.has(selected.id),
              busy: busy === selected.id,
              onAction: (kind) => run(kind, selected.id),
              onClose: () => setSelected(null),
            })
          : null,
      );
    }

    /** The `[package]` attribution prefix dsh-skill-market installs write. */
    const PACKAGE_PREFIX = /^\[([^\]]+)\]/;

    /** True when every query character appears in name order. */
    function isSubsequence(name, query) {
      if (query.length > name.length) return false;
      let at = 0;
      for (const char of query) {
        at = name.indexOf(char, at);
        if (at < 0) return false;
        at += 1;
      }
      return true;
    }

    /**
     * Wide '/' matcher for installed skills.
     *
     * The stock rankByName matches the NAME only as an ordered subsequence,
     * so `/w` loses every skill whose name lacks a "w" — an entire installed
     * package's worth (close-recap, event-monitor, ...). This matcher also
     * hits the `[package]` attribution and the description text: name-prefix
     * hits rank first, then name subsequence, then package/description
     * substring, ties broken by catalog order.
     * @param {{name: string, description?: string}[]} skills - catalog rows.
     * @param {string} rawQuery - the text typed after the trigger.
     * @returns the matched skills in ranked order; a copy for an empty query.
     */
    function matchSkills(skills, rawQuery) {
      const query = String(rawQuery || "").toLowerCase();
      if (query === "") return [...skills];
      const ranked = [];
      skills.forEach((skill, index) => {
        const name = String(skill.name || "").toLowerCase();
        const description = String(skill.description || "").toLowerCase();
        const pkg = (PACKAGE_PREFIX.exec(description) || [])[1] || "";
        let tier = 0;
        if (name.startsWith(query)) tier = 3;
        else if (isSubsequence(name, query)) tier = 2;
        else if (pkg.includes(query) || description.includes(query)) tier = 1;
        else return;
        ranked.push({ skill, index, tier });
      });
      ranked.sort((a, b) => b.tier - a.tier || a.index - b.index);
      return ranked.map((match) => match.skill);
    }

    /**
     * Browser-side plugin body: dictionaries, the two panel slots, and the
     * '/' skill source. The source replaces the stock one — this bundle's
     * patch disables `ui-skill`, which lands only because this bundle loads
     * after dsh-web-app — so the wide matcher above drives the menu.
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

      // '/' skill source with the wide matcher; mirrors the stock source's
      // protocol (warm, lexicon, subagent suppression, pick text). The view
      // half of dsh-skill-menu keeps rendering rows regardless of source.
      const skillsService = ctx.remote?.skills;
      const sessions = ctx.sessions;
      const inputTriggers = ctx.get("inputTriggers");
      if (skillsService && sessions && inputTriggers) {
        const fetches = new Map();
        const fetchCatalog = (sessionId) => {
          const existing = fetches.get(sessionId);
          if (existing) return existing.promise;
          const entry = { abort: new AbortController() };
          entry.promise = skillsService.list({ sessionId }, entry.abort.signal).then((result) => {
            if (!result.ok) throw new Error(`skills/list failed: ${result.error?.code}`);
            entry.settled = result.value.skills;
            return entry.settled;
          });
          fetches.set(sessionId, entry);
          entry.promise.catch(() => {
            if (fetches.get(sessionId) === entry) fetches.delete(sessionId);
          });
          return entry.promise;
        };
        ctx.effect(() => inputTriggers.registerSource({
          trigger: "/",
          name: "skill",
          order: 2,
          async candidates(session, req) {
            if (sessions.subagentAddress(session.sessionId) !== undefined) return [];
            const skills = await fetchCatalog(session.sessionId);
            if (req.signal.aborted) return [];
            return matchSkills(skills, req.query).map((skill) => ({
              name: skill.name,
              description: skill.modelInvocable === false
                ? `${t("menu.userOnly")} · ${skill.description}`
                : skill.description,
            }));
          },
          warm(session) {
            if (sessions.subagentAddress(session.sessionId) === undefined) {
              fetchCatalog(session.sessionId).catch(() => {});
            }
          },
          lexicon(session) {
            return fetches.get(session.sessionId)?.settled?.map((skill) => skill.name);
          },
          onPick({ candidate }) {
            return { text: `/${candidate.name} ` };
          },
        }), "skill-market: slash source");
      }
    }

    exports.apply = apply;
    exports.matchSkills = matchSkills;
    exports.inject = ["slots", "locale", "remote", "remote.skills", "sessions"];
    return module.exports;
  },
});
