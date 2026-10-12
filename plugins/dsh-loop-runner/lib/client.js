/**
 * dsh-loop-runner — browser half: the "定时任务" panel.
 *
 * One official seat pair, exactly like dsh-agentos-remote's client: a
 * `sidebar.panellist` row dispatches to a `main` cell (keyed by the same id).
 * The cell receives `{t, api}` — the locale seat and the injected face — and
 * polls the host routes with plain same-origin fetch. Rendering only happens
 * while the panel is selected, so polling stops when the user leaves.
 *
 * Plain ES2020, hand-written in the DSH client-bundle format on purpose: this
 * package ships no bundler and no build step, so `lib/client.js` IS the
 * artifact (lazy-CJS closure registered on window.__ModuleLoader__).
 *
 * Rules honored: components never touch ctx; every string comes from the
 * loop-runner locale namespace (zh + en); every colour is a --dsw-alias-*
 * semantic token, so theme packs (e.g. dsh-zcode-theme) restyle the panel
 * for free.
 */
window.__ModuleLoader__.load({
  id: "dsh-loop-runner",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Locale namespace; also the `locale` registration option of the panel cell. */
    const NS = "loop-runner";
    /** Sidebar row id AND the main-panel key it dispatches to. */
    const PANEL_ID = "loop-runner";
    /** Host routes (lib/host/routes.js). */
    const API_BASE = "/api/dsh-loop-runner";
    /** Fallback poll cadence; the host's /health carries the configured one. */
    const POLL_MS = 5000;

    const zh = {
      "panel.label": "定时任务",
      "panel.title": "定时任务",
      "health.off": "引擎未运行",
      "health.on": "引擎运行中",
      "health.jobs": "任务",
      "health.pending": "待处理",
      "health.unreachable": "面板路由不可达（插件未启用？）",
      "tab.watch": "巡检场景",
      "tab.agent": "Agent 任务",
      "tab.history": "升级历史",
      "action.pause": "暂停",
      "action.resume": "恢复",
      "action.run": "立即执行",
      "action.runAgent": "立即运行",
      "action.requeue": "重排",
      "action.detail": "详情",
      "action.close": "关闭",
      "action.refresh": "刷新",
      "action.copy": "复制示例",
      "action.copied": "已复制",
      "action.new": "新建",
      "state.registered": "已注册",
      "state.idle": "空闲",
      "state.failed": "失败",
      "state.paused": "已暂停",
      "state.done": "已完成",
      "state.noNext": "不再运行",
      "queue.pending": "待",
      "queue.inflight": "处理中",
      "queue.consumed": "已消费",
      "queue.dead": "死信",
      "detail.executions": "执行历史",
      "detail.events": "事件队列",
      "detail.escalations": "升级记录",
      "detail.empty": "暂无记录",
      "detail.attempts": "次尝试",
      "detail.nextAttempt": "下次重试",
      "field.schedule": "计划",
      "field.last": "最近",
      "field.session": "会话",
      "field.candidates": "新候选",
      "history.empty": "还没有升级记录",
      "history.preview": "结果预览",
      "new.title": "新建定时任务",
      "new.hint": "两种任务都建议直接在对话里让 agent 创建（loop 工具会写好适配器并建基线）。把下面这段发给任意会话即可：",
      "new.example": "帮我建一个巡检任务：每 10 分钟检查一次 XX，只有出现 XX 情况才告诉我（用 watch 任务 + 适配器脚本，不要轮询消耗 token）。",
      "schedule.interval": (s) => s % 86400 === 0 ? `每 ${s / 86400} 天` : s % 3600 === 0 ? `每 ${s / 3600} 小时` : s % 60 === 0 ? `每 ${s / 60} 分钟` : `每 ${s} 秒`,
      "schedule.once": () => "一次性",
      "time.never": "—",
      "badge.event": "事件",
      "badge.schedule": "定时",
      "badge.manual": "手动",
      "outcome.succeeded": "成功",
      "outcome.failed": "失败",
      "outcome.running": "运行中",
    };

    const en = {
      "panel.label": "Scheduled jobs",
      "panel.title": "Scheduled jobs",
      "health.off": "engine stopped",
      "health.on": "engine running",
      "health.jobs": "jobs",
      "health.pending": "pending",
      "health.unreachable": "panel routes unreachable (plugin disabled?)",
      "tab.watch": "Watchers",
      "tab.agent": "Agent jobs",
      "tab.history": "Escalations",
      "action.pause": "Pause",
      "action.resume": "Resume",
      "action.run": "Poll now",
      "action.runAgent": "Run now",
      "action.requeue": "Requeue",
      "action.detail": "Detail",
      "action.close": "Close",
      "action.refresh": "Refresh",
      "action.copy": "Copy example",
      "action.copied": "Copied",
      "action.new": "New",
      "state.registered": "registered",
      "state.idle": "idle",
      "state.failed": "failed",
      "state.paused": "paused",
      "state.done": "done",
      "state.noNext": "no next run",
      "queue.pending": "pending",
      "queue.inflight": "in-flight",
      "queue.consumed": "consumed",
      "queue.dead": "dead",
      "detail.executions": "Executions",
      "detail.events": "Event queue",
      "detail.escalations": "Escalations",
      "detail.empty": "nothing yet",
      "detail.attempts": "attempts",
      "detail.nextAttempt": "retry at",
      "field.schedule": "schedule",
      "field.last": "last",
      "field.session": "session",
      "field.candidates": "new",
      "history.empty": "no escalations yet",
      "history.preview": "result preview",
      "new.title": "New scheduled job",
      "new.hint": "Both kinds are best created conversationally — the agent writes the adapter and baselines it via the loop tools. Send this to any session:",
      "new.example": "Create a watcher job for me: check XX every 10 minutes and only tell me when XX happens (watch job + adapter script, no token-burning polling).",
      "schedule.interval": (s) => s % 86400 === 0 ? `every ${s / 86400}d` : s % 3600 === 0 ? `every ${s / 3600}h` : s % 60 === 0 ? `every ${s / 60}min` : `every ${s}s`,
      "schedule.once": () => "once",
      "time.never": "—",
      "badge.event": "event",
      "badge.schedule": "sched",
      "badge.manual": "manual",
      "outcome.succeeded": "succeeded",
      "outcome.failed": "failed",
      "outcome.running": "running",
    };

    /** Same-origin API face injected into the panel cell. */
    const API = {
      async health() { return await fetchJson(`${API_BASE}/health`); },
      async overview() { return await fetchJson(`${API_BASE}/overview`); },
      async job(id, limit = 20) { return await fetchJson(`${API_BASE}/job?id=${encodeURIComponent(id)}&limit=${limit}`); },
      async escalations(limit = 50) { return await fetchJson(`${API_BASE}/escalations?limit=${limit}`); },
      async action(id, op, body = {}) {
        return await fetchJson(`${API_BASE}/job/${op}?id=${encodeURIComponent(id)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      },
    };

    async function fetchJson(url, init) {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
      return body;
    }

    const S = {
      page: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, color: "var(--dsw-alias-label-primary)", font: "inherit" },
      header: { display: "flex", alignItems: "center", gap: 10, padding: "14px 18px 10px", flexWrap: "wrap" },
      headerTitle: { fontSize: 16, fontWeight: 600, margin: 0 },
      health: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      dot: (color) => ({ width: 8, height: 8, borderRadius: "50%", background: color, flex: "0 0 auto" }),
      spacer: { flex: 1 },
      button: {
        border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)",
        borderRadius: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer", font: "inherit",
      },
      buttonPrimary: {
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)",
        color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer", font: "inherit",
      },
      tabs: { display: "flex", gap: 4, padding: "0 18px", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      tab: (active) => ({
        border: "none", background: "transparent", cursor: "pointer", font: "inherit", fontSize: 13,
        color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
        borderBottom: active ? "2px solid var(--dsw-alias-accent-primary)" : "2px solid transparent",
        padding: "8px 10px",
      }),
      list: { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 18px", display: "flex", flexDirection: "column", gap: 10 },
      card: {
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)",
        padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8,
      },
      cardHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      cardTitle: { fontSize: 14, fontWeight: 600, margin: 0, overflowWrap: "anywhere" },
      badge: (tone) => ({
        fontSize: 11, borderRadius: 999, padding: "1px 8px", flex: "0 0 auto",
        background: "var(--dsw-alias-bg-layer-2)", color: tone,
      }),
      meta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: "18px", overflowWrap: "anywhere" },
      chips: { display: "flex", gap: 6, flexWrap: "wrap" },
      chip: { fontSize: 11, borderRadius: 6, padding: "1px 7px", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
      actions: { display: "flex", gap: 6, flexWrap: "wrap" },
      drawer: {
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)",
        padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10,
      },
      sectionTitle: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary)", margin: 0 },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
      cell: { padding: "3px 8px 3px 0", color: "var(--dsw-alias-label-secondary)", textAlign: "left", verticalAlign: "top" },
      empty: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      modalMask: {
        position: "fixed", inset: 0, background: "var(--dsw-alias-bg-overlay)", display: "flex", alignItems: "center",
        justifyContent: "center", zIndex: 1000,
      },
      modal: {
        width: "min(520px, 90vw)", borderRadius: 14, border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-base)", padding: 18, display: "flex", flexDirection: "column", gap: 10,
      },
      example: {
        borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)",
        padding: "10px 12px", fontSize: 13, lineHeight: "20px", overflowWrap: "anywhere",
      },
      iconWrap: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16 },
      iconDot: {
        position: "absolute", width: 6, height: 6, borderRadius: "50%", background: "var(--dsw-alias-accent-primary)",
        transform: "translate(10px, -4px)",
      },
    };

    const TONE = {
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warning-primary)",
      bad: "var(--dsw-alias-state-danger-primary)",
      mute: "var(--dsw-alias-label-tertiary)",
      accent: "var(--dsw-alias-accent-primary)",
    };

    function fmtTime(ts) {
      if (!ts) return null;
      try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
    }

    function scheduleText(t, schedule) {
      if (!schedule) return "";
      if (schedule.kind === "interval") return t("schedule.interval")(schedule.intervalSeconds);
      if (schedule.kind === "cron") return `cron ${schedule.cron}`;
      return t("schedule.once")();
    }

    function stateOf(job) {
      if (job.paused) return { key: "state.paused", tone: TONE.warn };
      if (job.done || job.nextRunAt == null) return { key: "state.noNext", tone: TONE.mute };
      if (job.lastStatus === "failed") return { key: "state.failed", tone: TONE.bad };
      if (job.lastStatus === "idle") return { key: "state.idle", tone: TONE.ok };
      return { key: "state.registered", tone: TONE.mute };
    }

    /** Sidebar icon: clock glyph with a pending-events dot. */
    function PanelIcon({ t, api }) {
      const [pending, setPending] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const health = await api.health();
            if (alive && (health?.queue?.pending ?? 0) > 0) setPending(true);
            else if (alive) setPending(false);
          } catch { /* host down: no dot */ }
        };
        tick();
        const timer = setInterval(tick, 30000);
        return () => { alive = false; clearInterval(timer); };
      }, [api]);
      return h("span", { style: { ...S.iconWrap, position: "relative" } },
        h(ClockGlyph),
        pending === true && h("span", { style: S.iconDot, "aria-label": t("queue.pending") }),
      );
    }

    function ClockGlyph() {
      return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("circle", { cx: 8, cy: 8, r: 6.4, stroke: "currentColor", strokeWidth: 1.4 }),
        h("path", { d: "M8 4.8V8l2.2 1.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
      );
    }

    /** Main-panel cell. */
    function LoopPanel({ t, api }) {
      const [health, setHealth] = React.useState(null);
      const [overview, setOverview] = React.useState(null);
      const [unreachable, setUnreachable] = React.useState(false);
      const [tab, setTab] = React.useState("watch");
      const [detailId, setDetailId] = React.useState(null);
      const [showNew, setShowNew] = React.useState(false);
      const pollMs = health?.uiPollMs || POLL_MS;

      const refresh = React.useCallback(async () => {
        try {
          const [nextHealth, nextOverview] = await Promise.all([api.health(), api.overview()]);
          setHealth(nextHealth);
          setOverview(nextOverview);
          setUnreachable(false);
        } catch {
          setUnreachable(true);
        }
      }, [api]);

      React.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, pollMs);
        return () => clearInterval(timer);
      }, [refresh, pollMs]);

      const jobs = overview?.jobs ?? [];
      const watchJobs = jobs.filter((job) => job.kind === "watch");
      const agentJobs = jobs.filter((job) => job.kind === "agent");
      const shown = tab === "watch" ? watchJobs : agentJobs;
      const pendingTotal = health?.queue?.pending ?? 0;

      const runAction = async (id, op) => {
        try { await api.action(id, op); } catch { /* surfaced by the next poll */ }
        refresh();
      };

      return h("div", { style: S.page },
        h("div", { style: S.header },
          h("h2", { style: S.headerTitle }, t("panel.title")),
          h("span", { style: S.health },
            h("span", { style: S.dot(health ? TONE.ok : TONE.bad) }),
            unreachable ? t("health.unreachable") : `${t("health.on")} · ${jobs.length} ${t("health.jobs")} · ${pendingTotal} ${t("health.pending")}`,
          ),
          h("span", { style: S.spacer }),
          h("button", { type: "button", style: S.button, onClick: refresh }, t("action.refresh")),
          h("button", { type: "button", style: S.buttonPrimary, onClick: () => setShowNew(true) }, `＋ ${t("action.new")}`),
        ),
        h("div", { style: S.tabs },
          h("button", { type: "button", style: S.tab(tab === "watch"), onClick: () => setTab("watch") }, `${t("tab.watch")} ${watchJobs.length}`),
          h("button", { type: "button", style: S.tab(tab === "agent"), onClick: () => setTab("agent") }, `${t("tab.agent")} ${agentJobs.length}`),
          h("button", { type: "button", style: S.tab(tab === "history"), onClick: () => setTab("history") }, t("tab.history")),
        ),
        h("div", { style: S.list },
          tab === "history"
            ? h(HistoryTab, { t, api })
            : shown.length === 0
              ? h("div", { style: S.empty }, tab === "watch" ? t("detail.empty") : t("detail.empty"))
              : shown.map((job) => h(JobCard, {
                key: job.id, t, job,
                onAction: runAction,
                onDetail: () => setDetailId(detailId === job.id ? null : job.id),
                expanded: detailId === job.id,
              })),
          detailId && tab !== "history" && h(DetailPanel, { key: detailId, t, api, jobId: detailId }),
        ),
        showNew && h(NewJobModal, { t, onClose: () => setShowNew(false) }),
      );
    }

    function JobCard({ t, job, onAction, onDetail, expanded }) {
      const state = stateOf(job);
      const counts = job.queue ?? {};
      const last = job.lastExecution;
      return h("div", { style: S.card },
        h("div", { style: S.cardHead },
          h("span", { style: S.dot(state.tone), title: t(state.key) }),
          h("h3", { style: S.cardTitle }, job.title),
          h("span", { style: S.badge(state.tone) }, t(state.key)),
          h("span", { style: S.spacer }),
          h("span", { style: S.meta }, `${t("field.schedule")}: ${scheduleText(t, job.schedule)}`),
        ),
        job.kind === "watch" && h("div", { style: S.chips },
          h("span", { style: S.chip }, `${t("queue.pending")} ${counts.pending ?? 0}`),
          h("span", { style: S.chip }, `${t("queue.inflight")} ${counts["in-flight"] ?? 0}`),
          h("span", { style: S.chip }, `${t("queue.consumed")} ${counts.consumed ?? 0}`),
          (counts.dead ?? 0) > 0 && h("span", { style: { ...S.chip, color: TONE.bad } }, `${t("queue.dead")} ${counts.dead}`),
        ),
        h("div", { style: S.meta },
          (job.nextRunAt ? `→ ${fmtTime(job.nextRunAt)}` : t("state.noNext"))
          + (last ? ` · ${t("field.last")}: ${last.status === "success" ? "✓" : "✗"} ${fmtTime(last.startedAt)}` : ""),
          job.lastError ? ` · ${job.lastError}` : "",
        ),
        h("div", { style: S.actions },
          job.paused
            ? h("button", { type: "button", style: S.button, onClick: () => onAction(job.id, "resume") }, t("action.resume"))
            : h("button", { type: "button", style: S.button, onClick: () => onAction(job.id, "pause") }, t("action.pause")),
          h("button", {
            type: "button", style: S.button,
            onClick: () => onAction(job.id, "run"),
          }, job.kind === "watch" ? t("action.run") : t("action.runAgent")),
          job.kind === "watch" && (counts.dead ?? 0) + (counts.pending ?? 0) > 0 && h("button", {
            type: "button", style: S.button, onClick: () => onAction(job.id, "requeue"),
          }, t("action.requeue")),
          h("button", { type: "button", style: S.button, onClick: onDetail }, expanded ? t("action.close") : t("action.detail")),
        ),
      );
    }

    function DetailPanel({ t, api, jobId }) {
      const [data, setData] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try { const next = await api.job(jobId); if (alive) setData(next); } catch { /* next poll */ }
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [api, jobId]);
      if (!data) return h("div", { style: S.drawer }, h("div", { style: S.empty }, t("detail.empty")));
      return h("div", { style: S.drawer },
        h("div", null,
          h("h4", { style: S.sectionTitle }, t("detail.executions")),
          data.executions.length === 0
            ? h("div", { style: S.empty }, t("detail.empty"))
            : h("table", { style: S.table }, data.executions.slice(0, 8).map((row) => h("tr", { key: row.runId },
              h("td", { style: S.cell }, fmtTime(row.startedAt)),
              h("td", { style: { ...S.cell, color: row.status === "success" ? TONE.ok : row.status === "failed" ? TONE.bad : TONE.mute } }, row.status),
              h("td", { style: S.cell }, row.newCandidates ? `+${row.newCandidates}` : ""),
              h("td", { style: S.cell }, row.error ? row.error.slice(0, 120) : ""),
            ))),
        ),
        h("div", null,
          h("h4", { style: S.sectionTitle }, t("detail.events")),
          data.events.length === 0
            ? h("div", { style: S.empty }, t("detail.empty"))
            : h("table", { style: S.table }, data.events.slice(0, 8).map((row) => h("tr", { key: row.eventId },
              h("td", { style: S.cell }, fmtTime(row.createdAt)),
              h("td", { style: { ...S.cell, color: row.status === "dead" ? TONE.bad : TONE.mute } }, row.status),
              h("td", { style: S.cell }, row.attempts ? `${row.attempts} ${t("detail.attempts")}` : ""),
              h("td", { style: S.cell }, row.lastError ? row.lastError.slice(0, 120) : ""),
            ))),
        ),
        h("div", null,
          h("h4", { style: S.sectionTitle }, t("detail.escalations")),
          data.escalations.length === 0
            ? h("div", { style: S.empty }, t("detail.empty"))
            : h("table", { style: S.table }, data.escalations.slice(0, 8).map((row) => h("tr", { key: row.escalationId },
              h("td", { style: S.cell }, fmtTime(row.startedAt)),
              h("td", { style: { ...S.cell, color: row.outcome === "succeeded" ? TONE.ok : row.outcome === "failed" ? TONE.bad : TONE.accent } }, t(`outcome.${row.outcome}`) || row.outcome),
              h("td", { style: S.cell, title: row.sessionId || "" }, row.sessionId ? `${t("field.session")}: ${String(row.sessionId).slice(0, 18)}…` : ""),
              h("td", { style: S.cell }, row.error ? row.error.slice(0, 120) : ""),
            ))),
        ),
      );
    }

    function HistoryTab({ t, api }) {
      const [rows, setRows] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try { const next = await api.escalations(50); if (alive) setRows(next.escalations ?? []); } catch { /* next poll */ }
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [api]);
      if (rows === null) return h("div", { style: S.empty }, t("detail.empty"));
      if (rows.length === 0) return h("div", { style: S.empty }, t("history.empty"));
      return h(React.Fragment, null, rows.map((row) => h("div", { key: row.escalationId, style: S.card },
        h("div", { style: S.cardHead },
          h("span", { style: S.badge(TONE.accent) }, t(`badge.${row.trigger}`) || row.trigger),
          h("span", { style: S.cardTitle }, row.jobId),
          h("span", {
            style: S.badge(row.outcome === "succeeded" ? TONE.ok : row.outcome === "failed" ? TONE.bad : TONE.accent),
          }, t(`outcome.${row.outcome}`) || row.outcome),
          h("span", { style: S.spacer }),
          h("span", { style: S.meta }, fmtTime(row.startedAt)),
        ),
        row.sessionId && h("div", { style: S.meta }, `${t("field.session")}: ${row.sessionId}`),
        row.error && h("div", { style: { ...S.meta, color: TONE.bad } }, row.error),
        row.textPreview && h("div", { style: S.example, title: t("history.preview") }, row.textPreview),
      )));
    }

    function NewJobModal({ t, onClose }) {
      const [copied, setCopied] = React.useState(false);
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(t("new.example"));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable */ }
      };
      return h("div", { style: S.modalMask, onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h("div", { style: S.modal },
          h("h3", { style: S.headerTitle }, t("new.title")),
          h("div", { style: S.meta }, t("new.hint")),
          h("div", { style: S.example }, t("new.example")),
          h("div", { style: S.actions },
            h("button", { type: "button", style: S.button, onClick: copy }, copied ? t("action.copied") : t("action.copy")),
            h("span", { style: S.spacer }),
            h("button", { type: "button", style: S.buttonPrimary, onClick: onClose }, t("action.close")),
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
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "loop-runner: dictionaries");
      const t = ctx.locale.bind(NS);
      // Thunk labels follow live locale switches without re-registering.
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
      }, LoopPanel));
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
