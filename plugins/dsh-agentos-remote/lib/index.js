/**
 * dsh-agentos-remote
 *
 * Implements WorkBuddy's AgentOS local-agent remote-control protocol so the
 * WorkBuddy mobile app can drive a DSH agent session.
 *
 * Protocol (reverse-engineered from WorkBuddy desktop
 * packages/workbuddy-server/src/claw/bg-agent-api-client.ts and validated
 * end-to-end against the live service — see tools/probe-agentos.js):
 *
 *   1. POST {endpoint}/v2/agentos/localagent/registerWorkspace
 *      body {localAgentType, hostId, workspaceId, workspaceName}
 *      -> {url, connectionToken, subscriptionToken, channel}
 *   2. centrifuge connect to `url` with `connectionToken`,
 *      subscribe `channel`; inbound publications are app-driven tasks.
 *   3. Task -> ctx.agents.create/resume + agent.followup()
 *      -> agent events -> publication back on the same channel.
 *
 * The connectionToken TTL is 7 days (exp-iat = 604800s), so registration is
 * repeated on expiry — mirroring WorkBuddy's refreshCredentials.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { loadCredentials, saveCredentials, CREDENTIALS_FILE } from "./login-core.js";
import { registerLoginUi } from "./login-ui.js";
import {
  resolveDeviceId,
  fetchDeviceCredentials,
  fetchOnlineDevices,
  isDeviceOnline,
  devicePresenceChannel,
  devicePresencePayload,
  heartbeatIntervalOf,
  DEVICE_HEARTBEAT_MS,
  DEVICE_CLIENT_TYPE,
} from "./device-auth.js";
import {
  conversationUpdatedPayload,
  createCloudConversation,
  conversationCreatedPayload,
  conversationsChannel,
  listCloudConversations,
  migrateLegacySessions,
  mutateCloudConversation,
  publicModelList,
  promptTextOf,
  updateConversationActivity,
} from "./conversation-sync.js";
import {
  assembleEnvelopes,
  packEnvelopes,
  publishEnvelopeHttp,
  resolveChannelKeys,
} from "./envelope.js";
import {
  dshEventsToAcpUpdates,
  dshSessionHistory,
  listDshSessions,
  readDshSession,
  resolveDshSessionId,
} from "./session-store.js";
import { DshRuntime } from "./dsh-runtime.js";
import { SessionBindings, sessionIdForms } from "./session-bindings.js";

//#region config
/** Sensible defaults; every field overridable from the patch config. */
const DEFAULTS = {
  enabled: true,
  endpoint: "https://tencent.sso.codebuddy.cn",
  /**
   * Must be "workbuddy" — the server derives the Centrifugo channel NAMESPACE
   * from this value (`copilot_<localAgentType>:<uid>_<hostId>_<ws>`), and the
   * mobile app only enumerates the namespace WorkBuddy Desktop registers into,
   * which is `copilot_workbuddy`. Registering as "cli" succeeds (the response is
   * well-formed) but lands the device in `copilot_cli`, where the app never
   * looks — so it simply never appears in the device list.
   */
  agentType: "workbuddy",
  /** WorkBuddy desktop session file (plain-text JWT accessToken). */
  sessionFile: null,
  /** Directory exposed as a workspace to the mobile app. */
  workspaceDir: null,
  /** Device display name in the mobile app. Default: "{hostname}-DSH". */
  deviceName: null,
  /**
   * Stable device id for the conversation-sync registry. Default: reuse
   * `~/.workbuddy/device-id` (the id WorkBuddy Desktop enrolled this machine
   * under) and create one there if the file does not exist. Override with
   * `DSH_AGENTOS_DEVICE_ID` when this host must enroll as its own device.
   */
  deviceId: null,
  /** Agent route used for app-driven sessions. */
  provider: undefined,
  model: undefined,
  /**
   * Models offered to the mobile app's model picker (`get_models`). Each entry
   * needs at least an `id`; `name` and `vendor` are what the app renders. The
   * chosen id comes back as `session.set_model` or as `model` on a task, and is
   * passed straight to the DSH agent route. `url` and `apiKey` are stripped
   * before the list ever leaves the machine.
   */
  models: [],
};
//#endregion

//#region workbuddy session source
/**
 * WorkBuddy desktop persists its auth session at
 * {sharedDataPath}/auth/{authenticationId}.info, where sharedDataPath
 * resolves per platform (WorkBuddy FilePathServiceImpl + EXTENSION_DATA_DIR_NAME
 * = "CodeBuddyExtension"):
 *   win32   %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth
 *   darwin  ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth
 *   linux   ~/.local/share/CodeBuddyExtension/Data/Public/auth
 * Override with the `sessionFile` config or DSH_AGENTOS_SESSION_FILE, or skip
 * discovery entirely with DSH_AGENTOS_ACCESS_TOKEN.
 */
function workbuddySessionCandidates(explicit) {
  if (explicit || process.env.DSH_AGENTOS_SESSION_FILE) return [explicit || process.env.DSH_AGENTOS_SESSION_FILE];
  const home = os.homedir();
  const dirs = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    dirs.push(path.join(local, "CodeBuddyExtension", "Data", "Public", "auth"));
  } else if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"));
  } else {
    dirs.push(path.join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth"));
  }
  return dirs.flatMap((d) => ["workbuddy-desktop", "auth"].map((id) => path.join(d, `${id}.info`)));
}

function readWorkbuddySession(logger, explicit) {
  const token = process.env.DSH_AGENTOS_ACCESS_TOKEN;
  if (token) {
    logger.info("[agentos-remote] session from DSH_AGENTOS_ACCESS_TOKEN env");
    return {
      auth: { accessToken: token, domain: process.env.DSH_AGENTOS_DOMAIN },
      account: { uid: process.env.DSH_AGENTOS_USER_ID || "unknown", enterpriseId: process.env.DSH_AGENTOS_ENTERPRISE_ID },
    };
  }
  for (const p of workbuddySessionCandidates(explicit)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw?.auth?.accessToken && raw?.account?.uid) {
        logger.info(`[agentos-remote] session from ${p}`);
        return raw;
      }
      logger.warn(`[agentos-remote] ${p}: present but missing auth.accessToken/account.uid`);
    } catch (error) {
      logger.debug?.(`[agentos-remote] ${p}: ${error.message}`);
    }
  }
  return null;
}
//#endregion

//#region agentos client
const CONNECTION_TOKEN_TTL_MS = 604800 * 1000; // 7d, observed exp-iat
const REGISTER_RETRY_MS = 60 * 1000;
/**
 * Link health poll. This is also the device's HTTP heartbeat, and the server's
 * "online" window is short — the mobile app flips a device to offline within
 * about a minute of its client going away. At 30 minutes the poll was far too
 * slow to ever hold that window open, which is indistinguishable from a device
 * that never came up.
 */
const LINK_CHECK_MS = 20 * 1000;
/** Inbound task dedupe window (WorkBuddy parity: messageExpireTime = 3e5). Centrifugo recovery can redeliver. */
const DEDUPE_TTL_MS = 5 * 60 * 1000;
/** The registry keys a local conversation on a UUID; any other id is refused. */
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The registry throttles conversation creation: after roughly ten records it
 * answers `429 code 14003 "retry after 60 seconds"`, so a boot that registers a
 * backlog has to pace itself instead of hammering the endpoint.
 */
const REGISTER_THROTTLE_MS = 61000;
const REGISTER_THROTTLE_BUDGET = 3;
/**
 * Version of the record shape this build writes to the registry.
 *
 * A record's title, cwd and grouping are written once and the registry has no
 * list endpoint, so a build that changes what a record should say can never see
 * the old value to compare against. Bumping this constant makes every binding
 * from an earlier shape re-send itself once on the next boot, which is what
 * retires the records an earlier build wrote with the host's working directory
 * as their cwd (they showed up on the phone as a space named after the install
 * directory, while the sidebar files those sessions under 未分组).
 */
const PROJECTION_VERSION = 3;
/** Auth endpoints (verified live; prefixPath "/plugin" from WorkBuddy product.json authentication config). */
const AUTH_BASE = "https://copilot.tencent.com";
const REFRESH_PATH = "/v2/plugin/auth/token/refresh";

function b3Headers() {
  const traceId = randomUUID().replace(/-/g, "").slice(0, 32).padEnd(32, "0");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  return {
    "X-B3-TraceId": traceId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",
    "X-Trace-Id": traceId,
    b3: `${traceId}-${spanId}-1`,
  };
}

function buildHeaders(session) {
  const auth = session?.auth || {};
  const account = session?.account || {};
  const headers = { Accept: "application/json", "Content-Type": "application/json", ...b3Headers() };
  if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  if (account.uid) headers["X-User-Id"] = account.uid;
  if (account.enterpriseId) {
    headers["X-Enterprise-Id"] = account.enterpriseId;
    headers["X-Tenant-Id"] = account.enterpriseId;
  }
  if (auth.domain) headers["X-Domain"] = auth.domain;
  return headers;
}

function workspaceIdOf(dir) {
  return (dir.split(/[\\/]/).pop() || "workspace").toLowerCase();
}

/**
 * Device display name in the mobile app = registerWorkspace's workspaceName
 * (desktop parity: WorkBuddy registers `${productName} Desktop`). Default here
 * is `{hostname}-DSH` so a machine running both shows as two devices, e.g.
 * "laptop-DSH" next to the WorkBuddy desktop entry. Config override:
 * `deviceName`.
 */
function defaultDeviceName() {
  let host = os.hostname?.() || "dsh";
  return `${host}-DSH`;
}

/**
 * Token refresh — verified live (HTTP 200, rotated refreshToken):
 *   POST {AUTH_BASE}/v2/plugin/auth/token/refresh
 *   headers: Authorization + X-Refresh-Token + X-Auth-Refresh-Source: "plugin"
 *            + X-Product: "SaaS" + WorkBuddy UA
 *   -> {code:0, data:{accessToken, expiresIn, refreshExpiresIn, refreshToken, ...}}
 * The refresh token ROTATES on every call, so the new pair must be persisted.
 */
function jwtExpiresAt(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch { return undefined; }
}

function refreshHeaders(session) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Product": "SaaS",
    "User-Agent": "windows/10.0.22631 WorkBuddy/37.10.3",
    "X-Refresh-Token": session.auth.refreshToken,
    "X-Auth-Refresh-Source": "plugin",
  };
  if (session.auth.accessToken) headers.Authorization = `Bearer ${session.auth.accessToken}`;
  if (session.account?.uid) headers["X-User-Id"] = session.account.uid;
  return headers;
}

/** Call the refresh endpoint. Returns the new auth object, or null on hard failure. */
async function refreshAccessToken(session, logger) {
  if (!session?.auth?.refreshToken) return null;
  try {
    const res = await fetch(`${AUTH_BASE}${REFRESH_PATH}`, { method: "POST", headers: refreshHeaders(session), body: "{}" });
    const text = await res.text();
    if (!res.ok) {
      logger.warn?.(`[agentos-remote] token refresh HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const json = JSON.parse(text);
    const auth = json?.data ?? json;
    if (!auth?.accessToken) {
      logger.warn?.(`[agentos-remote] token refresh response missing accessToken`);
      return null;
    }
    auth.lastRefreshTime = Date.now();
    auth.expiresAt = auth.expiresAt ?? jwtExpiresAt(auth.accessToken) ?? (auth.expiresIn ? Date.now() + auth.expiresIn * 1000 : undefined);
    auth.domain = auth.domain ?? session.auth.domain;
    logger.info?.(`[agentos-remote] token refreshed (valid until ${auth.expiresAt ? new Date(auth.expiresAt).toISOString() : "unknown"})`);
    return { ...session.auth, ...auth };
  } catch (error) {
    logger.warn?.(`[agentos-remote] token refresh failed: ${error.message}`);
    return null;
  }
}

/** Cache of refreshed credentials (env-token mode): survives restarts. */
function credentialCacheFile() {
  return path.join(os.homedir(), ".workbuddy", ".dsh-agentos-credentials.json");
}

function loadCredentialCache(logger) {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialCacheFile(), "utf8"));
    if (raw?.auth?.accessToken && raw?.account?.uid) return raw;
  } catch {}
  return null;
}

function saveCredentialCache(session, logger) {
  try {
    fs.mkdirSync(path.dirname(credentialCacheFile()), { recursive: true });
    fs.writeFileSync(credentialCacheFile(), JSON.stringify(session, null, 2));
  } catch (error) {
    logger.debug?.(`[agentos-remote] credential cache write failed: ${error.message}`);
  }
}

async function registerWorkspace(endpoint, agentType, hostId, session, workspaceDir, logger, deviceName) {
  const body = {
    // WorkBuddy Desktop sends userId alongside hostId/workspaceId; the server
    // accepts its absence but the app-side ownership of the device is keyed on
    // it, so it is sent explicitly. JSON.stringify drops it when the session
    // carries no uid rather than emitting `"userId": undefined`.
    userId: session?.account?.uid,
    localAgentType: agentType,
    hostId,
    workspaceId: workspaceIdOf(workspaceDir),
    workspaceName: deviceName || path.basename(workspaceDir),
  };
  const url = `${endpoint}/v2/agentos/localagent/registerWorkspace`;
  const res = await fetch(url, { method: "POST", headers: buildHeaders(session), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`registerWorkspace HTTP ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`registerWorkspace non-JSON response: ${text.slice(0, 300)}`); }
  if (json.code !== 0 && json.code !== undefined) throw new Error(`registerWorkspace code=${json.code} ${json.msg || ""}`);
  const data = json.data ?? json;
  const missing = ["url", "connectionToken", "channel"].filter((k) => !data[k]);
  if (missing.length) throw new Error(`registerWorkspace missing field(s): ${missing.join(", ")}`);
  logger.info(`[agentos-remote] registered workspace=${body.workspaceId} device="${body.workspaceName}" channel=${data.channel}`);
  return data;
}

function userInfoHeader(uid) {
  return Buffer.from(JSON.stringify({ sub: uid })).toString("base64");
}

/**
 * App reply — verified live (HTTP 200 "Duplicate callback (idempotent)"):
 *   POST {endpoint}/v2/backgroundagent/localProxy/receive
 *   body {type:"COPILOT_RESPONSE", msgId:<task requestId>, chatId,
 *         success, message, metadata:{state:"completed", sessionId:chatId}}
 *   headers: auth headers + X-User-Id + X-Userinfo(base64 {"sub":uid})
 * Notes:
 *   - endpoint must carry the /v2 prefix (the CLI's baseUrl ends with /v2)
 *   - the channel mapping is created by registerWorkspace and EXPIRES —
 *     the workspace must be registered (and ideally subscribed) when replying
 *   - metadata.sessionId is REQUIRED (400 without it)
 *   - server dedupes by msgId (idempotent)
 *   - channel publish is rejected for local agents: HTTP is the only uplink
 */
async function sendResponse(endpoint, session, hostId, workspaceId, requestId, replyText, logger) {
  const uid = session?.account?.uid || "unknown";
  const chatId = `${uid}_${hostId}_${workspaceId}`;
  const body = {
    type: "COPILOT_RESPONSE",
    msgId: requestId,
    chatId,
    success: true,
    message: replyText,
    metadata: { state: "completed", sessionId: chatId },
  };
  const base = endpoint.replace(/\/+$/, "");
  const url = `${base}${base.endsWith("/v2") ? "" : "/v2"}/backgroundagent/localProxy/receive`;
  const headers = { ...buildHeaders(session), "X-User-Id": uid, "X-Userinfo": userInfoHeader(uid) };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`sendResponse HTTP ${res.status}: ${text.slice(0, 300)}`);
  logger.info(`[agentos-remote] reply sent for msgId=${requestId} (${replyText.length} chars)`);
  return true;
}

/**
 * Inbound task — verified from WorkBuddy's RemoteControlMessageHandler:
 *   { requestId, prompt, platformData?: { workspaceId, ... } }
 * prompt may be a string or [{type:"text", text}] (extractPromptText).
 */
function extractPromptText(prompt) {
  if (typeof prompt === "string") return prompt.trim();
  if (Array.isArray(prompt)) {
    const text = prompt.find((b) => b?.type === "text" && b?.text);
    return text?.text?.trim() || "";
  }
  return "";
}

/** The desktop's batch pump packs several commands into one delivery. */
function isBatchContainer(payload) {
  return typeof payload === "object" && payload !== null
    && typeof payload.__chsdkBatch === "number"
    && Array.isArray(payload.items);
}

function extractWorkspaceId(task, fallbackWorkspaceId) {
  const fromPlatform = task?.platformData?.workspaceId;
  return typeof fromPlatform === "string" && fromPlatform ? fromPlatform : fallbackWorkspaceId;
}
//#endregion

//#region agent bridge
/**
 * Drive one app task through a DSH agent.
 * Creates a fresh session per task (`ctx.agents.create`); a future iteration
 * can resume a persisted session for app-provided chat continuity.
 *
 * Result extraction is log-based (verified API): after `whenIdle()` the
 * assistant text is read from the session log's `assistant/message` events —
 * no reliance on speculative live event names.
 */
/**
 * Drive one app task through a DSH agent and stream the turn to the app.
 *
 * The DSH session is created (or resumed) under the app conversation's
 * sessionId, so the persisted session log IS the conversation history —
 * get_page replays it and a later prompt resumes the same context.
 *
 * While the turn runs, new session rows are polled and handed to
 * `onUpdate` as ACP sessionUpdate notifications (user echo, thoughts,
 * tool calls, tool results, assistant text), which the caller pushes on
 * the conversation channel. That is what makes thinking and tool activity
 * render live on the phone.
 */
async function runTask(ctx, prompt, workspaceDir, route, sessionKey, onUpdate, notes) {
  const meta = { cwd: workspaceDir };
  const agentOptions = {};
  if (route.provider) agentOptions.provider = route.provider;
  if (route.model) agentOptions.model = route.model;
  // Explicit provider/model: the home's DEFAULT route pointed at a provider
  // without credentials, and the earlier "agentOptions trips admission" theory
  // proved wrong — the real breaker was an unrelated plugin (disabled since).
  const persisted = resolveDshSessionId(sessionKey);
  const handle = persisted
    ? await ctx.agents.resume({ resumeSessionId: persisted, ...agentOptions })
    : await ctx.agents.create({ sessionId: sessionKey, meta, agentOptions });
  const agent = handle.agent;
  const startSeq = agent.session?.seq ?? 0;
  let pushedSeq = startSeq;
  const flush = () => {
    try {
      const events = agent.session.snapshotEvents(pushedSeq);
      for (const update of dshEventsToAcpUpdates(events, { isHistoryReplay: false })) {
        onUpdate?.(update);
      }
      pushedSeq = agent.session.seq;
    } catch {}
  };
  agent.followup({
    // Session format v4: followup takes a complete message, not a bare
    // content bundle — id + role + producer-owned source (the retired
    // `{ kind: "plugin" }` wrapper is refused), matching how auto-continue
    // injects its prompts.
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: prompt }],
    source: { kind: "user" },
  });
  // Stream rows while the turn runs, then a final flush after it settles.
  const POLL_MS = 350;
  await new Promise((resolve, reject) => {
    const finish = () => {
      clearInterval(timer);
      try {
        resolve(agent.whenIdle());
      } catch (error) {
        reject(error);
      }
    };
    const timer = setInterval(() => {
      flush();
      if (agent.status === "idle") finish();
    }, POLL_MS);
  });
  flush();
  // Turn diagnostics: what the log actually holds after the turn. The plugin's
  // logger has no sink, so this is the only window into a silently-empty turn.
  if (Array.isArray(notes)) {
    const events = [];
    try {
      for (const event of agent.session.snapshotEvents(startSeq)) {
        events.push(event?.type ?? "?");
      }
    } catch {}
    notes.push({ seqBefore: startSeq, seqAfter: agent.session?.seq, events: events.slice(0, 24) });
  }
  const text = extractAssistantText(agent.session, startSeq);
  await handle.dispose();
  return text || "(no assistant text produced)";
}

/** Collect assistant text blocks from the session log at/after startSeq. */
function extractAssistantText(session, startSeq) {
  try {
    const events = session.snapshotEvents(startSeq);
    const parts = [];
    for (const event of events) {
      if (event?.type !== "assistant/message") continue;
      const blocks = event?.data?.message?.content ?? event?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type === "text" && block.text) parts.push(block.text);
      }
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}
//#endregion

//#region service
/** The remote-control link: credentials -> registration -> Centrifugo -> agents. */
var AgentosRemoteService = class extends Service {
  // The remote bridge reads the canonical DSH registries and routes prompts
  // through the same session controller used by the Web UI.
  static inject = ["webServer", "agents", "sessionController", "sessionQuery", "workspaceRegistry", "workspaceController"];

  constructor(ctx, config) {
    super(ctx, "agentosRemote");
    this.config = { ...DEFAULTS, ...(config || {}) };
    this.processed = new Map(); // requestId -> first-seen ts (dedupe, DEDUPE_TTL_MS)
    this.subscribed = false; // channel subscription live (reported to the UI panel)
    this.channel = null; // channel name from the last successful registration
    this.lastError = null; // last link failure, surfaced to the panel for debugging
    this.deviceEnrolled = false; // conversation-sync registry accepted this device
    this.deviceOnline = false; // registry snapshot currently lists this device
    this.runtime = new DshRuntime(ctx);
    this.bindings = new SessionBindings();
    this.conversations = new Map(this.bindings.values().map((binding) => [binding.sessionId, binding]));
    this.selectedModel = null; // app's model choice, applied to the next task
    this.envelopeBuffer = new Map(); // msgId -> collected parts of an inbound delivery
  }

  /** True when this requestId was already handled within the dedupe window. */
  seenAndTrack(requestId) {
    if (!requestId) return false;
    const now = Date.now();
    for (const [k, t] of this.processed) if (now - t > DEDUPE_TTL_MS) this.processed.delete(k);
    if (this.processed.has(requestId)) return true;
    this.processed.set(requestId, now);
    return false;
  }

  /**
   * Link state, coarse enough to render and precise enough to act on:
   * `waiting-login` (no credentials yet), `connecting` (registered, socket not
   * up), `subscribed` (tasks can arrive), `stopped` (torn down).
   */
  linkState() {
    if (this.stopped) return "stopped";
    if (!this.session?.auth?.accessToken) return "waiting-login";
    return this.subscribed ? "subscribed" : "connecting";
  }

  /**
   * Snapshot for the in-UI panel (`GET /agentos-remote/login/api/status`).
   *
   * Non-secret facts only, and a deliberate ALLOW-LIST: this route sits on the
   * same unauthenticated web surface as the login page, so no access token,
   * refresh token or channel credential may ever appear in it, and adding a
   * field is a decision rather than a detail. The uid/nickname pair is the same
   * information the page already shows on a successful scan.
   *
   * `config.debug` adds a diagnostics block, because the device-list bug is
   * otherwise invisible from outside: the channel NAMESPACE is what decides
   * whether the mobile app can enumerate this device (`copilot_workbuddy` yes,
   * `copilot_cli` no), and this plugin's `ctx.logger` output has no reachable
   * sink. Even there only the namespace prefix is reported — the full channel
   * encodes uid + hostId.
   */
  linkStatus() {
    const session = this.session;
    const status = {
      loggedIn: !!session?.auth?.accessToken,
      uid: session?.account?.uid ?? null,
      nickname: session?.account?.nickname ?? null,
      device: this.config.deviceName || defaultDeviceName(),
      workspace: path.basename(this.workspaceDir || this.config.workspaceDir || process.cwd()),
      endpoint: this.config.endpoint,
      link: this.linkState(),
      // Non-secret link vitals. The plugin's logger has no reachable file sink,
      // so these counters are the only way to see — from any launcher, with or
      // without debug — whether commands arrive and broadcasts leave. The
      // panel-facing test pins the exact key set, keeping this list deliberate.
      deviceEnrolled: this.deviceEnrolled,
      presenceBeats: this.presenceBeats ?? 0,
      presenceFailures: this.presenceFailures ?? 0,
      executorPublications: this.executorPublications ?? 0,
      executorAssembled: this.executorAssembled ?? 0,
      broadcastsSent: this.broadcastsSent ?? 0,
      messagesSent: this.messagesSent ?? 0,
      lastReplyLength: this.lastReplyLength ?? null,
      lastTurnDiag: this.lastTurnDiag ?? null,
      commands: this.commandLog ?? [],
      lastError: this.lastError,
      // Sync vitals. The plugin's own logger has no reachable sink, so these are
      // the only way to see what the boot-time conversation sync actually did.
      sessionsListed: this.sessionsListed ?? null,
      sessionsRaw: this.sessionsRaw ?? null,
      sessionsSource: this.runtime?.sessionsSource ?? null,
      sessionsProbe: this.sessionsProbe ?? null,
      sessionsBlank: this.sessionsBlank ?? null,
      sessionsPending: this.sessionsPending ?? null,
      sessionsPruned: this.sessionsPruned ?? null,
      lastSyncError: this.lastSyncError ?? null,
    };
    if (this.config.debug) {
      status.agentType = this.config.agentType;
      status.channelNamespace = this.channel ? this.channel.split(":")[0] : null;
      status.registered = !!this.channel;
      status.deviceOnline = this.deviceOnline;
      status.lastPresenceBeatAt = this.lastPresenceBeatAt ? new Date(this.lastPresenceBeatAt).toISOString() : null;
      status.presenceChannelSubscribed = !!this.deviceSubscriptions?.some((entry) => entry.channel === devicePresenceChannel(this.session?.account?.uid));
    }
    return status;
  }

  async [Service.init]() {
    const logger = this.ctx.logger || console;
    if (!this.config.enabled) {
      logger.info("[agentos-remote] disabled by config");
      return;
    }
    // `{ global: true }` is required, not decorative: session events are
    // dispatched through the scope that carries the session, and a listener
    // registered on this plugin's own scope only sees sessions created in that
    // same scope. Sessions made through `ctx.sessionController` live in the
    // controller's scope, so without the flag every app-driven turn streams
    // nothing — the prompt is admitted and the phone waits forever. The host's
    // own session controller subscribes with exactly this option.
    this.ctx.on("session/event", (session, event) => this.forwardSessionEvent(session, event), { global: true });
    // Web UI QR login — the only path on a fresh remote machine (no WorkBuddy
    // desktop, no host-side browser). The user already reaches DSH over HTTP;
    // the login page and the in-client panel (lib/client.js) both ride that
    // same channel.
    try {
      const webServer = this.ctx.webServer;
      if (webServer?.register) {
        this.disposeLoginUi = registerLoginUi(
          webServer,
          { onSession: (session) => this.onWebLogin(session), status: () => this.linkStatus() },
          logger,
        );
        logger.info("[agentos-remote] login page: /agentos-remote/login (also a panel in the DSH web UI)");
      }
    } catch (error) {
      logger.warn?.(`[agentos-remote] login UI unavailable: ${error.message}`);
    }

    const session = await this.resolveSession(logger);
    if (!session) {
      logger.warn("[agentos-remote] no credentials — open /agentos-remote/login in the DSH web UI and scan to activate");
      return;
    }
    this.session = session;
    this.hostId = this.loadHostId();
    this.deviceId = resolveDeviceId(this.config.deviceId, logger);
    this.workspaceDir = this.config.workspaceDir || process.cwd();
    logger.info(`[agentos-remote] uid=${session.account.uid} hostId=${this.hostId} deviceId=${this.deviceId} workspace=${path.basename(this.workspaceDir)}`);
    this.stopped = false;
    this.loopRunning = true;
    this.connectLoop();
  }

  /**
   * Credential cascade (all live-verified):
   *   1. env DSH_AGENTOS_ACCESS_TOKEN (manual override, highest priority)
   *   2. WorkBuddy desktop session file (platform auto-discovery)
   *   3. cached credentials from a previous web-QR / CLI login
   * Expired/near-expiry accessTokens are refreshed; the refreshToken rotates
   * on every refresh and both values are re-persisted for cache-sourced logins.
   */
  async resolveSession(logger) {
    const fromFile = readWorkbuddySession(() => {}, this.config.sessionFile);
    let session = fromFile ?? null;
    let source = "workbuddy-session-file";
    if (!session && process.env.DSH_AGENTOS_ACCESS_TOKEN) {
      session = { auth: { accessToken: process.env.DSH_AGENTOS_ACCESS_TOKEN, domain: process.env.DSH_AGENTOS_DOMAIN }, account: { uid: process.env.DSH_AGENTOS_USER_ID || "unknown", enterpriseId: process.env.DSH_AGENTOS_ENTERPRISE_ID } };
      source = "env";
    }
    if (!session) {
      session = loadCredentials();
      source = "cached-login";
    }
    if (session) logger.info?.(`[agentos-remote] session source: ${source} (uid=${session.account?.uid ?? "?"})`);
    // Refresh when missing expiry data or within 1h of expiry.
    const expiresAt = session?.auth?.expiresAt ?? jwtExpiresAt(session?.auth?.accessToken ?? "") ?? 0;
    if (session?.auth?.refreshToken && expiresAt - Date.now() < 3600 * 1000) {
      const fresh = await refreshAccessToken(session, logger);
      if (fresh) {
        session = { ...session, auth: fresh };
        // Only cache-sourced sessions are ours to rewrite; WorkBuddy's file and
        // env tokens are owned elsewhere.
        if (source === "cached-login") saveCredentials(session);
      } else {
        logger.warn?.("[agentos-remote] token refresh failed — redo the QR login if the link starts 401ing");
      }
    }
    return session?.auth?.accessToken ? session : null;
  }

  /** A completed web-QR login: adopt the session and (re)start the link. */
  async onWebLogin(session) {
    const logger = this.ctx.logger || console;
    logger.info(`[agentos-remote] web login completed: uid=${session.account?.uid} — starting remote link`);
    this.stopSocket();
    this.session = session;
    this.hostId = this.hostId ?? this.loadHostId();
    this.deviceId = this.deviceId ?? resolveDeviceId(this.config.deviceId, logger);
    this.workspaceDir = this.config.workspaceDir || process.cwd();
    this.stopped = false;
    if (!this.loopRunning) {
      this.loopRunning = true;
      this.connectLoop();
    }
  }

  /**
   * The device identity AgentOS keys this machine on.
   *
   * This MUST be the same value WorkBuddy Desktop derives, because the mobile
   * app lists DEVICES by hostId and only shows a device that already has a
   * record. A random id registers a workspace nobody can address: registration
   * succeeds, the channel subscribes, and the device still never appears in the
   * app's picker. Matching the desktop's derivation is what makes the DSH
   * workspace attach to the device record this machine already has.
   *
   * Verified against the live desktop (5.5.6): its logged
   * `sessionId=<uid>_3bffc704416d2d63fe070b63e81b185f_93adce802be60689` is
   * exactly `sha256("<hostname>_<homedir>_<platform>_<arch>")[0:32]` on this box.
   */
  loadHostId() {
    // Never touch ctx.* services here — Cordis throws on property access for
    // services this plugin does not inject.
    return createHash("sha256")
      .update(`${os.hostname()}_${os.homedir()}_${os.platform()}_${os.arch()}`)
      .digest("hex")
      .substring(0, 32);
  }

  stop() {
    this.stopped = true;
    this.loopRunning = false;
    this.stopDeviceHeartbeat();
    // Best-effort offline notice so the app drops this device immediately
    // instead of waiting out the server's online window.
    this.publishDevicePresence("device.offline");
    this.stopDeviceSocket();
    this.stopSocket();
    for (const watcher of this.turnWatchers?.values() ?? []) this.stopTurnWatcher(watcher);
  }

  /** Register + subscribe; re-register when the server flags the link stale. */
  async connectLoop() {
    const logger = this.ctx.logger || console;
    while (!this.stopped) {
      try {
        if (!this.session?.auth?.accessToken) {
          // No credentials yet (fresh machine): wait for the web-QR login.
          // The login page is already up; onWebLogin flips this.loopRunning.
          logger.info("[agentos-remote] waiting for login at /agentos-remote/login …");
          this.loopRunning = false;
          return;
        }
        // The conversation-sync device registry is what makes this machine
        // addressable at all — registerWorkspace alone lands a workspace the app
        // cannot route a command to. It is enrolled once and kept up by its own
        // heartbeat; only a dropped device link triggers a fresh enrollment.
        if (!this.deviceEnrolled) await this.enrollDevice(logger);
        const data = await registerWorkspace(
          this.config.endpoint, this.config.agentType, this.hostId, this.session, this.workspaceDir, logger,
          this.config.deviceName || defaultDeviceName(),
        );
        // Recorded so the panel can report WHICH namespace we registered into —
        // the single fact that decides mobile-app enumeration.
        this.channel = data.channel;
        this.lastError = null;
        await this.subscribe(data, logger);
        // Wait, polling link health. Server flags RE_REGISTER_WORKSPACE when its
        // view of the registration/websocket goes stale (verified live); the
        // connectionToken TTL (7d) is the hard backstop.
        const ttlWait = CONNECTION_TOKEN_TTL_MS - 3600 * 1000;
        let waited = 0;
        let stale = false;
        while (!this.stopped && waited < ttlWait) {
          const chunk = Math.min(LINK_CHECK_MS, ttlWait - waited);
          await this.sleep(chunk);
          waited += chunk;
          try {
            const health = await this.checkLinkHealth(logger);
            if (health.action === "RE_REGISTER_WORKSPACE" || health.linkStatus?.websocket === false) {
              logger.info(`[agentos-remote] server flagged link stale (action=${health.action}, linkStatus=${JSON.stringify(health.linkStatus)}); re-registering`);
              stale = true;
              break;
            }
          } catch (error) {
            logger.warn(`[agentos-remote] link health check failed: ${error.message}`);
          }
          // The device link drops on its own schedule (its connect token is
          // short-lived). Waiting out the workspace token's 7-day TTL before
          // noticing would leave the device offline the whole time.
          if (!this.deviceEnrolled) {
            logger.info("[agentos-remote] device link dropped; re-enrolling");
            stale = true;
            break;
          }
        }
        if (this.stopped) return;
        if (!stale) logger.info(`[agentos-remote] connectionToken TTL reached; re-registering`);
        this.stopSocket();
      } catch (error) {
        logger.warn(`[agentos-remote] link error: ${error.message}; retrying in ${REGISTER_RETRY_MS / 1000}s`);
        // Surfaced on /api/status: this output has no reachable log sink, so a
        // silent retry loop is undebuggable from the outside.
        this.lastError = error.message;
        await this.sleep(REGISTER_RETRY_MS);
      }
    }
  }

  /**
   * Server-side link health for this workspace (verified live):
   *   healthy:  {success:true, action:null,          linkStatus:{registration:true, websocket:true}}
   *   stale:    {success:true, action:"RE_REGISTER_WORKSPACE", linkStatus:{registration:false, websocket:false}}
   */
  async checkLinkHealth(logger) {
    const workspaceId = workspaceIdOf(this.workspaceDir);
    const sessionId = `${this.session?.account?.uid || "unknown"}_${this.hostId}_${workspaceId}`;
    const base = this.config.endpoint.replace(/\/+$/, "");
    const url = `${base}${base.endsWith("/v2") ? "" : "/v2"}/backgroundagent/localProxy/ping?sessionId=${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, { headers: buildHeaders(this.session) });
    if (!res.ok) throw new Error(`ping HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    const data = json?.data ?? json;
    return { success: !!data?.success, action: data?.action, linkStatus: data?.linkStatus };
  }

  sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /**
   * Enroll this machine in the conversation-sync device registry and hold it
   * online: fetch the per-device channel credentials, subscribe every channel
   * the server hands back, announce `device.online`, then confirm against the
   * registry snapshot.
   *
   * The command channel (`executor:{deviceId}`) is where the app delivers work
   * once the device is enrolled, so its publications feed the same task handler
   * as the AgentOS workspace channel.
   */
  async restoreCloudMappings(logger) {
    // The registry's LIST endpoint is not reachable from this plugin: verified
    // live, `/console/as/conversation-sync/conversations` answers
    // `404 page not found`, `GET /console/as/conversations` answers 403 and
    // `GET /console/as/conversations/v2` treats "v2" as a conversation id. The
    // durable bindings file is therefore the authority for restoring mappings,
    // and this call is only a best-effort top-up that must never break the sync
    // chain that follows it.
    let cloud = [];
    try {
      cloud = await listCloudConversations(this.session, { deviceId: this.deviceId });
    } catch (error) {
      logger.warn(`[agentos-remote] cloud conversation list unavailable (${error.message}); using local bindings`);
      return;
    }
    for (const item of cloud) {
      const sessionId = item.sessionId ?? item.session_id;
      const conversationId = item.conversationId ?? item.conversation_id ?? item.id;
      if (!sessionId || !conversationId) continue;
      const binding = this.bindings.set({
        sessionId,
        conversationId,
        cwd: item.workDir ?? item.cwd ?? "",
        title: item.conversationTitle ?? item.title ?? item.name ?? "",
        model: item.clientContext?.model ?? item.model ?? null,
        conversationOrigin: item.conversationOrigin ?? item.conversation_origin ?? "legacy_workbuddy_local",
        projectId: item.projectId ?? item.project_id ?? null,
        createdAt: item.createdAtMs ?? item.createdAt ?? null,
        updatedAt: item.updatedAtMs ?? item.updatedAt ?? null,
      });
      this.conversations.set(sessionId, binding);
    }
    logger.info(`[agentos-remote] restored ${cloud.length} cloud conversation binding(s)`);
  }

  /**
   * The name a local session should carry in the registry.
   *
   * The session log's own title is what the phone should read. A session that
   * never ran a turn has none, and the placeholder then has to be readable:
   * DSH session ids are already prefixed `session-`, so slicing the raw id
   * produced names like "会话 session-" — the id is stripped first.
   */
  titleForSession(session) {
    if (session.title) return session.title;
    const short = String(session.id ?? "").replace(/^session-/, "").slice(0, 8);
    return `会话 ${short}`;
  }

  /**
   * The id the conversation registry accepts for a local session.
   *
   * DSH mints session ids as `session-<uuid>`, but the registry rejects that
   * form: sending it answers `{status: "skipped", reason: "invalid_field"}` and
   * registers nothing (verified live — the same body with the bare uuid imports
   * fine and returns the conversationId). The registry's id for a local record
   * is therefore the bare uuid, while the local session keeps its prefixed id.
   */
  registrySessionId(sessionId) {
    return String(sessionId ?? "").replace(/^session-/, "");
  }

  /**
   * Register local sessions the cloud does not know, and re-register the ones it
   * knows under a stale title.
   *
   * The registry is where the phone's task list gets its names, and the
   * migration response is the authority for the conversation id — it returns
   * `results[bareSessionId].conversationId`, both for an import and for an
   * update. An earlier build wrote placeholder names ("会话 session-…") because
   * the session log's title row was unreadable, so a session whose title has
   * since changed is re-sent with `forceUpdate`, which the registry applies as
   * an update.
   */
  async migrateLocalSessions(logger) {
    const sessions = await this.visibleSessions();
    this.sessionsListed = sessions.length;
    const unbound = sessions.filter((session) => !this.bindings.getBySession(session.id));
    const stale = sessions.filter((session) => {
      const binding = this.bindings.getBySession(session.id);
      if (!binding) return false;
      if (binding.projectionVersion !== PROJECTION_VERSION) return true;
      if (binding.title !== this.titleForSession(session)) return true;
      // A record registered before this plugin mirrored the host's workspace
      // model has no `workDir` of its own and has to be re-sent once; after
      // that, a changed workspace assignment is what triggers a refresh.
      if (!("workDir" in binding)) return true;
      return (binding.workDir ?? "") !== (session.workspace?.path ?? "");
    });

    // Register what the registry does not know yet through the CREATE endpoint.
    // The bulk migration cannot be used here: it answers `{status:"skipped"}`
    // with NO conversationId when nothing changed, so a session whose cloud
    // record already existed could never be mapped locally — it stayed
    // registered in the cloud and invisible on the phone. The create endpoint
    // always answers with the record's id: `data.id` for a new record, or the
    // 14295 shortcut (id == sessionId) for one that is already there.
    let throttles = 0;
    for (const session of unbound) {
      // The registry keys a local conversation on a UUID and answers
      // {status:"skipped", reason:"invalid_field"} for anything else, so an id
      // like the loop runner's `loop-demo-reminder-<hex>` can never be
      // registered. Attempting it only burns the creation rate limit — 429
      // code 14003, "retry after 60 seconds" — and starves the sessions that
      // could have been registered.
      if (!UUID_SESSION_ID.test(this.registrySessionId(session.id))) continue;
      const workspace = session.workspace ?? null;
      const title = this.titleForSession(session);
      const workDir = workspace?.path ?? "";
      let conversationId;
      try {
        conversationId = await createCloudConversation(this.session, {
          sessionId: this.registrySessionId(session.id),
          title,
          deviceId: this.deviceId,
          workDir,
          isPlayground: workspace ? 0 : 1,
          model: session.model,
        });
      } catch (error) {
        // The registry throttles creation (429 / code 14003). Wait it out while
        // the budget lasts, then stop registering for this boot and let the next
        // one carry on: the records already created are kept either way.
        if (/14003|429/.test(error.message) && throttles < REGISTER_THROTTLE_BUDGET) {
          throttles += 1;
          this.noteCommand("register", false, "throttled; waiting 61s", `session=${String(session.id).slice(0, 26)}`);
          await this.sleep(REGISTER_THROTTLE_MS);
          continue;
        }
        logger.warn(`[agentos-remote] could not register ${session.id}: ${error.message}`);
        this.noteCommand("register", false, error.message, `session=${String(session.id).slice(0, 26)}`);
        continue;
      }
      const binding = this.bindings.set({
        sessionId: session.id,
        conversationId,
        cwd: session.cwd ?? "",
        workDir,
        workspaceId: workspace?.id ?? null,
        title,
        model: session.model ?? null,
        conversationOrigin: session.isBackgroundAutomation ? "local_scheduler" : session.projectId ? "local_teams" : "legacy_workbuddy_local",
        projectId: session.projectId ?? null,
        projectionVersion: PROJECTION_VERSION,
        createdAt: session.createdAt ?? null,
        updatedAt: session.updatedAt ?? null,
      });
      this.conversations.set(binding.sessionId, binding);
      await this.publishConversationBroadcast(conversationCreatedPayload(this.deviceId, {
        conversationId: binding.conversationId,
        sessionId: binding.sessionId,
        title: binding.title,
        workDir: binding.workDir,
        model: binding.model,
        conversationOrigin: binding.conversationOrigin,
        projectId: binding.projectId,
      }), logger);
    }

    // Repair what an earlier build wrote wrong.
    //
    // The update endpoint — not the bulk migration — is what repairs a record:
    // the migration answers `{status:"updated"}` while leaving `workDir` and
    // `updatedAt` untouched (measured against the live registry), whereas
    // `POST /conversations/{id}` really applies `title`, and `isPlayground: 1`
    // really clears a `workDir` a previous build wrote. A session that belongs to
    // a workspace keeps whatever cwd its record already carries: the endpoint
    // ignores a non-empty `workDir`, so only a create can write one, which is
    // what the unbound path above does for a record that does not exist yet.
    if (stale.length) {
      const failed = [];
      for (const item of stale) {
        const binding = this.bindings.getBySession(item.id);
        const workDir = item.workspace?.path ?? "";
        const title = this.titleForSession(item);
        try {
          await mutateCloudConversation(this.session, binding.conversationId, "rename", { title, isPlayground: workDir ? 0 : 1 });
        } catch (error) {
          failed.push(item);
          this.noteCommand("refresh", false, error.message, `session=${String(item.id).slice(0, 26)}`);
          continue;
        }
        const updated = this.bindings.set({
          ...binding,
          sessionId: item.id,
          workDir,
          workspaceId: item.workspace?.id ?? null,
          title,
          projectionVersion: PROJECTION_VERSION,
        });
        this.conversations.set(updated.sessionId, updated);
        // The app caches a conversation's space from the event that announced it
        // and does not re-derive it from the record, so a conversation whose
        // space changed has to be re-announced — otherwise the phone keeps
        // showing the space an earlier build put it in.
        await this.publishConversationBroadcast(conversationUpdatedPayload(this.deviceId, {
          conversationId: updated.conversationId,
          sessionId: updated.sessionId,
          title,
          workDir,
          conversationOrigin: updated.conversationOrigin,
          projectId: updated.projectId,
        }), logger);
      }
      // A record the registry no longer holds (14284) is recreated by the bulk
      // migration, which is also the path that registers a session whose id
      // spelling changed.
      if (failed.length) {
        await migrateLegacySessions(this.session, this.deviceId, failed.map((item) => ({
          sessionId: this.registrySessionId(item.id),
          title: this.titleForSession(item),
          cwd: item.workspace?.path ?? "",
          status: item.status,
          createdAtMs: item.createdAt,
          updatedAtMs: item.updatedAt,
          lastActivityAtMs: item.lastActivityAt,
          isBackgroundAutomation: item.isBackgroundAutomation,
          projectId: item.projectId,
          model: item.model,
        })));
      }
    }
    this.sessionsMigrated = sessions.length;
    this.sessionsPending = unbound.length + stale.length;
    logger.info(`[agentos-remote] session sync: ${sessions.length} local session(s), ${unbound.length} registered, ${stale.length} refreshed`);
  }

  async enrollDevice(logger) {
    // The registry displayName and the panel/deviceName must agree — passing
    // the bare hostname here renamed the device to collide with the desktop's.
    const deviceName = this.config.deviceName || defaultDeviceName();
    const credentials = await fetchDeviceCredentials(this.session, { deviceId: this.deviceId, deviceName });
    const channels = Object.keys(credentials.subscriptionTokens);
    logger.info(`[agentos-remote] device credentials: keyVersion=${credentials.keyVersion ?? "?"} channels=${channels.join(",") || "(none)"}`);
    await this.subscribeDevice(credentials, logger);
    this.deviceEnrolled = true;
    this.publishDevicePresence("device.online", logger);
    this.startDeviceHeartbeat(logger, heartbeatIntervalOf(credentials));
    if (!this.migrationStarted) {
      this.migrationStarted = true;
      this.restoreCloudMappings(logger)
        // A failed restore must not skip the migration: the two are independent,
        // and the previous chain lost every local binding because the (missing)
        // registry list threw before the migration ever ran.
        .catch((error) => logger.warn(`[agentos-remote] cloud mapping restore failed: ${error.message}`))
        .then(() => this.migrateLocalSessions(logger))
        .then(() => this.pruneStaleConversations(logger))
        .catch((error) => { this.lastSyncError = error.message; logger.warn(`[agentos-remote] session sync failed: ${error.message}`); });
    }
    try {
      const snapshot = await fetchOnlineDevices(this.session);
      this.deviceOnline = isDeviceOnline(snapshot, this.deviceId);
      logger.info(`[agentos-remote] device registry: ${snapshot.devices.length} device(s), this one ${this.deviceOnline ? "online" : "not listed yet"}`);
    } catch (error) {
      // The snapshot is diagnostic. Enrollment itself already succeeded, and the
      // registry can lag the first heartbeat by a moment.
      logger.warn(`[agentos-remote] device registry check failed: ${error.message}`);
    }
  }

  /** Connect to the device Centrifugo and subscribe each granted channel. */
  async subscribeDevice(credentials, logger) {
    const { Centrifuge } = await import("centrifuge");
    const { default: WebSocket } = await import("ws");
    this.disconnectDeviceSocket();
    const commandChannel = `executor:${this.deviceId}`;
    await new Promise((resolve, reject) => {
      const client = new Centrifuge(credentials.cfWsUrl, { token: credentials.connectToken, websocket: WebSocket });
      const subscriptions = [];
      let pending = Object.keys(credentials.subscriptionTokens).length;
      if (pending === 0) {
        reject(new Error("device credentials granted no channels"));
        return;
      }
      const fail = (error) => {
        if (pending < 0) return;
        pending = -1;
        reject(error);
      };
      for (const [channel, token] of Object.entries(credentials.subscriptionTokens)) {
        const sub = client.newSubscription(channel, token ? { token } : undefined);
        if (channel === commandChannel) {
          // Commands arrive as encrypted envelope parts. Parts of one delivery
          // share a msgId; assemble on completion and dispatch the plaintext.
          sub.on("publication", (pub) => {
            Promise.resolve(this.onExecutorPublication(pub?.data, logger)).catch((error) => {
              this.lastError = `executor message: ${error.message}`;
              logger.warn(`[agentos-remote] executor message failed: ${error.message}`);
            });
          });
        }
        sub.on("subscribed", () => {
          logger.info(`[agentos-remote] device channel subscribed: ${channel}`);
          if (--pending === 0) resolve();
        });
        sub.on("error", (ctx) => fail(new Error(`device subscribe ${channel} failed: ${JSON.stringify(ctx)}`)));
        subscriptions.push(sub);
      }
      client.on("connected", (ctx) => logger.info(`[agentos-remote] device link connected client=${ctx.client}`));
      client.on("disconnected", (ctx) => {
        // Cleared so the next pass of the connect loop re-enrolls instead of
        // assuming a device link that has already gone away.
        this.deviceEnrolled = false;
        logger.warn(`[agentos-remote] device link disconnected: ${JSON.stringify(ctx)}`);
      });
      client.on("error", (ctx) => fail(new Error(`device link error: ${JSON.stringify(ctx)}`)));
      for (const sub of subscriptions) sub.subscribe();
      client.connect();
      this.deviceCentrifuge = client;
      this.deviceSubscriptions = subscriptions;
      this.deviceCredentials = credentials;
    });
  }

  /** Announce presence. No-op until the presence channel is subscribed. */
  publishDevicePresence(type, logger) {
    const channel = devicePresenceChannel(this.session?.account?.uid);
    const sub = this.deviceSubscriptions?.find((entry) => entry.channel === channel);
    try {
      const result = sub?.publish(devicePresencePayload(type, this.deviceId, DEVICE_CLIENT_TYPE));
      if (result?.then) {
        result.then(() => {
          this.presenceBeats = (this.presenceBeats ?? 0) + 1;
          this.lastPresenceBeatAt = Date.now();
        }).catch((error) => {
          this.presenceFailures = (this.presenceFailures ?? 0) + 1;
          this.lastError = `presence publish: ${error.message}`;
          logger?.warn?.(`[agentos-remote] presence publish failed: ${error.message}`);
        });
      } else if (!sub) {
        this.presenceFailures = (this.presenceFailures ?? 0) + 1;
        logger?.warn?.(`[agentos-remote] presence channel not subscribed; ${type} not sent`);
      }
    } catch (error) {
      this.presenceFailures = (this.presenceFailures ?? 0) + 1;
      this.lastError = `presence publish: ${error.message}`;
      logger?.warn?.(`[agentos-remote] presence publish failed: ${error.message}`);
    }
  }

  /** Re-assert `device.online` on the server-mandated cadence while the link is up. */
  startDeviceHeartbeat(logger, intervalMs = DEVICE_HEARTBEAT_MS) {
    this.stopDeviceHeartbeat();
    this.deviceHeartbeat = setInterval(() => {
      if (this.stopped || !this.deviceEnrolled) return;
      this.publishDevicePresence("device.online", logger);
      logger.debug?.(`[agentos-remote] device heartbeat sent (every ${Math.round(intervalMs / 1000)}s)`);
    }, intervalMs);
  }

  stopDeviceHeartbeat() {
    if (this.deviceHeartbeat) clearInterval(this.deviceHeartbeat);
    this.deviceHeartbeat = null;
  }

  /** Drop the device socket only. The heartbeat keeps running across a reconnect. */
  disconnectDeviceSocket() {
    try { this.deviceCentrifuge?.disconnect(); } catch {}
    this.deviceCentrifuge = null;
    this.deviceSubscriptions = null;
  }

  stopDeviceSocket() {
    this.stopDeviceHeartbeat();
    this.disconnectDeviceSocket();
    this.deviceEnrolled = false;
  }

  async subscribe(data, logger) {
    const { Centrifuge } = await import("centrifuge");
    const { default: WebSocket } = await import("ws");
    // Drop the previous link before opening a new one: re-registration on
    // connectionToken expiry (7d TTL) must not leak the old socket.
    this.stopSocket();
    await new Promise((resolve, reject) => {
      const c = new Centrifuge(data.url, { token: data.connectionToken, websocket: WebSocket });
      // registerWorkspace issues a per-channel token alongside the connection
      // token, and WorkBuddy Desktop subscribes WITH it. Subscribing anonymously
      // (no token) is the one call the desktop never makes.
      const sub = c.newSubscription(
        data.channel,
        data.subscriptionToken ? { token: data.subscriptionToken } : undefined,
      );
      sub.on("publication", (pub) => {
        Promise.resolve(this.onTask(pub?.data)).catch((error) => {
          logger.warn(`[agentos-remote] task failed: ${error.message}`);
          this.publish(data, { kind: "task-error", error: error.message });
        });
      });
      sub.on("subscribed", () => { this.subscribed = true; logger.info(`[agentos-remote] subscribed: ${data.channel}`); resolve(); });
      sub.on("unsubscribed", (ctx) => { this.subscribed = false; logger.warn(`[agentos-remote] unsubscribed: ${JSON.stringify(ctx)}`); });
      c.on("connected", (ctx) => logger.info(`[agentos-remote] connected client=${ctx.client}`));
      c.on("disconnected", (ctx) => logger.warn(`[agentos-remote] disconnected: ${JSON.stringify(ctx)}`));
      c.on("error", (ctx) => logger.warn(`[agentos-remote] client error: ${JSON.stringify(ctx)}`));
      sub.subscribe();
      c.connect();
      this.centrifuge = c;
      this.subscription = sub;
      this.wsData = data;
    });
  }

  stopSocket() {
    try { this.centrifuge?.disconnect(); } catch {}
    this.centrifuge = null;
    this.subscription = null;
    this.subscribed = false;
  }

  publish(_data, payload) {
    try { this.subscription?.publish({ ...payload, source: "dsh-agentos-remote", at: Date.now() }); } catch {}
  }

  /**
   * One publication on the executor channel: an encrypted envelope part
   * carrying (a piece of) one app command. Parts are buffered per msgId and
   * dispatched once the delivery is complete. Batch containers fan out into
   * individual commands, mirroring the desktop's message pump.
   */
  async onExecutorPublication(data, logger) {
    if (!data || typeof data !== "object" || typeof data.msgId !== "string") return;
    this.executorPublications = (this.executorPublications ?? 0) + 1;
    const keys = resolveChannelKeys(this.deviceCredentials, `executor:${this.deviceId}`);
    if (!keys) throw new Error("no decryption keys for the executor channel");
    const parts = (this.envelopeBuffer.get(data.msgId) ?? []).concat(data);
    if (parts.length < data.partTotal) {
      this.envelopeBuffer.set(data.msgId, parts);
      return;
    }
    this.envelopeBuffer.delete(data.msgId);
    const payload = await assembleEnvelopes(parts, keys.enc, keys.sig);
    this.executorAssembled = (this.executorAssembled ?? 0) + 1;
    const commands = isBatchContainer(payload) ? payload.items : [payload];
    for (const command of commands) {
      await this.onDeviceCommand(command, logger);
    }
  }

  /**
   * One app command.
   *
   * The app sends command objects (`session.create`, `prompt.submit`,
   * `get_models`, `session.set_model`, ...) and reads the answer from the
   * command's `replyChannel`. A publication that is instead an AgentOS task
   * (a `prompt` without a command `type`) keeps the original task path.
   */
  async onDeviceCommand(data, logger) {
    if (!data || typeof data !== "object") return;
    if (typeof data.type !== "string") {
      await this.onTask(data);
      return;
    }
    let result;
    try {
      result = await this.dispatchCommand(data, logger);
      this.noteCommand(data.type, true, undefined, this.commandDetail(data, result));
    } catch (error) {
      logger.warn(`[agentos-remote] ${data.type} failed: ${error.message}`);
      const stack = String(error.stack || "").split("\n").slice(1, 4).map((line) => line.trim()).join(" | ");
      this.noteCommand(data.type, false, `${error.message} :: ${stack}`, this.commandDetail(data, undefined));
      result = { success: false, error: error.message };
    }
    if (data.replyChannel && result !== undefined) {
      await this.publishEncryptedReply(data.replyChannel, result, logger);
    }
  }

  /** Rolling record of recent commands — the only window into dispatch failures. */
  noteCommand(type, ok, error, detail) {
    if (!Array.isArray(this.commandLog)) this.commandLog = [];
    this.commandLog.push({ at: new Date().toISOString(), type, ok, error: error ?? null, ...(detail ? { detail } : {}) });
    if (this.commandLog.length > 60) this.commandLog.shift();
  }


  /**
   * A compact, non-secret summary of one command for the rolling log.
   *
   * Ids and counts only — never prompt text or a credential. The point is that a
   * mismatch between what the app asks for and what the host resolves (the app
   * sending an id field we do not read, say) is visible from the status panel
   * instead of being guesswork.
   */
  commandDetail(command, result) {
    const parts = [];
    for (const key of ["commandId", "requestId", "id"]) {
      if (typeof command?.[key] === "string") parts.push(`${key}=${command[key].slice(0, 40)}`);
    }
    if (typeof command?.sessionId === "string") parts.push(`asked=${command.sessionId.slice(0, 40)}`);
    if (typeof command?.conversationId === "string") parts.push(`conv=${command.conversationId.slice(0, 40)}`);
    if (typeof command?.cursor?.seq === "number") parts.push(`cursor=${command.cursor.seq}`);
    if (typeof command?.limit === "number") parts.push(`limit=${command.limit}`);
    if (typeof result?.sessionId === "string") parts.push(`resolved=${result.sessionId.slice(0, 40)}`);
    if (typeof result?.conversationId === "string") parts.push(`resolvedConv=${result.conversationId.slice(0, 40)}`);
    if (Array.isArray(result?.messages)) parts.push(`messages=${result.messages.length}`);
    if (Array.isArray(result?.items)) parts.push(`items=${result.items.length}`);
    // The app's own filters decide which conversations it is willing to show,
    // so a list that comes back wrong is usually an argument this side reads
    // under a different name. Recording the SHAPE of what arrived (field names,
    // page numbers, the space it scoped to) is what makes that visible; the
    // values are ids and paths, never prompt text or a credential.
    const args = Array.isArray(command?.args) ? command.args[0] : undefined;
    if (args && typeof args === "object") {
      parts.push(`args=${Object.keys(args).slice(0, 14).join(",") || "(empty)"}`);
      if (Number.isInteger(args.page)) parts.push(`page=${args.page}`);
      if (Number.isInteger(args.size)) parts.push(`size=${args.size}`);
      if (typeof args.state === "string") parts.push(`state=${args.state}`);
      if (typeof args.workspacePath === "string") parts.push(`wsPath=${args.workspacePath.slice(0, 60)}`);
      if (args.space?.type) parts.push(`spaceType=${String(args.space.type).slice(0, 20)}`);
      if (args.space?.cwd) parts.push(`spaceCwd=${String(args.space.cwd).slice(0, 60)}`);
    }
    return parts.length ? parts.join(" ") : undefined;
  }

  /**
   * Answer a command on its reply channel: encrypt with that channel's key
   * pair and POST each envelope part to the APISIX publish endpoint — replies
   * never go out as plaintext, and the reply scope is HTTP-only.
   */
  async publishEncryptedReply(replyChannel, result, logger) {
    const keys = resolveChannelKeys(this.deviceCredentials, replyChannel);
    if (!keys) {
      logger.warn(`[agentos-remote] no keys for reply channel ${replyChannel}; reply dropped`);
      return;
    }
    const credentials = this.deviceCredentials;
    const envelopes = packEnvelopes(result, keys.enc, keys.sig, keys.keyVersion, {
      senderDeviceId: this.deviceId,
    });
    for (const envelope of envelopes) {
      await publishEnvelopeHttp(envelope, {
        url: credentials.apisixPublishUrl,
        channel: replyChannel,
        userId: this.session?.account?.uid,
        publishToken: credentials.publishToken,
      });
    }
  }

  /**
   * Broadcast a `conversation.*` event on the per-user conversations channel:
   * encrypted like every non-presence publish, delivered through the APISIX
   * endpoint the app's devices listen through. `event` is the complete
   * envelope payload (eventId/type/deviceId/ts already set by the caller).
   */
  async publishConversationBroadcast(event, logger) {
    const channel = conversationsChannel(this.session?.account?.uid);
    const keys = resolveChannelKeys(this.deviceCredentials, channel);
    if (!keys) {
      logger.warn(`[agentos-remote] no keys for ${channel}; broadcast dropped`);
      return;
    }
    const credentials = this.deviceCredentials;
    const envelopes = packEnvelopes(event, keys.enc, keys.sig, keys.keyVersion, {
      senderDeviceId: this.deviceId,
      eventType: event.type,
    });
    for (const envelope of envelopes) {
      await publishEnvelopeHttp(envelope, {
        url: credentials.apisixPublishUrl,
        channel,
        userId: this.session?.account?.uid,
        publishToken: credentials.publishToken,
      });
    }
    this.broadcastsSent = (this.broadcastsSent ?? 0) + 1;
  }

  /**
   * Push one conversation event to the app on `convmsg:{uid}`. Captured from
   * the desktop's live stream: the payload is an ACP JSON-RPC notification —
   * `{jsonrpc, method:"session/update", params:{sessionId, update}, conversationId}` —
   * NOT a bare update object (the app's message pump drops those silently).
   */
  async publishSessionUpdate(conversationId, sessionId, update, logger) {
    const channel = `convmsg:${this.session?.account?.uid}`;
    const keys = resolveChannelKeys(this.deviceCredentials, channel);
    if (!keys) {
      logger.warn(`[agentos-remote] no keys for ${channel}; message dropped`);
      return;
    }
    const notification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
      conversationId,
    };
    const seq = this.nextSessionSeq(sessionId);
    const envelopes = packEnvelopes(notification, keys.enc, keys.sig, keys.keyVersion, {
      seq,
      senderDeviceId: this.deviceId,
    });
    for (const envelope of envelopes) {
      await publishEnvelopeHttp(envelope, {
        url: this.deviceCredentials.apisixPublishUrl,
        channel,
        userId: this.session?.account?.uid,
        publishToken: this.deviceCredentials.publishToken,
      });
    }
    this.messagesSent = (this.messagesSent ?? 0) + 1;
  }

  /** A message-chunk update in the shape the app renders. */
  messageChunkUpdate(sessionUpdate, messageId, text) {
    return {
      sessionUpdate,
      messageId,
      content: { type: "text", text },
      _meta: { "codebuddy.ai": { messageId, chunkSeq: 0, isHistoryReplay: false, timestamp: Date.now() } },
    };
  }

  /**
   * The turn-phase signal the app's "thinking" spinner follows (captured from
   * the desktop): a session_info_update whose meta names the agent phase. The
   * app stays on the spinner until it sees phase "idle" after the chunks.
   */
  agentPhaseUpdate(phase) {
    return {
      sessionUpdate: "session_info_update",
      _meta: {
        "codebuddy.ai/agentPhase": { phase, startedAt: Date.now() },
        "codebuddy.ai/requestId": randomUUID(),
      },
    };
  }

  /** Add monotonic chunkSeq values for the ACP message types that stream. */
  chunkSeqUpdates(updates, isHistoryReplay = false, sessionId = "") {
    const sequences = new Map();
    return (updates ?? []).map((update) => {
      if (!update || !["agent_message_chunk", "agent_thought_chunk", "assistant_message_chunk"].includes(update.sessionUpdate)) {
        return update;
      }
      const messageId = update.messageId || update._meta?.["codebuddy.ai"]?.messageId || "message";
      const chunkSeq = sequences.get(messageId) ?? 0;
      sequences.set(messageId, chunkSeq + 1);
      return {
        ...update,
        _meta: {
          ...(update._meta ?? {}),
          "codebuddy.ai": {
            ...(update._meta?.["codebuddy.ai"] ?? {}),
            messageId,
            chunkSeq,
            isHistoryReplay,
            timestamp: Date.now(),
          },
        },
      };
    });
  }

  enqueueSessionUpdate(sessionId, conversationId, update, logger) {
    if (!this.publishQueues) this.publishQueues = new Map();
    const previous = this.publishQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => this.publishSessionUpdate(conversationId, sessionId, update, logger));
    this.publishQueues.set(sessionId, next.catch((error) => {
      logger.warn(`[agentos-remote] stream push failed: ${error.message}`);
    }));
    return next;
  }

  /** Forward durable DSH events while a shared session controller turn runs. */
  watchTurn(sessionId, binding, logger, startSeq) {
    if (!this.turnWatchers) this.turnWatchers = new Map();
    if (this.turnWatchers.has(sessionId)) throw new Error(`a turn is already being watched for session ${sessionId}`);
    const agent = this.ctx.agents?.get?.(sessionId);
    const cursor = startSeq ?? agent?.session?.seq ?? null;
    const watcher = { sessionId, binding, logger, startSeq: startSeq ?? cursor, cursor, timer: null, active: false, promptPending: false, polling: false, terminalUpdate: null, missingPolls: 0, streamed: new Map() };
    this.turnWatchers.set(sessionId, watcher);
    return watcher;
  }

  prepareTurnWatcher(watcher) {
    if (!watcher) return;
    watcher.active = true;
    watcher.promptPending = true;
  }

  activateTurnWatcher(watcher) {
    if (!watcher) return;
    watcher.promptPending = false;
    if (watcher.timer !== null) return;
    watcher.active = true;
    watcher.timer = setInterval(() => void this.pollTurnWatcher(watcher), 100);
  }

  async forwardSessionEvent(session, event) {
    const watcher = this.turnWatchers?.get(String(session?.id));
    if (!watcher?.active || !event || (watcher.startSeq !== null && Number.isFinite(event.seq) && event.seq < watcher.startSeq)) return;
    try {
      const updates = dshEventsToAcpUpdates([event], { streamed: watcher.streamed })
        .map((update) => ({ ...update, sessionId: watcher.sessionId }));
      for (const update of updates) {
        if (update.sessionUpdate === "session_end_turn") watcher.terminalUpdate = update;
        else await this.enqueueSessionUpdate(watcher.sessionId, watcher.binding.conversationId, update, watcher.logger);
      }
    } catch (error) {
      watcher.logger.warn(`[agentos-remote] session event forward failed for ${watcher.sessionId}: ${error.message}`);
    }
  }

  stopTurnWatcher(watcher) {
    if (!watcher) return;
    clearInterval(watcher.timer);
    watcher.timer = null;
    this.turnWatchers?.delete(watcher.sessionId);
  }

  async pollTurnWatcher(watcher) {
    if (!watcher.active || watcher.timer === null || watcher.promptPending || watcher.polling) return;
    watcher.polling = true;
    const { sessionId, binding, logger } = watcher;
    try {
      const agent = this.ctx.agents?.get?.(sessionId);
      if (!agent?.session) {
        watcher.missingPolls++;
        if (watcher.missingPolls >= 20) this.stopTurnWatcher(watcher);
        return;
      }
      watcher.missingPolls = 0;
      if (agent.status !== "idle" || watcher.promptPending) return;
      this.stopTurnWatcher(watcher);
      await this.enqueueSessionUpdate(sessionId, binding.conversationId, this.agentPhaseUpdate("idle"), logger);
      await this.enqueueSessionUpdate(sessionId, binding.conversationId, watcher.terminalUpdate ?? {
        sessionUpdate: "session_end_turn",
        stopReason: "end_turn",
        _meta: { "codebuddy.ai": { requestId: randomUUID(), timestamp: Date.now() } },
      }, logger);
      await updateConversationActivity(this.session, binding.conversationId, {
        lastActivityAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
    } catch (error) {
      logger.warn(`[agentos-remote] turn watch failed for ${sessionId}: ${error.message}`);
      this.stopTurnWatcher(watcher);
    } finally {
      watcher.polling = false;
    }
  }

  setSessionField() {
    return { success: false, error: "NOT_SUPPORTED: session mode changes are not exposed by this host" };
  }

  conversationIdOf(command) {
    const value = command.args?.[0];
    const id = value?.conversationId ?? value?.sessionId ?? value ?? command.sessionId;
    return this.bindings.getByConversation(id) || this.bindings.getBySession(id);
  }

  async renameConversation(command, logger) {
    const binding = this.conversationIdOf(command);
    const arg = command.args?.[0];
    const title = typeof arg === "object" && arg !== null ? arg.title : command.title;
    if (!binding) return { success: false, error: "NOT_FOUND: conversation binding does not exist" };
    if (typeof title !== "string" || !title.trim()) return { success: false, error: "INVALID_ARGUMENT: title is required" };
    await mutateCloudConversation(this.session, binding.conversationId, "rename", { title: title.trim(), isUserDefinedTitle: 1 });
    this.bindings.set({ ...binding, title: title.trim(), updatedAt: Date.now() });
    await this.publishConversationBroadcast({
      type: "conversation.renamed",
      eventId: randomUUID(),
      deviceId: this.deviceId,
      ts: new Date().toISOString(),
      conversationId: binding.conversationId,
      sessionId: binding.sessionId,
      title: title.trim(),
      cwd: binding.cwd || "",
    }, logger);
    return { success: true, conversationId: binding.conversationId, sessionId: binding.sessionId, title: title.trim() };
  }

  async deleteConversation() {
    return { success: false, error: "NOT_SUPPORTED: deleting a WorkBuddy conversation also requires its session:delete desktop RPC, which this DSH host does not expose" };
  }

  async setConversationArchived(command, archived, logger) {
    const binding = this.conversationIdOf(command);
    if (!binding) return { success: false, error: "NOT_FOUND: conversation binding does not exist" };
    const action = archived ? "archive" : "unarchive";
    await mutateCloudConversation(this.session, binding.conversationId, action);
    this.bindings.set({ ...binding, archived, updatedAt: Date.now() });
    await this.publishConversationBroadcast({
      type: archived ? "conversation.archived" : "conversation.unarchived",
      eventId: randomUUID(),
      deviceId: this.deviceId,
      ts: new Date().toISOString(),
      conversationId: binding.conversationId,
      sessionId: binding.sessionId,
      cwd: binding.cwd || "",
      title: binding.title,
    }, logger);
    return { success: true, conversationId: binding.conversationId, sessionId: binding.sessionId, archived };
  }

  setConversationPinned() {
    return { success: false, error: "NOT_SUPPORTED: pin state is stored in WorkBuddy's local desktop database" };
  }

  /** Monotonic per-session notification order, as the app expects. */
  nextSessionSeq(sessionId) {
    const next = (this.sessionSeq?.get(sessionId) ?? 0) + 1;
    if (!this.sessionSeq) this.sessionSeq = new Map();
    this.sessionSeq.set(sessionId, next);
    return next;
  }

  /**
   * Reclaim cloud records that no longer describe a conversation.
   *
   * The phone's task list is entirely fed by what this plugin registers, so the
   * plugin owns the cleanup: every binding is checked against the host's current
   * truth and its record is DELETED when the session it names is gone, empty, or
   * a delegated child.
   *
   *   - gone: the session log no longer exists, so the record can never be opened
   *     (and nothing else knows it is there — the registry has no list endpoint);
   *   - empty: the sidebar hides a session that never received a message, so the
   *     phone showed a conversation the desktop does not. The local session is
   *     untouched and is registered again as soon as it receives a message;
   *   - child: a subagent session is not a conversation of its own.
   *
   * A conversation the APP opened is kept while it is still empty — the app asked
   * for it and shows it while its first message is being composed.
   */
  async pruneStaleConversations(logger) {
    const sessions = await this.runtime.listSessions();
    // Both id spellings map to the same session: a mapping written by an older
    // build may key a `session-<uuid>` session by its bare uuid, and a strict
    // comparison read those as "gone" and deleted 44 live records.
    const live = new Map();
    for (const session of sessions) for (const form of sessionIdForms(session.id)) live.set(form, session);
    let removed = 0;
    for (const binding of this.bindings.values()) {
      const session = live.get(String(binding.sessionId));
      const orphaned = session === undefined;
      const reclaimable = orphaned || (session.blank && binding.createdBy !== "app");
      if (!reclaimable) continue;
      try {
        await mutateCloudConversation(this.session, binding.conversationId, "delete");
      } catch (error) {
        logger.warn(`[agentos-remote] could not drop the stale conversation ${binding.conversationId}: ${error.message}`);
        continue;
      }
      this.bindings.delete(binding.sessionId);
      this.conversations.delete(binding.sessionId);
      removed += 1;
    }
    this.sessionsPruned = removed;
    if (removed) logger.info(`[agentos-remote] dropped ${removed} stale conversation record(s)`);
  }

  /**
   * The sessions the phone should see.
   *
   * A session the host never put a message in is an empty placeholder, and the
   * sidebar hides those — measured: a workspace holding 14 sessions listed 12,
   * and the two missing were exactly the blank ones. An empty session the APP
   * opened is kept, because the app asked for it and shows it while its first
   * message is still being composed.
   */
  async visibleSessions() {
    const sessions = await this.runtime.listSessions();
    this.sessionsRaw = sessions.length;
    const visible = sessions.filter((session) => !session.blank || Boolean(this.bindings.getBySession(session.id)));
    this.sessionsBlank = sessions.length - visible.length;
    try { this.sessionsProbe = await this.probeSessionSources(); } catch { this.sessionsProbe = null; }
    return visible;
  }

  /**
   * Which context yields the host's full session list.
   *
   * The plugin's own `ctx.sessionQuery` answered 111 sessions where the web UI's
   * `/api/session/list` answered 154. The query merges persisted headers with the
   * LIVE session store, so a scoped instance can see only part of the process;
   * the sidebar is the reference, so this measures the alternatives instead of
   * assuming the plugin's own context is equivalent.
   */
  async probeSessionSources() {
    const out = {};
    const measure = async (label, service) => {
      try {
        const records = await service?.listSessions?.();
        out[label] = Array.isArray(records) ? records.length : null;
      } catch (error) {
        out[label] = `err:${error.message.slice(0, 40)}`;
      }
    };
    await measure("ctx", this.ctx.sessionQuery);
    await measure("root", this.ctx.root?.sessionQuery);
    await measure("get", typeof this.ctx.get === "function" ? this.ctx.get("sessionQuery") : undefined);
    try {
      out.live = this.ctx.sessions?.list?.()?.length ?? null;
      out.rootLive = this.ctx.root?.sessions?.list?.()?.length ?? null;
    } catch (error) {
      out.live = `err:${error.message.slice(0, 40)}`;
    }
    return out;
  }

  /**
   * One conversation as the app sees it.
   *
   * The space follows the HOST's organization, not the session's cwd: the DSH web
   * sidebar groups sessions into workspaces (the registry's `path`/`title`), and a
   * session whose cwd matches no workspace is ungrouped there. Mirroring the raw
   * cwd instead turned one project into several spaces — every session directory
   * and every case variant of a drive letter became its own space on the phone —
   * which is what made the two sides disagree.
   */
  conversationProjection(session, binding) {
    const workspace = session.workspace ?? null;
    return {
      id: session.id,
      sessionId: session.id,
      conversationId: binding?.conversationId || session.id,
      title: binding?.title || session.title || session.id,
      transport: "local",
      origin: "desktop",
      kind: "task",
      conversationOrigin: binding?.conversationOrigin || "legacy_workbuddy_local",
      space: workspace
        ? { type: "workdir", cwd: workspace.path, name: workspace.title || workspace.path, workspaceId: workspace.id }
        : { type: "playground" },
      projectId: binding?.projectId || undefined,
      state: session.status === "running" ? "working" : "idle",
      lifecycle: session.archived || binding?.archived ? "archived" : "active",
      pinned: session.pinned === true,
      createdAt: session.createdAt,
      updatedAt: binding?.updatedAt,
      lastActivityAt: binding?.updatedAt,
      model: binding?.model || null,
    };
  }

  /** Route one app command to the handler that owns it. */
  async dispatchCommand(command, logger) {
    switch (command.type) {
      case "get_models":
        // The app reads `data.models` — the desktop returns its whole product
        // configuration here and the picker renders the models array inside.
        return { success: true, data: { models: publicModelList(this.config.models) } };
      case "get_session_config":
        return { success: true, sessionId: command.sessionId, config: {} };
      case "get_skills":
        return { success: true, data: [] };
      case "get_task_artifacts":
        return { success: true, sessionId: command.sessionId, artifacts: [] };
      case "get_automations":
        return { success: true, snapshot: { automations: [] } };
      case "wb.automations.listRecords":
        return { success: true, records: [], total: 0 };
      case "device.active":
        return { success: true };
      case "wb:workspaces:list": {
        const workspaces = await this.runtime.listWorkspaces();
        const source = command.args?.[0] ?? command;
        const page = Math.max(1, Number.isInteger(source.page) ? source.page : 1);
        const size = Math.max(1, Math.min(500, Number.isInteger(source.size) ? source.size : workspaces.length || 1));
        const start = (page - 1) * size;
        const pageItems = workspaces.slice(start, start + size);
        return {
          success: true,
          items: pageItems,
          total: workspaces.length,
          hasMore: start + size < workspaces.length,
          nextCursor: start + size < workspaces.length ? encodeURIComponent(pageItems.at(-1)?.id ?? "") : null,
        };
      }
      case "wb:conversations:list": {
        const source = command.args?.[0] ?? command;
        const keyword = typeof source.keyword === "string" ? source.keyword.toLowerCase() : "";
        const workspacePath = typeof source.workspacePath === "string" ? source.workspacePath : source.space?.cwd || null;
        const state = typeof source.state === "string" ? source.state : null;
        const conversationOrigin = typeof source.conversationOrigin === "string" ? source.conversationOrigin : null;
        const cursor = typeof source.cursor === "string" ? source.cursor : null;
        const activeCursor = cursor ? decodeURIComponent(cursor) : null;
        const sessions = await this.visibleSessions();
        const items = sessions.flatMap((session) => {
          const binding = this.bindings.getBySession(session.id);
          const title = binding?.title || session.title || session.id;
          const sessionState = session.status === "running" ? "working" : "idle";
          const origin = binding?.conversationOrigin || "legacy_workbuddy_local";
          // The app filters by the space it shows, which is the workspace path
          // when the session belongs to one and the session's own cwd otherwise.
          const workDir = session.workspace?.path ?? session.cwd ?? "";
          if (keyword && !`${title} ${workDir}`.toLowerCase().includes(keyword)) return [];
          if (workspacePath && workDir !== workspacePath) return [];
          if (state && state !== sessionState) return [];
          if (conversationOrigin && conversationOrigin !== origin) return [];
          if (source.projectId && source.projectId !== binding?.projectId) return [];
          if (activeCursor && session.id <= activeCursor) return [];
          return [this.conversationProjection(session, binding)];
        });
        const page = Math.max(1, Number.isInteger(source.page) ? source.page : 1);
        const size = Math.max(1, Math.min(500, Number.isInteger(source.size) ? source.size : 100));
        const start = (page - 1) * size;
        const pageItems = items.slice(start, start + size);
        const nextCursor = start + size < items.length ? encodeURIComponent(pageItems.at(-1)?.sessionId ?? "") : null;
        return { success: true, items: pageItems, total: items.length, hasMore: start + size < items.length, nextCursor, partial: false };
      }
      case "wb:conversations:listByIds": {
        const requested = command.args?.[0] ?? command.ids ?? [];
        const ids = Array.isArray(requested) ? requested : [requested];
        const sessions = await this.visibleSessions();
        return { success: true, items: sessions.flatMap((session) => {
          const binding = this.bindings.getBySession(session.id);
          if (!ids.includes(session.id) && !ids.includes(binding?.conversationId)) return [];
          return [this.conversationProjection(session, binding)];
        }) };
      }
      case "wb:conversations:get": {
        const id = command.args?.[0]?.conversationId || command.args?.[0] || command.sessionId;
        const result = await this.dispatchCommand({ type: "wb:conversations:listByIds", args: [[id]] }, logger);
        return { success: true, item: result.items?.[0] || null };
      }
      case "session.stop":
      case "wb:conversations:cancel": {
        const sessionId = command.sessionId || command.args?.[0]?.conversationId || command.args?.[0];
        if (this.ctx.sessionController?.cancel) await this.ctx.sessionController.cancel({ sessionId });
        else this.ctx.agents?.get?.(sessionId)?.cancel?.({ kind: "user" });
        return { success: true, sessionId };
      }
      case "session.get_mode":
        return { success: true, mode: this.bindings.getBySession(command.sessionId)?.mode || null };
      case "session.set_mode":
        return this.setSessionField(command, "mode");
      case "session.get_permission_mode":
        return { success: true, permissionMode: this.bindings.getBySession(command.sessionId)?.permissionMode || null };
      case "session.set_permission_mode":
        return this.setSessionField(command, "permissionMode");
      case "wb:conversations:rename":
        return this.renameConversation(command, logger);
      case "wb:conversations:delete":
        return this.deleteConversation(command, logger);
      case "wb:conversations:archive":
        return this.setConversationArchived(command, true, logger);
      case "wb:conversations:unarchive":
        return this.setConversationArchived(command, false, logger);
      case "wb:conversations:pin":
        return this.setConversationPinned(command, true, logger);
      case "wb:conversations:unpin":
        return this.setConversationPinned(command, false, logger);
      case "wb:config:preference":
        return { success: true, data: command.args?.[0] === "localTaskPermissionMode" ? "default-sandbox" : null };
      case "get_page": {
        const requestedId = command.sessionId;
        // A binding is a convenience, not a requirement: for a local record the
        // cloud conversationId IS the session id (the registry's own migration
        // response says so), so an unbound conversation still resolves. Requiring
        // a binding made every session the phone lists but this process had not
        // registered come back empty — "picking a history session loads nothing".
        const binding = this.bindings.getBySession(requestedId) || this.bindings.getByConversation(requestedId);
        const sessionId = binding?.sessionId ?? requestedId;
        const conversationId = binding?.conversationId ?? requestedId;
        const page = await this.runtime.page({
          sessionId,
          beforeSeq: command.cursor?.seq,
          maxMessages: command.limit ? Math.min(command.limit, 50) : 50,
        });
        const updates = this.chunkSeqUpdates(
          dshEventsToAcpUpdates(page.records, { isHistoryReplay: true }),
          true,
          sessionId,
        ).map((update) => ({ ...update, sessionId }));
        const messages = updates.map((update) => ({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
          conversationId,
        }));
        return {
          requestId: command.commandId ?? command.requestId ?? command.id,
          conversationId,
          sessionId,
          messages,
          // The reply's array field is not documented anywhere and the app has
          // been observed reading different wrapper shapes per command
          // (`sessionId` at the top level for session.create, `data.models` for
          // get_models). The same array is therefore offered under the plausible
          // names so a history request is never answered with an empty page
          // simply because the field was spelled differently.
          items: messages,
          updates: messages,
          prevCursor: page.hasMore && page.records.length && Number.isFinite(page.records[0].seq)
            ? { seq: page.records[0].seq }
            : null,
          nextCursor: null,
          hasMore: page.hasMore,
        };
      }
      case "session.get_model":
        return { success: true, model: this.modelFor(command.sessionId) };
      case "session.set_model":
        return this.setModel(command, logger);
      case "session.create":
        return this.createConversation(command, logger);
      case "prompt.submit":
        return this.submitPrompt(command, logger);
      default:
        logger.info(`[agentos-remote] command ${command.type} is not handled by this host`);
        return { success: false, error: `${command.type} is not supported` };
    }
  }

  /** The model id in force: the conversation's own, else the app's last choice, else the config default. */
  modelFor(sessionId) {
    return this.conversations.get(sessionId)?.model || this.selectedModel || this.config.model || null;
  }

  /**
   * Provider + model for a DSH agent route.
   *
   * The same model id can exist under more than one provider (the host config
   * lists `deepseek-flash` under both `ssaiproxy` and `ssaihub`), so the id
   * alone is not enough. Each `models` entry may name its `provider`; the entry
   * whose id the app picked supplies both halves. An entry without one falls
   * back to the top-level `provider`.
   */
  routeFor(sessionId) {
    const id = this.modelFor(sessionId);
    return this.routeForModel(id);
  }

  /** Remember the app's model pick. With a sessionId it applies to that conversation only. */
  setModel(command, logger) {
    const model = typeof command.model === "string" ? command.model : null;
    if (command.sessionId && this.conversations.has(command.sessionId)) {
      this.conversations.get(command.sessionId).model = model;
    } else {
      this.selectedModel = model;
    }
    logger.info(`[agentos-remote] model set to ${model || "(default)"}${command.sessionId ? ` for ${command.sessionId}` : ""}`);
    return { success: true, model };
  }

  /**
   * `session.create`: register the task in the cloud conversation list and tell
   * every device about it. Nothing runs yet — the app follows up with a
   * `prompt.submit` carrying the same sessionId.
   */
  async createConversation(command, logger) {
    const sessionId = command.sessionId || randomUUID();
    const cwd = command.cwd || command.workDir || this.workspaceDir;
    const title = (typeof command.title === "string" && command.title.trim()) || "新任务";
    const model = command.model || this.modelFor(sessionId);
    const created = await this.runtime.createSession({ sessionId, cwd, workspaceId: command.workspaceId, ...this.routeForModel(model) });
    const effectiveSessionId = created.sessionId ?? sessionId;
    // A conversation the app opens inside a workspace directory joins that
    // workspace on the host, and reports the WORKSPACE as its space: the phone
    // groups by what the registry says, so reporting the raw cwd here is what
    // produced a space per directory. A cwd outside every workspace stays
    // ungrouped, which is the sidebar's 未分组.
    await this.runtime.attachToWorkspace(effectiveSessionId, cwd);
    const workspace = await this.runtime.workspaceForPath(cwd);
    const workDir = workspace?.path ?? "";
    const conversationId = await createCloudConversation(this.session, {
      sessionId: effectiveSessionId,
      title,
      deviceId: this.deviceId,
      workDir,
      model,
      isPlayground: workspace ? 0 : 1,
      projectId: command.projectId,
      isBackgroundAutomation: command.isBackgroundAutomation,
    });
    const binding = this.bindings.set({ sessionId: effectiveSessionId, conversationId, title, cwd, workDir, workspaceId: workspace?.id ?? null, model, projectId: command.projectId ?? null, createdBy: "app" });
    this.conversations.set(effectiveSessionId, binding);
    await this.publishConversationBroadcast(
      conversationCreatedPayload(this.deviceId, {
        conversationId,
        sessionId: effectiveSessionId,
        title,
        workDir,
        model,
        conversationOrigin: command.isBackgroundAutomation ? "local_scheduler" : command.projectId ? "local_teams" : "legacy_workbuddy_local",
        projectId: command.projectId,
      }),
      logger,
    );
    logger.info(`[agentos-remote] conversation created: ${conversationId} (${title})`);
    return { success: true, sessionId: effectiveSessionId, conversationId };
  }

  routeForModel(id) {
    const entry = (this.config.models ?? []).find((model) => model?.id === id);
    return { provider: entry?.provider || this.config.provider, model: entry?.model || id };
  }

  /**
   * `prompt.submit`: run the prompt through a DSH agent and register it in the
   * cloud list when the app did not create the conversation first.
   */
  async submitPrompt(command, logger) {
    const prompt = promptTextOf(command);
    if (!prompt) return { success: false, error: "prompt.submit carried no text" };
    let sessionId = command.sessionId || randomUUID();
    const model = command.model || this.modelFor(sessionId);
    let binding = this.bindings.getBySession(sessionId) || this.bindings.getByConversation(sessionId);
    let sessionCreated = false;
    if (!binding) {
      const cwd = command.cwd || command.workDir || this.workspaceDir;
      const created = await this.runtime.createSession({
        sessionId,
        cwd,
        workspaceId: command.workspaceId,
        ...this.routeForModel(model),
      });
      sessionId = created.sessionId ?? sessionId;
      sessionCreated = true;
      // Same rule as `session.create`: the conversation joins the workspace its
      // directory belongs to, and reports that workspace as its space.
      await this.runtime.attachToWorkspace(sessionId, cwd);
      const workspace = await this.runtime.workspaceForPath(cwd);
      const workDir = workspace?.path ?? "";
      const conversationId = await createCloudConversation(this.session, {
        sessionId,
        title: command.title || prompt.slice(0, 40),
        deviceId: this.deviceId,
        workDir,
        model,
        isPlayground: workspace ? 0 : 1,
        projectId: command.projectId,
        isBackgroundAutomation: command.isBackgroundAutomation,
      });
      binding = this.bindings.set({
        sessionId,
        conversationId,
        title: command.title || prompt.slice(0, 40),
        cwd,
        workDir,
        workspaceId: workspace?.id ?? null,
        model,
        projectId: command.projectId ?? null,
        createdBy: "app",
      });
      this.conversations.set(sessionId, binding);
      await this.publishConversationBroadcast(conversationCreatedPayload(this.deviceId, {
        conversationId,
        sessionId,
        title: binding.title,
        workDir,
        model,
        conversationOrigin: command.isBackgroundAutomation ? "local_scheduler" : command.projectId ? "local_teams" : "legacy_workbuddy_local",
        projectId: command.projectId,
      }), logger);
    }
    if (command.model && this.ctx.sessionController?.selectModel) {
      await this.ctx.sessionController.selectModel({ sessionId: binding.sessionId, ...this.routeForModel(model) });
      binding = this.bindings.set({ ...binding, model });
      this.conversations.set(binding.sessionId, binding);
    }
    const route = this.routeForModel(model);
    const requestId = command.commandId || command.requestId || randomUUID();
    const content = Array.isArray(command.content) && command.content.length
      ? command.content
      : [{ type: "text", text: prompt }];
    const startSeq = sessionCreated ? 0 : this.ctx.agents?.get?.(binding.sessionId)?.session?.seq ?? null;
    const cid = binding.conversationId;
    const enqueueUpdate = (update) => this.enqueueSessionUpdate(binding.sessionId, cid, update, logger);
    await enqueueUpdate(this.agentPhaseUpdate("model_requesting"));
    const watcher = this.watchTurn(binding.sessionId, binding, logger, startSeq);
    this.prepareTurnWatcher(watcher);
    try {
      await this.runtime.prompt({ sessionId: binding.sessionId, content, requestId, mode: command.mode });
      this.activateTurnWatcher(watcher);
    } catch (error) {
      this.stopTurnWatcher(watcher);
      await enqueueUpdate(this.agentPhaseUpdate("idle"));
      await enqueueUpdate({
        sessionUpdate: "session_end_turn",
        stopReason: "error",
        _meta: { "codebuddy.ai": { requestId, timestamp: Date.now(), error: error.message } },
      }).catch((publishError) => logger.warn(`[agentos-remote] failed to publish turn error: ${publishError.message}`));
      throw error;
    }
    return { success: true, sessionId: binding.sessionId, conversationId: cid, requestId, startSeq };
  }


  /** One inbound app publication -> one DSH agent task -> HTTP reply. */
  async onTask(data) {
    const logger = this.ctx.logger || console;
    if (!data || typeof data !== "object") return;
    const requestId = data.requestId;
    if (this.seenAndTrack(requestId)) {
      logger.info(`[agentos-remote] duplicate task ${requestId} ignored (redelivery)`);
      return;
    }
    const prompt = extractPromptText(data.prompt);
    if (!prompt) {
      logger.warn(`[agentos-remote] task ${requestId ?? "(no id)"} has no prompt; keys=${JSON.stringify(Object.keys(data))}`);
      return;
    }
    const workspaceId = extractWorkspaceId(data, workspaceIdOf(this.workspaceDir));
    logger.info(`[agentos-remote] task ${requestId}: ${prompt.slice(0, 60)}...`);
    const sessionId = data.sessionId || randomUUID();
    const command = {
      sessionId,
      prompt,
      content: [{ type: "text", text: prompt }],
      commandId: requestId || randomUUID(),
      cwd: data.cwd || data.workDir || this.workspaceDir,
      workspaceId,
      title: data.title,
      model: data.model,
      projectId: data.projectId,
      mode: data.mode,
      isBackgroundAutomation: data.isBackgroundAutomation,
    };
    let reply;
    try {
      const accepted = await this.submitPrompt(command, logger);
      reply = await this.runtime.waitForTurn(accepted.sessionId);
      const session = this.ctx.agents?.get?.(accepted.sessionId)?.session;
      const text = extractAssistantText(session, accepted.startSeq ?? 0);
      reply = text || (typeof reply === "string" ? reply : "(no assistant text produced)");
    } catch (error) {
      logger.warn(`[agentos-remote] task ${requestId} failed: ${error.message}`);
      reply = `执行失败: ${error.message}`;
    }
    try {
      await sendResponse(
        this.config.endpoint, this.session, this.hostId,
        workspaceId, requestId, reply, logger,
      );
    } catch (error) {
      // No channel-publish fallback: Centrifugo publish is rejected for local
      // agents (verified), so HTTP is the only uplink. Retry once after a
      // short delay, then give up with a loud log entry.
      logger.warn(`[agentos-remote] reply failed for ${requestId}: ${error.message}`);
      try {
        await new Promise((r) => setTimeout(r, 2000));
        await sendResponse(this.config.endpoint, this.session, this.hostId, workspaceId, requestId, reply, logger);
        logger.info(`[agentos-remote] reply retry succeeded for ${requestId}`);
      } catch (retryError) {
        logger.error(`[agentos-remote] reply retry also failed for ${requestId}: ${retryError.message}`);
      }
    }
  }
};
//#endregion

//#region plugin export
export const name = "dsh-agentos-remote";
/**
 * No hard `inject`: the link degrades gracefully on a host without agent
 * services instead of parking the fiber (a parked fiber fails the whole web
 * boot — the exact failure mode dsh-sidebar-qa documents).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} config
 */
export function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config };
  const logger = ctx.logger || console;
  if (!merged.enabled) {
    logger.info("[agentos-remote] disabled by config");
    return;
  }
  // ctx.plugin() (not `new`) is what wires the Cordis fiber: it invokes
  // [Service.init] on start, collects disposables, and unloads with the host.
  ctx.plugin(AgentosRemoteService, merged);
  // Deliberately no `return ctx.agentosRemote`: that read is fatal here. Cordis
  // resolves a service by walking UP the fiber chain, and `agentosRemote` is
  // provided by the CHILD fiber we just mounted — so it is unreachable from this
  // context and the proxy throws `cannot get property "agentosRemote" without
  // inject`, which takes the whole harness down (boot is all-or-nothing). It
  // would also still be undefined, since the service publishes only once its
  // async init completes. Callers reach the instance via `ctx.agentosRemote`
  // from a context that injects it.
}
export {
  PROJECTION_VERSION,
  AgentosRemoteService,
  readWorkbuddySession,
  registerWorkspace,
  resolveDeviceId,
  fetchDeviceCredentials,
  fetchOnlineDevices,
  createCloudConversation,
  publicModelList,
  promptTextOf,
};
//#endregion
