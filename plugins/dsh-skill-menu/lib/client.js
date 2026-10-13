/**
 * dsh-skill-menu — browser half.
 *
 * Registers the '/' trigger source named "skill" (the name the disabled
 * stock ui-skill row used, so pick and lexicon semantics stay identical) with
 * one addition the stock candidates did not carry:
 *
 *   - `section` — skills whose description starts with a "[package]"
 *     attribution (the prefix dsh-skill-market writes when a multi-skill
 *     package installs) are grouped under their package; everything else
 *     lands in one local section. The menu renders section headers itself,
 *     and the attribution prefix is stripped from the description since the
 *     header now carries it.
 *
 * It also re-owns the `skill` tool conversation row the stock row provided:
 * a compact disclosure with the skill name, running/error state, and the
 * loaded instructions.
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

    /** Locale namespace; also the `locale` option of the tool-row slot. */
    const NS = "skill-menu";
    /** The attribution prefix dsh-skill-market writes into sub-skills. */
    const PACKAGE_PREFIX = /^\[([^\]]+)\]\s*/;

    const zh = {
      "menu.userOnly": "仅用户",
      "section.local": "本地技能",
      "row.title": "Skill",
      "row.running": "正在加载 skill",
      "row.failed": "skill 加载失败",
      "row.stopped": "skill 加载已中止",
      "row.instructions": "说明",
      "row.inspect": "查看",
    };

    const en = {
      "menu.userOnly": "User only",
      "section.local": "Local skills",
      "row.title": "Skill",
      "row.running": "Loading skill",
      "row.failed": "skill failed to load",
      "row.stopped": "skill loading stopped",
      "row.instructions": "Instructions",
      "row.inspect": "Inspect",
    };

    /** First physical line, for collapsed summaries. */
    function firstLine(text) {
      const newline = text.indexOf("\n");
      return newline === -1 ? text : text.slice(0, newline);
    }

    /** Skill names are the only call argument the compact row presents. */
    function skillName(argsRaw, callId) {
      try {
        const parsed = JSON.parse(argsRaw);
        if (typeof parsed === "object" && parsed !== null) {
          const name = parsed.name;
          if (typeof name === "string" && name !== "") return firstLine(name);
        }
      } catch { /* fall through to the raw text */ }
      return argsRaw === "" ? callId : firstLine(argsRaw);
    }

    /** Flatten durable result blocks to text, aligned with ui-tool's contract. */
    function resultText(block) {
      if (!("kind" in block)) return null;
      const parts = [];
      for (const item of block.content) {
        parts.push(item.type === "text" ? item.text : JSON.stringify(item, null, 2));
      }
      if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
      return parts.join("\n") || null;
    }

    /** Display state without consulting the live skill catalog. */
    function skillRowModel(block) {
      const settled = "kind" in block;
      const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
      const state = !settled ? "running" : block.error?.code === "interrupted" ? "stopped" : block.isError ? "error" : "ok";
      const output = resultText(block);
      return {
        name: skillName(argsRaw, block.callId),
        output,
        errorSummary: state === "error" && output !== null ? firstLine(output) : null,
        state,
      };
    }

    const S = {
      card: { display: "flex", flexDirection: "column", minWidth: 0 },
      row: { display: "flex", alignItems: "center", minHeight: 22, gap: 6, minWidth: 0 },
      leading: {
        width: 16, height: 16, flex: "none", display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        color: "var(--dsw-alias-label-tertiary)",
      },
      title: {
        color: "var(--dsw-alias-label-secondary)", flex: "none",
        fontSize: "var(--dsh-content-font-size-secondary, 13px)", lineHeight: "22px",
      },
      separator: {
        width: 2, height: 2, borderRadius: 1, flex: "none", margin: "0 6px",
        background: "var(--dsw-alias-label-caption)",
      },
      summary: {
        color: "var(--dsw-alias-label-tertiary)", minWidth: 0, flex: 1,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        fontSize: "var(--dsh-content-font-size-secondary, 13px)", lineHeight: "22px",
      },
      summaryError: { color: "var(--dsw-alias-state-error-primary)" },
      body: { margin: "4px 0 4px 4px", display: "flex", flexDirection: "column", gap: 4 },
      instructions: {
        margin: 0, padding: "10px 12px", borderRadius: 10,
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-markdown-code-block)", whiteSpace: "pre-wrap",
        overflowWrap: "anywhere", maxHeight: 240, overflowY: "auto",
        font: "var(--dsw-font-markdown-code-block-small)",
        color: "var(--dsw-alias-label-secondary)",
      },
      instructionsError: { color: "var(--dsw-alias-state-error-primary)" },
      visuallyHidden: {
        clip: "rect(0 0 0 0)", whiteSpace: "nowrap", width: 1, height: 1,
        position: "absolute", overflow: "hidden",
      },
    };

    /**
     * The `skill` tool conversation row: state icon, the fixed title, the
     * skill name, and an expandable disclosure of the loaded instructions.
     * @param {{block: object, inspect?: Function, t: Function}} props
     */
    function SkillRow({ block, inspect, t }) {
      const model = skillRowModel(block);
      const [expanded, setExpanded] = React.useState(false);
      const expandable = model.output !== null;
      const open = expanded && expandable;
      const statusKey = model.state === "running" ? "row.running"
        : model.state === "error" ? "row.failed"
        : model.state === "stopped" ? "row.stopped"
        : null;
      const leading = model.state === "error"
        ? h(P.StateDot, { state: "error" })
        : model.state === "stopped"
          ? h(P.StateDot, { state: "warning" })
          : h(P.IconSkillOutline16, { size: 14 });
      return h("div", { style: S.card, "data-tool": "skill", "data-state": model.state },
        h("div", {
          style: S.row,
          ...(expandable ? {
            role: "button", tabIndex: 0, "aria-expanded": open,
            onClick: () => setExpanded((value) => !value),
            onKeyDown: (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setExpanded((value) => !value);
            },
          } : {}),
        },
          h("span", { style: S.leading }, leading),
          statusKey !== null ? h("span", { style: S.visuallyHidden }, t(statusKey)) : null,
          h("span", { style: S.title }, t("row.title")),
          h("span", { style: S.separator, "aria-hidden": true }),
          h("span", {
            style: model.errorSummary === null ? S.summary : { ...S.summary, ...S.summaryError },
          }, model.errorSummary ?? model.name),
        ),
        open ? h("div", { style: S.body },
          h("pre", {
            style: model.state === "error" ? { ...S.instructions, ...S.instructionsError } : S.instructions,
            "aria-label": t("row.instructions"),
          }, model.output),
          inspect !== void 0 ? h("button", {
            type: "button",
            onClick: inspect,
            style: {
              alignSelf: "flex-start", cursor: "pointer", font: "inherit",
              fontSize: 11, lineHeight: "16px", padding: "2px 8px", borderRadius: 999,
              border: "1px solid var(--dsw-alias-border-l4)",
              background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-secondary)",
            },
          }, t("row.inspect")) : null,
        ) : null,
      );
    }

    /**
     * Split one skill's package attribution off its description.
     * @param {{description?: string}} skill - one catalog skill.
     * @returns {{package: string|null, description: string}}
     */
    function attributionOf(skill) {
      const raw = skill.description ?? "";
      const match = PACKAGE_PREFIX.exec(raw);
      if (!match) return { package: null, description: raw };
      return { package: match[1], description: raw.slice(match[0].length) };
    }

    /**
     * Order candidates so the menu's implicit section headers group them:
     * attributed packages first (in first-seen order), local skills last,
     * fuzzy rank preserved inside each section.
     */
    function sectioned(ranked, localLabel) {
      const sections = [];
      const bySection = new Map();
      for (const skill of ranked) {
        const { package: pkg } = attributionOf(skill);
        const key = pkg ?? localLabel;
        if (!bySection.has(key)) {
          bySection.set(key, []);
          sections.push(key);
        }
        bySection.get(key).push(skill);
      }
      const order = [...sections.filter((s) => s !== localLabel), localLabel].filter((s) => bySection.has(s));
      const out = [];
      for (const key of order) {
        for (const skill of bySection.get(key)) {
          out.push({ skill, section: key });
        }
      }
      return out;
    }

    /**
     * Client plugin body: dictionaries, the tool row, and the '/' source.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-menu: dictionaries");
      const t = ctx.locale.bind(NS);

      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "skill",
        locale: NS,
      }, SkillRow));

      const skills = ctx.remote.skills;
      const sessions = ctx.sessions;
      const fetches = new Map();
      const lexiconListeners = new Map();

      const notifyLexicon = (sessionId) => {
        for (const listener of [...lexiconListeners.get(sessionId) ?? []]) {
          try {
            listener();
          } catch (error) {
            console.error("[skill-menu] lexicon listener failed:", error);
          }
        }
      };

      const fetchCatalog = (sessionId) => {
        if (sessions.subagentAddress(sessionId) !== void 0) return Promise.resolve([]);
        const existing = fetches.get(sessionId);
        if (existing !== void 0) return existing.promise;
        const abort = new AbortController();
        const promise = (async () => {
          const result = await skills.list({ sessionId }, abort.signal);
          if (!result.ok) throw new Error(`skills/list failed: ${result.error.code}: ${result.error.message}`);
          return result.value.skills;
        })();
        const entry = { promise, abort };
        fetches.set(sessionId, entry);
        promise.then((settled) => {
          entry.settled = settled;
          notifyLexicon(sessionId);
        }, () => {
          if (fetches.get(sessionId) === entry) fetches.delete(sessionId);
        });
        return promise;
      };

      const invalidate = (key) => {
        const entry = fetches.get(key);
        if (entry === void 0) return;
        fetches.delete(key);
        entry.abort.abort();
        notifyLexicon(key);
      };

      const clearAll = () => {
        for (const key of [...fetches.keys()]) invalidate(key);
      };

      const source = {
        trigger: "/",
        name: "skill",
        order: -1,
        async candidates(session, { query, signal }) {
          const all = await fetchCatalog(session.sessionId);
          if (signal.aborted) return [];
          const ranked = P.rankByName(all, query);
          return sectioned(ranked, t("section.local")).map(({ skill, section }) => {
            const { description } = attributionOf(skill);
            return {
              name: skill.name,
              description: skill.modelInvocable ? description : `${t("menu.userOnly")} · ${description}`,
              // No `icon`: the host menu renderer draws only session/file/folder
              // reference glyphs, none of which reads as a skill. The section
              // header carries the grouping instead.
              section,
            };
          });
        },
        warm(session) {
          fetchCatalog(session.sessionId).catch(() => {});
        },
        lexicon(session) {
          return fetches.get(session.sessionId)?.settled?.map((skill) => skill.name);
        },
        subscribeLexicon(session, listener) {
          const key = session.sessionId;
          const listeners = lexiconListeners.get(key) ?? new Set();
          listeners.add(listener);
          lexiconListeners.set(key, listeners);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) lexiconListeners.delete(key);
          };
        },
        onPick({ candidate }) {
          return { text: `/${candidate.name} ` };
        },
      };

      const inputTriggers = ctx.get("inputTriggers");
      ctx.remote.$on("agent-preset/selected", invalidate);
      ctx.on("connection/reset", clearAll);
      ctx.effect(() => {
        const unregister = inputTriggers.registerSource(source);
        return () => {
          unregister();
          clearAll();
        };
      }, "skill-menu: source");
    }

    exports.apply = apply;
    exports.attributionOf = attributionOf;
    exports.sectioned = sectioned;
    exports.inject = [
      "inputTriggers",
      "sessions",
      "slots",
      "locale",
      "remote",
      "remote.skills",
    ];
    return module.exports;
  },
});
