/**
 * dsh-agentos-remote — browser half.
 *
 * Adds the in-client entry point for the WeChat-QR login: a sidebar panel icon
 * ("global panel" seat `sidebar.panellist`) whose matching main-panel cell
 * (`main`, keyed by the same id) renders the QR code and the live link state.
 * Without it the only way in was knowing and typing `/agentos-remote/login`.
 *
 * Plain ES2020, hand-written in the DSH client-bundle format on purpose: this
 * package ships no bundler and no build step, so `lib/client.js` IS the
 * artifact. The format is the lazy-CJS one the browser module system defines —
 * executing this script only REGISTERS a factory; everything else (including
 * the slot registrations) runs when the module is first materialized.
 *
 * Transport: plain same-origin `fetch` against the routes lib/login-ui.js
 * already registers on the DSH web server. The panel is served by that same
 * server, so no RPC/typert layer is needed to reach the host half.
 *
 * Colours come from `--dsw-*` design tokens and every string comes from the
 * `agentos-remote` locale namespace (zh + en), per the client-plugin rules.
 */
window.__ModuleLoader__.load({
  id: "dsh-agentos-remote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Locale namespace; also the `locale` registration option of the panel cell. */
    const NS = "agentos-remote";
    /** Sidebar row id AND the main-panel key it dispatches — the sidebar addresses the panel by this id. */
    const PANEL_ID = "agentos-remote";
    /** Host routes registered by lib/login-ui.js. */
    const LOGIN_BASE = "/agentos-remote/login";
    /** Panel status poll: slow, it only mirrors link health. */
    const STATUS_POLL_MS = 5000;
    /** QR poll: matches the standalone page's cadence (the host poll has a 2s budget). */
    const QR_POLL_MS = 2000;
    /** Sidebar icon poll: slow — this one runs for as long as the app is open. */
    const ICON_POLL_MS = 30000;

    const zh = {
      "panel.label": "WorkBuddy 远控",
      "panel.title": "WorkBuddy 手机远控",
      "panel.subtitle": "微信扫码后,本 DSH 实例即可被手机 WorkBuddy App 远控。凭据自动保存并续期。",
      "panel.loading": "读取状态中…",
      "panel.unreachable": "读不到远控状态(插件未启用或路由不可达)",
      "status.loggedIn": "已登录",
      "status.loggedOut": "未登录",
      "link.waiting-login": "等待登录",
      "link.connecting": "链路连接中",
      "link.subscribed": "链路已连接",
      "link.stopped": "链路已停止",
      "qr.alt": "登录二维码",
      "qr.waiting": "等待扫码…",
      "qr.hint": "微信扫一扫,确认后本实例即以你的账号运行。",
      "qr.ok": "登录成功",
      "qr.expired": "二维码已过期,请刷新。",
      "qr.failed": "初始化失败",
      "action.refresh": "刷新二维码",
      "action.relogin": "重新扫码登录",
      "action.openPage": "在新标签页打开登录页",
      "field.account": "账号",
      "field.device": "设备名",
      "field.workspace": "工作区",
      "value.none": "—",
    };

    const en = {
      "panel.label": "WorkBuddy remote",
      "panel.title": "WorkBuddy mobile remote control",
      "panel.subtitle": "Scan with WeChat and this DSH instance becomes controllable from the WorkBuddy mobile app. Credentials are stored and refreshed automatically.",
      "panel.loading": "Reading status…",
      "panel.unreachable": "Remote-control status unavailable (plugin disabled or route missing)",
      "status.loggedIn": "Signed in",
      "status.loggedOut": "Not signed in",
      "link.waiting-login": "waiting for login",
      "link.connecting": "link connecting",
      "link.subscribed": "link connected",
      "link.stopped": "link stopped",
      "qr.alt": "Login QR code",
      "qr.waiting": "Waiting for the scan…",
      "qr.hint": "Scan with WeChat; once confirmed this instance runs as your account.",
      "qr.ok": "Signed in",
      "qr.expired": "The QR code expired — refresh it.",
      "qr.failed": "Could not start the login",
      "action.refresh": "Refresh QR code",
      "action.relogin": "Sign in again by QR",
      "action.openPage": "Open the login page in a new tab",
      "field.account": "Account",
      "field.device": "Device",
      "field.workspace": "Workspace",
      "value.none": "—",
    };

    /** Link state -> locale key. Anything unrecognised renders no suffix. */
    const LINK_KEYS = {
      "waiting-login": "link.waiting-login",
      connecting: "link.connecting",
      subscribed: "link.subscribed",
      stopped: "link.stopped",
    };

    /**
     * One GET against a plugin route, decoded as JSON.
     * @param {string} path - same-origin path under LOGIN_BASE.
     * @returns {Promise<object>} the decoded body.
     */
    async function getJson(path) {
      const res = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /**
     * The injected business face. Module-level and frozen so its identity is
     * stable across renders — the panel's effects depend on it.
     */
    const API = Object.freeze({
      /** @returns {Promise<object>} the link snapshot, or throws. */
      async status() {
        const body = await getJson(`${LOGIN_BASE}/api/status`);
        if (!body?.ok) throw new Error(body?.error || "status unavailable");
        return body.status;
      },
      /** @returns {Promise<{state: string, authUrl: string, qr: string}>} a fresh auth state + QR data URL. */
      async start() {
        const body = await getJson(`${LOGIN_BASE}/api/start`);
        if (!body?.ok) throw new Error(body?.error || "start failed");
        return body;
      },
      /** @returns {Promise<{status: string, nickname?: string}>} one server-side token check. */
      async poll(state) {
        return getJson(`${LOGIN_BASE}/api/poll?state=${encodeURIComponent(state)}`);
      },
    });

    const S = {
      panel: {
        height: "100%", overflowY: "auto", boxSizing: "border-box", padding: "32px 16px",
        display: "flex", justifyContent: "center", alignItems: "flex-start",
        background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", font: "inherit",
      },
      card: {
        width: "100%", maxWidth: 460, boxSizing: "border-box", padding: "24px 28px",
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14,
        background: "var(--dsw-alias-bg-layer-1)", textAlign: "center",
      },
      title: { margin: "0 0 6px", fontSize: 17, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      subtitle: { margin: "0 0 16px", fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      pill: {
        display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px",
        borderRadius: 999, fontSize: 12, background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-secondary)",
      },
      dot: { width: 7, height: 7, borderRadius: "50%", flex: "none" },
      facts: {
        display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "6px 12px",
        margin: "16px 0 0", textAlign: "left", fontSize: 12.5,
      },
      factLabel: { color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" },
      factValue: { color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere" },
      qrWrap: { marginTop: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
      qr: { width: 224, height: 224, borderRadius: 10, display: "block" },
      qrPlaceholder: {
        width: 224, height: 224, display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-tertiary)", fontSize: 13,
      },
      status: { fontSize: 13, color: "var(--dsw-alias-label-secondary)", minHeight: 20 },
      hint: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)", maxWidth: 300 },
      link: { fontSize: 12, color: "var(--dsw-alias-link)", overflowWrap: "anywhere" },
      button: {
        marginTop: 10, padding: "7px 16px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 13,
        border: "1px solid var(--dsw-alias-border-l2)", background: "transparent",
        color: "var(--dsw-alias-label-primary)",
      },
      iconWrap: { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center" },
      iconDot: {
        position: "absolute", top: -1, right: -1, width: 7, height: 7, borderRadius: "50%",
        background: "var(--dsw-alias-state-warn-primary)",
      },
    };

    /**
     * Status pill: a coloured dot plus the composed state text.
     * @param {{text: string, tone: 'ok'|'warn'|'muted'}} props
     */
    function Pill({ text, tone }) {
      const color = tone === "ok"
        ? "var(--dsw-alias-state-success-primary)"
        : tone === "warn"
          ? "var(--dsw-alias-state-warn-primary)"
          : "var(--dsw-alias-label-tertiary)";
      return h("span", { style: S.pill },
        h("span", { style: { ...S.dot, background: color } }),
        h("span", null, text),
      );
    }

    /** One label/value pair of the panel's fact table. */
    function FactRow({ label, value }) {
      return h(React.Fragment, null,
        h("span", { style: S.factLabel }, label),
        h("span", { style: S.factValue }, value),
      );
    }

    /** Smartphone glyph — the device the app drives. Sized by the sidebar's owner props. */
    function PhoneGlyph({ size }) {
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true", focusable: "false",
      },
        h("rect", { x: 6, y: 2.5, width: 12, height: 19, rx: 3 }),
        h("path", { d: "M10.5 5.5h3" }),
        h("path", { d: "M9.5 17.5h5" }),
      );
    }

    /**
     * Sidebar row: the glyph plus a warning dot while this instance has no
     * credentials. The row is always mounted, so it polls slowly; a failed
     * probe (plugin disabled, route missing) simply shows no dot.
     * @param {{size: number, active: boolean}} props - owner props from the sidebar shell.
     */
    function PanelIcon({ size, active }) {
      const [loggedIn, setLoggedIn] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const next = await API.status();
            if (alive) setLoggedIn(next?.loggedIn === true);
          } catch {
            if (alive) setLoggedIn(null);
          }
        };
        tick();
        const timer = setInterval(tick, ICON_POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      return h("span", {
        style: {
          ...S.iconWrap,
          color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
        },
      },
        h(PhoneGlyph, { size }),
        loggedIn === false && h("span", { style: S.iconDot }),
      );
    }

    /**
     * The QR body: waiting / done / expired, with the manual fallbacks
     * (refresh, and the server-issued authUrl for a device that cannot scan).
     */
    function QrBlock({ t, qr, phase, detail, onRefresh }) {
      if (phase === "ok") {
        return h("div", { style: S.qrWrap },
          h("div", { style: { fontSize: 44, lineHeight: "52px", color: "var(--dsw-alias-state-success-primary)" } }, "✓"),
          h("div", { style: S.status }, detail ? `${t("qr.ok")}: ${detail}` : t("qr.ok")),
        );
      }
      if (phase === "expired" || phase === "failed") {
        return h("div", { style: S.qrWrap },
          h("div", { style: S.status }, phase === "expired" ? t("qr.expired") : `${t("qr.failed")}: ${detail}`),
          h("button", { style: S.button, onClick: onRefresh }, t("action.refresh")),
        );
      }
      return h("div", { style: S.qrWrap },
        qr
          ? h("img", { style: S.qr, src: qr.image, width: 224, height: 224, alt: t("qr.alt") })
          : h("div", { style: S.qrPlaceholder }, t("panel.loading")),
        h("div", { style: S.status }, t("qr.waiting")),
        h("div", { style: S.hint }, t("qr.hint")),
        qr && h("a", { style: S.link, href: qr.authUrl, target: "_blank", rel: "noreferrer" }, t("action.openPage")),
        h("button", { style: S.button, onClick: onRefresh }, t("action.refresh")),
      );
    }

    /**
     * Main-panel cell: live link state, the identity in force, and the QR flow
     * while this instance has no credentials (or the user asked to re-scan).
     * Rendered only while this panel is the selected one, so polling stops
     * when the user goes back to the conversation.
     * @param {{t: Function, api: typeof API}} props - locale seat + injected face.
     */
    function LoginPanel({ t, api }) {
      const [status, setStatus] = React.useState(null);
      const [unreachable, setUnreachable] = React.useState(false);
      const [generation, setGeneration] = React.useState(0);
      const [forceQr, setForceQr] = React.useState(false);
      const [qr, setQr] = React.useState(null);
      const [phase, setPhase] = React.useState("waiting");
      const [detail, setDetail] = React.useState("");

      const refreshStatus = React.useCallback(async () => {
        try {
          setStatus(await api.status());
          setUnreachable(false);
        } catch {
          setUnreachable(true);
        }
      }, [api]);

      React.useEffect(() => {
        refreshStatus();
        const timer = setInterval(refreshStatus, STATUS_POLL_MS);
        return () => clearInterval(timer);
      }, [refreshStatus]);

      const loggedIn = status?.loggedIn === true;
      const showQr = forceQr || (status !== null && !loggedIn);

      React.useEffect(() => {
        if (!showQr) return undefined;
        let cancelled = false;
        let timer = null;
        let state = null;
        const poll = async () => {
          if (cancelled || state === null) return;
          try {
            const result = await api.poll(state);
            if (cancelled) return;
            if (result.status === "ok") {
              clearInterval(timer);
              timer = null;
              setPhase("ok");
              setDetail(result.nickname || "");
              setQr(null);
              refreshStatus();
            } else if (result.status === "expired") {
              clearInterval(timer);
              timer = null;
              setPhase("expired");
            }
          } catch {
            // Transient poll failure: keep the loop, the host retries per request.
          }
        };
        (async () => {
          try {
            setPhase("waiting");
            setDetail("");
            const started = await api.start();
            if (cancelled) return;
            state = started.state;
            setQr({ image: started.qr, authUrl: started.authUrl });
            timer = setInterval(poll, QR_POLL_MS);
          } catch (error) {
            if (!cancelled) {
              setPhase("failed");
              setDetail(error.message);
            }
          }
        })();
        return () => {
          cancelled = true;
          if (timer) clearInterval(timer);
        };
      }, [showQr, generation, api, refreshStatus]);

      const linkKey = status?.link ? LINK_KEYS[status.link] : undefined;
      const stateText = unreachable
        ? t("panel.unreachable")
        : status === null
          ? t("panel.loading")
          : linkKey
            ? `${t(loggedIn ? "status.loggedIn" : "status.loggedOut")} · ${t(linkKey)}`
            : t(loggedIn ? "status.loggedIn" : "status.loggedOut");

      return h("div", { style: S.panel },
        h("div", { style: S.card },
          h("h1", { style: S.title }, t("panel.title")),
          h("p", { style: S.subtitle }, t("panel.subtitle")),
          h(Pill, {
            text: stateText,
            tone: unreachable ? "warn" : status === null ? "muted" : loggedIn ? "ok" : "warn",
          }),
          status && h("div", { style: S.facts },
            h(FactRow, { label: t("field.account"), value: status.nickname || status.uid || t("value.none") }),
            h(FactRow, { label: t("field.device"), value: status.device || t("value.none") }),
            h(FactRow, { label: t("field.workspace"), value: status.workspace || t("value.none") }),
          ),
          showQr
            ? h(QrBlock, {
              t, qr, phase, detail,
              onRefresh: () => setGeneration((n) => n + 1),
            })
            : null,
          !showQr && loggedIn
            ? h("button", { style: S.button, onClick: () => setForceQr(true) }, t("action.relogin"))
            : null,
        ),
      );
    }

    /**
     * Browser-side plugin body: dictionaries, then the two slots that make the
     * entry reachable — the sidebar row and the main cell it dispatches.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "agentos-remote: dictionaries");
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
      }, LoginPanel));
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
