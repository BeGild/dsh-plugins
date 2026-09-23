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
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { loadCredentials, saveCredentials, CREDENTIALS_FILE } from "./login-core.js";
import { registerLoginUi } from "./login-ui.js";

//#region config
/** Sensible defaults; every field overridable from the patch config. */
const DEFAULTS = {
  enabled: true,
  endpoint: "https://tencent.sso.codebuddy.cn",
  agentType: "cli",
  /** WorkBuddy desktop session file (plain-text JWT accessToken). */
  sessionFile: null,
  /** Directory exposed as a workspace to the mobile app. */
  workspaceDir: null,
  /** Device display name in the mobile app. Default: "{hostname}-DSH". */
  deviceName: null,
  /** Agent route used for app-driven sessions. */
  provider: undefined,
  model: undefined,
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
/** Server-side link health is polled; action=RE_REGISTER_WORKSPACE means re-register now (verified live). */
const LINK_CHECK_MS = 30 * 60 * 1000;
/** Inbound task dedupe window (WorkBuddy parity: messageExpireTime = 3e5). Centrifugo recovery can redeliver. */
const DEDUPE_TTL_MS = 5 * 60 * 1000;
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
async function runTask(ctx, task, workspaceDir, route, publish) {
  const sessionId = randomUUID();
  const prompt = typeof task === "string" ? task : (task?.prompt || task?.text || task?.message || JSON.stringify(task));
  const agentOptions = {};
  if (route.provider) agentOptions.provider = route.provider;
  if (route.model) agentOptions.model = route.model;
  const meta = { cwd: workspaceDir };
  const handle = await ctx.agents.create({ sessionId, meta, agentOptions });
  const agent = handle.agent;
  const startSeq = agent.session?.seq ?? 0;
  if (route.debug) publish({ kind: "task-start", sessionId, cwd: workspaceDir });
  agent.followup({
    content: [{ type: "text", text: prompt }],
    source: { kind: "plugin", plugin: "dsh-agentos-remote" },
  });
  try {
    await agent.whenIdle();
  } catch (error) {
    await handle.dispose();
    throw error;
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
  static inject = ["webServer"]; // web profiles always carry it; the QR login UI rides the same channel the user already reaches

  constructor(ctx, config) {
    super(ctx, "agentosRemote");
    this.config = { ...DEFAULTS, ...(config || {}) };
    this.processed = new Map(); // requestId -> first-seen ts (dedupe, DEDUPE_TTL_MS)
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

  async [Service.init]() {
    const logger = this.ctx.logger || console;
    if (!this.config.enabled) {
      logger.info("[agentos-remote] disabled by config");
      return;
    }
    // Web UI QR login — the only path on a fresh remote machine (no WorkBuddy
    // desktop, no host-side browser). The user already reaches DSH over HTTP;
    // the login page rides that same channel.
    try {
      const webServer = this.ctx.webServer;
      if (webServer?.register) {
        this.disposeLoginUi = registerLoginUi(webServer, (session) => this.onWebLogin(session), logger);
        logger.info("[agentos-remote] login page: /agentos-remote/login");
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
    this.workspaceDir = this.config.workspaceDir || process.cwd();
    logger.info(`[agentos-remote] uid=${session.account.uid} hostId=${this.hostId} workspace=${path.basename(this.workspaceDir)}`);
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
    this.workspaceDir = this.config.workspaceDir || process.cwd();
    this.stopped = false;
    if (!this.loopRunning) {
      this.loopRunning = true;
      this.connectLoop();
    }
  }

  loadHostId() {
    // Host-independent persisted location: the WorkBuddy config dir if it
    // exists, else the user's home. Never touch ctx.* services here — Cordis
    // throws on property access for services this plugin does not inject.
    const base = path.join(os.homedir(), ".workbuddy");
    const file = path.join(base, ".dsh-agentos-host-id");
    try {
      return fs.readFileSync(file, "utf8").trim() || randomUUID();
    } catch {
      const id = randomUUID();
      try {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(file, id);
      } catch {}
      return id;
    }
  }

  stop() {
    this.stopped = true;
    this.loopRunning = false;
    this.stopSocket();
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
        const data = await registerWorkspace(
          this.config.endpoint, this.config.agentType, this.hostId, this.session, this.workspaceDir, logger,
          this.config.deviceName || defaultDeviceName(),
        );
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
        }
        if (this.stopped) return;
        if (!stale) logger.info(`[agentos-remote] connectionToken TTL reached; re-registering`);
        this.stopSocket();
      } catch (error) {
        logger.warn(`[agentos-remote] link error: ${error.message}; retrying in ${REGISTER_RETRY_MS / 1000}s`);
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

  async subscribe(data, logger) {
    const { Centrifuge } = await import("centrifuge");
    const { default: WebSocket } = await import("ws");
    // Drop the previous link before opening a new one: re-registration on
    // connectionToken expiry (7d TTL) must not leak the old socket.
    this.stopSocket();
    await new Promise((resolve, reject) => {
      const c = new Centrifuge(data.url, { token: data.connectionToken, websocket: WebSocket });
      const sub = c.newSubscription(data.channel);
      sub.on("publication", (pub) => {
        Promise.resolve(this.onTask(pub?.data)).catch((error) => {
          logger.warn(`[agentos-remote] task failed: ${error.message}`);
          this.publish(data, { kind: "task-error", error: error.message });
        });
      });
      sub.on("subscribed", () => { logger.info(`[agentos-remote] subscribed: ${data.channel}`); resolve(); });
      sub.on("unsubscribed", (ctx) => logger.warn(`[agentos-remote] unsubscribed: ${JSON.stringify(ctx)}`));
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
  }

  publish(_data, payload) {
    try { this.subscription?.publish({ ...payload, source: "dsh-agentos-remote", at: Date.now() }); } catch {}
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
    let reply;
    try {
      reply = await runTask(this.ctx, prompt, this.workspaceDir, this.config, (p) => this.publish(this.wsData, p));
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
  // The live instance is published as ctx.agentosRemote once init completes
  // (Cordis Service registration). Returned for tests/diagnostics.
  return ctx.agentosRemote ?? null;
}
export { AgentosRemoteService, readWorkbuddySession, registerWorkspace };
//#endregion
