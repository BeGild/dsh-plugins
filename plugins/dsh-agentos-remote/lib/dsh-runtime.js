import { dshSessionHistory, findDshSessionFile, listDshSessions, readDshSession } from "./session-store.js";

/**
 * Caller-lifetime signal for the controller calls that demand one.
 *
 * dsh 0.2.0's `sessionController.prompt` / `.page` call `signal.throwIfAborted()`
 * unconditionally, so omitting the second argument throws
 * `Cannot read properties of undefined (reading 'throwIfAborted')`. 0.1.x took
 * no signal at all, so passing a fresh never-aborted signal satisfies both.
 */
function callSignal(signal) {
  return signal ?? new AbortController().signal;
}

/**
 * The durable address 0.2.0's history reads resolve through
 * (`addressId` reads `address.kind === "session" ? address.sessionId :
 * address.childSessionId`). A bare `{ sessionId }` resolves to `undefined` and
 * the read fails with `failed to observe session "undefined"`.
 */
function sessionAddress(sessionId) {
  return { kind: "session", sessionId };
}

/**
 * Row ceiling for the opening history page. The app shows the first page's
 * content and never renders the older pages it fetches, so the opening page has
 * to carry the conversation; the cap only keeps a pathological log from
 * producing an unbounded reply.
 */
const FIRST_PAGE_RECORD_CAP = 2000;

/**
 * Session rows that carry something the app renders. Everything else in the log
 * is bookkeeping (step/start, request/header, request/context, model/selection,
 * permission/preset …) and must not consume the app's message budget.
 */
const MESSAGE_BEARING_ROWS = new Set([
  "user/message",
  "assistant/message",
  "assistant/chunk",
  "tool/call",
  "tool/result",
  "turn/end",
]);

/**
 * Whether a row opens a user turn.
 *
 * Mirrors the converter's rule for `user/message`: only a real user utterance
 * counts. The host injects framework context as user-role messages too
 * (`runtime-context`, `agent-instructions`, `skill-catalog` …), and anchoring a
 * page on one of those would leave the turn's own prompt outside the page. A row
 * with no `source` at all is a legacy user turn, exactly as the converter treats
 * it, so it anchors a page as well.
 */
function isTurnOpening(event) {
  if (event?.type !== "user/message") return false;
  const kind = event.data?.source?.kind;
  return kind === undefined || kind === "user";
}

/**
 * Whether a session is a delegated child.
 *
 * The host's sidebar lists top-level conversations only, and a subagent session
 * is the child of the session that spawned it — it must not become a
 * conversation of its own on the phone. Measured on this machine: three sessions
 * titled "你的任务：用飞书 CLI …" carried `origin: "subagent"` with
 * `delegationDepth: 1` and appeared on the phone while the sidebar never showed
 * them.
 *
 * Lineage alone is NOT the test: a forked session also carries `parentSession`,
 * but it stays top-level — `/handoff (1)` and `/handoff (2)` are forks, they are
 * members of the aicoding_env_dev workspace, and the sidebar lists them.
 */
function isSubagentSession(header) {
  return header?.origin === "subagent" || (header?.delegationDepth ?? 0) > 0;
}

export class DshRuntime {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async listWorkspaces() {
    const registry = this.ctx.workspaceRegistry;
    if (!registry?.list) return [];
    return (await registry.list()).map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...(workspace.sessionIds ?? [])],
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    }));
  }

  async listSessions() {
    const query = this.ctx.sessionQuery;
    const index = await this.workspaceIndex();
    if (query?.listSessions) {
      this.sessionsSource = "query";
      const records = await query.listSessions();
      return records
        .filter((record) => !isSubagentSession(record.header))
        .map((record) => this.decorateSession({
          id: record.header.id,
          cwd: record.header.cwd ?? "",
          createdAt: record.header.createdAt,
          live: record.live,
          persisted: record.persisted,
          title: this.titleOf(record.header.id),
          status: this.ctx.agents?.get?.(record.header.id)?.status ?? "idle",
        }, index));
    }

    this.sessionsSource = "disk";
    return listDshSessions().flatMap((entry) => {
      const parsed = readDshSession(entry.file);
      if (!parsed || isSubagentSession(parsed.header)) return [];
      return [this.decorateSession({
        id: entry.id,
        cwd: parsed.header.cwd ?? "",
        createdAt: parsed.header.createdAt,
        live: false,
        persisted: true,
        title: parsed.title,
        status: "idle",
        entry,
      }, index)];
    });
  }

  /**
   * The host's own organization of its sessions, which is what the DSH web
   * sidebar shows: workspaces (each with a path and title) plus the global
   * archived and pinned session sets. Membership is by path — the registry's
   * `sessionIds` getter filters to sessions whose cwd equals the workspace path
   * — so this is the model a remote client has to mirror, rather than the raw
   * cwd of every session.
   */
  async workspaceIndex() {
    const registry = this.ctx.workspaceRegistry;
    const workspaces = registry?.list ? await registry.list() : [];
    const bySession = new Map();
    for (const workspace of workspaces ?? []) {
      if (!workspace?.path) continue;
      const entry = {
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessionIds: [...(workspace.sessionIds ?? [])],
      };
      // Membership is the workspace's OWN attach list, not a cwd comparison: the
      // registry's `sessionIds` getter filters that list by path, so a session
      // whose cwd matches a workspace but was never attached to it stays
      // ungrouped (measured: 42 sessions share E:\work\aicoding_env_dev's cwd
      // while the workspace holds 14).
      for (const sessionId of entry.sessionIds) bySession.set(String(sessionId), entry);
    }
    const setOf = (value) => new Set([...(value ?? [])].map((id) => String(id)));
    return {
      bySession,
      archived: setOf(registry?.archivedSessionIds),
      pinned: setOf(registry?.pinnedSessionIds),
    };
  }

  /**
   * The workspace a path belongs to, when the host has one.
   *
   * Used on the create path: a session the app asks for inside a workspace
   * directory has to JOIN that workspace (the registry keeps an explicit attach
   * list, so a matching cwd alone is not membership), otherwise the phone shows
   * it under a directory of its own instead of the workspace the sidebar groups
   * it under.
   */
  async workspaceForPath(path) {
    if (!path) return null;
    const registry = this.ctx.workspaceRegistry;
    const workspace = await registry?.resolveByPath?.(path);
    if (!workspace?.path) return null;
    return { id: workspace.id, path: workspace.path, title: workspace.title };
  }

  /** Best-effort: make the host record this session as a member of its workspace. */
  async attachToWorkspace(sessionId, cwd) {
    try {
      const registry = this.ctx.workspaceRegistry;
      const workspace = await registry?.resolveByPath?.(cwd);
      await workspace?.attachSession?.(sessionId);
    } catch {
      // Membership is the host's business: a failure here leaves the session
      // ungrouped, which is exactly where it would have been anyway.
    }
  }

  /** Attach the workspace a session belongs to, plus its archived/pinned state. */
  decorateSession(session, index) {
    const workspace = index?.bySession?.get(String(session.id)) ?? null;
    const facts = this.logFacts(session.id);
    return {
      ...session,
      title: session.title ?? facts.title,
      blank: facts.blank,
      workspace: workspace ? { id: workspace.id, path: workspace.path, title: workspace.title } : null,
      archived: index?.archived?.has(session.id) ?? false,
      pinned: index?.pinned?.has(session.id) ?? false,
    };
  }

  /**
   * The session's display title.
   *
   * The live title service only knows attached sessions, so a cold session —
   * every session the phone lists after a restart — has no title there. The
   * `session/title` row in the session log is the durable copy, and reading it
   * is what keeps list names real instead of falling back to a placeholder.
   */
  titleOf(sessionId) {
    try {
      const live = this.ctx.get?.("sessionTitle")?.get?.(sessionId)?.title;
      if (live) return live;
    } catch {}
    return this.titleFromLog(sessionId);
  }

  titleFromLog(sessionId) {
    return this.logFacts(sessionId).title;
  }

  /**
   * What the session log says about a cold session: its durable title and
   * whether it is still empty.
   *
   * `blank` mirrors the host's own flag: a session with no message-bearing row
   * is an empty placeholder (the sidebar hides those — measured: a workspace of
   * 14 sessions showed 12, the two missing being exactly the blank ones), so it
   * must not become a conversation on the phone. One read answers both, because
   * every listed session is read anyway.
   */
  logFacts(sessionId) {
    const file = findDshSessionFile(sessionId);
    if (!file) return { title: undefined, blank: false };
    const parsed = readDshSession(file);
    if (!parsed) return { title: undefined, blank: false };
    return {
      title: parsed.title ?? undefined,
      blank: !parsed.events.some((event) => MESSAGE_BEARING_ROWS.has(event?.type)),
    };
  }

  async createSession({ sessionId, cwd, workspaceId, model, provider }) {
    const controller = this.ctx.sessionController;
    if (controller?.create) {
      let created;
      try {
        created = await controller.create({
          sessionId,
          ...(workspaceId ? { workspaceId } : { cwd }),
        });
      } catch (error) {
        // The app retries `session.create` when its own bookkeeping failed (a
        // rejected cloud registration, a dropped reply). The DSH session from
        // the first attempt is still live and `controller.create` rejects a
        // duplicate id, so reuse it rather than failing the retry.
        if (!this.hasLiveSession(sessionId)) throw error;
        created = { sessionId };
      }
      if ((model || provider) && controller.selectModel) {
        await controller.selectModel({ sessionId: created.sessionId, model, provider });
      }
      return created;
    }
    return this.ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { ...(provider ? { provider } : {}), ...(model ? { model } : {}) },
    });
  }

  /**
   * Best-effort "is this session already live?" probe.
   *
   * Each probe is optional-chained and contained, because the host API differs
   * between DSH releases (0.1.x exposes `ctx.sessions`, 0.2.x the session
   * controller) and a hard dependency on any one of them would be a load-time
   * or activation-time failure on the others. When no probe can answer, the
   * caller rethrows the original error — the safe, pre-existing behavior.
   */
  hasLiveSession(sessionId) {
    const probes = [
      () => this.ctx.sessions?.get?.(sessionId),
      () => this.ctx.sessionController?.get?.({ sessionId }),
      () => this.ctx.sessionController?.has?.({ sessionId }),
    ];
    for (const probe of probes) {
      try {
        if (probe()) return true;
      } catch {}
    }
    return false;
  }

  prompt({ sessionId, content, requestId, mode }) {
    const controller = this.ctx.sessionController;
    if (controller?.prompt) {
      return controller.prompt({ sessionId, content, requestId, ...(mode ? { mode } : {}) }, callSignal());
    }
    return this.resumeAndFollowup({ sessionId, content, requestId });
  }

  async resumeAndFollowup({ sessionId, content, requestId }) {
    let agent = this.ctx.agents.get(sessionId);
    if (!agent) {
      const handle = await this.ctx.agents.resume({ resumeSessionId: sessionId });
      agent = handle.agent;
    }
    agent.followup({
      id: requestId,
      role: "user",
      content,
      source: { kind: "user", rpcId: requestId },
    });
    return { accepted: true };
  }

  /**
   * One page of durable history.
   *
   * The controller's `page` reads through the session-query index, and a profile
   * may never open that index (`session-query-sqlite: { path: ':memory:',
   * openAt: never }` in the ekkobuddy profile): `page` then answers an EMPTY
   * page rather than failing, and so does `inspect` ("not found"). Measured on a
   * cold session holding 25 rows, the host returned 0 records while the log on
   * disk was complete — so an empty page must not be trusted, and the session
   * log is the fallback that actually has the history.
   */
  async page({ sessionId, beforeSeq, maxMessages = 50 }) {
    const controller = this.ctx.sessionController;
    if (controller?.page) {
      try {
        const result = await controller.page({
          address: sessionAddress(sessionId),
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          throughSeq: -1,
          maxMessages,
        }, callSignal());
        const records = result.records ?? [];
        if (records.length > 0) return { records, hasMore: result.hasMore === true };
      } catch {
        // An unindexed or detached session is not an error here: the log below
        // is the authority.
      }
    }
    return this.pageFromLog(sessionId, beforeSeq, maxMessages);
  }

  /**
   * Rows that produce something the app renders. `maxMessages` is the app's
   * message budget, but a DSH log is mostly non-message rows (step/start,
   * request/header, request/context, session/title-llm-request …): slicing the
   * raw tail by `maxMessages` handed the app a page that contained an assistant
   * reply and `session_end_turn` but NOT the user message, and the phone showed
   * an empty conversation for a session that has one.
   */
  pageFromLog(sessionId, beforeSeq, maxMessages) {
    const history = dshSessionHistory(sessionId);
    if (!history) return { records: [], hasMore: false };
    const events = history.events.filter((event) => typeof event.seq === "number").sort((a, b) => a.seq - b.seq);
    const eligible = beforeSeq === undefined ? events : events.filter((event) => event.seq < beforeSeq);
    // The app's FIRST request carries no cursor, and it renders only that page's
    // content: older pages fetched by scrolling are requested (verified — six
    // chained get_page calls with our own prevCursor values) but never shown, so
    // a windowed first page left the phone displaying just the newest turn. The
    // opening page therefore carries the whole conversation, capped so a
    // pathological log cannot produce an unbounded reply.
    if (beforeSeq === undefined) {
      const start = Math.max(0, eligible.length - FIRST_PAGE_RECORD_CAP);
      return { records: eligible.slice(start), hasMore: start > 0 };
    }
    let start = eligible.length;
    let counted = 0;
    while (start > 0) {
      if (MESSAGE_BEARING_ROWS.has(eligible[start - 1].type)) {
        if (counted >= maxMessages) break;
        counted += 1;
      }
      start -= 1;
    }
    // Turn-align the window: a page that starts mid-turn carries only the
    // assistant and tool rows of that turn, and the app renders nothing for it
    // (verified on a long session — its last five message rows are all assistant
    // and tool rows, and the phone showed an empty conversation). Walking back to
    // the user message that opened the turn makes the page start at a turn
    // boundary, which is the host's own `turnWindow` contract.
    while (start > 0 && !isTurnOpening(eligible[start])) start -= 1;
    return {
      records: eligible.slice(start),
      hasMore: start > 0,
    };
  }

  async waitForTurn(sessionId) {
    const agent = this.ctx.agents?.get?.(sessionId);
    if (agent?.whenIdle) return agent.whenIdle();
    throw new Error("DSH agent turn completion is unavailable for this session");
  }

  async sessionRecord(sessionId) {
    const query = this.ctx.sessionQuery;
    if (query?.load) return query.load(sessionId);
    const history = dshSessionHistory(sessionId);
    return history ? { header: history.header, title: history.title, events: history.events } : null;
  }
}
