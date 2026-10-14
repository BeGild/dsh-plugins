/**
 * dsh-agentos-remote — conversation sync (WorkBuddy edge-sync parity).
 *
 * The mobile app's task list is not pushed over the AgentOS channel. It is the
 * cloud conversation registry plus a broadcast, both owned by WorkBuddy's
 * edge-sync extension:
 *
 *   - POST {syncBase}/console/as/conversations/v2 creates the cloud record.
 *     The response `data.id` is the conversationId; the app lists whatever is
 *     registered here, so a task that never gets one is invisible.
 *   - After the record lands, a `conversation.created` event is published on
 *     `user:{userId}:conversations`. That channel is subscribed by every device
 *     on the account, and it is what makes the app refresh without polling.
 *     The same channel carries `conversation.updated` / `.renamed` / `.deleted`.
 *   - Inbound commands arrive encrypted? No — the executor channel carries
 *     plain command objects (`session.create`, `prompt.submit`, `get_models`,
 *     `session.set_model`, ...). Each is answered by publishing the handler's
 *     return value on the command's `replyChannel`.
 *
 * `get_models` returns the host's model list with credentials stripped: the
 * app renders `id` / `name` / `vendor` and sends the chosen `id` back as
 * `session.set_model` or as `model` on the next `prompt.submit`.
 */
import { randomUUID } from "node:crypto";
import { anonymousHeaders, AUTH_BASE, CLIENT_UA } from "./login-core.js";

/**
 * Conversation registry base. Distinct from the AgentOS endpoint: verified live,
 * `www.workbuddy.cn` accepts the call while `copilot.tencent.com` answers the
 * identical body with `14295 already exists`.
 */
export const SYNC_BASE = process.env.DSH_AGENTOS_SYNC_BASE || "https://www.workbuddy.cn";

export const CONVERSATIONS_PATH = "/console/as/conversations/v2";
export const CONVERSATION_LIST_PATH = "/console/as/conversation-sync/conversations";
export const LEGACY_MIGRATION_PATH = "/console/as/conversation-sync/migrations/legacy";

/** Broadcast channel every device on the account subscribes to. */
export function conversationsChannel(userId) {
  return `user:${userId}:conversations`;
}

export async function listCloudConversations(session, { deviceId, pageSize = 100, syncBase } = {}, fetchImpl = fetch) {
  const conversations = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ type: "local", pageSize: String(pageSize), includeDeleted: "true" });
    if (deviceId) query.set("sourceDeviceId", deviceId);
    if (cursor) query.set("cursor", cursor);
    const res = await fetchImpl(`${syncBase || SYNC_BASE}${CONVERSATION_LIST_PATH}?${query}`, {
      headers: syncHeaders(session),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`list conversations HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = unwrap(text, "list conversations");
    conversations.push(...(data?.conversations ?? []));
    if (!data?.hasMore || !data?.nextCursor) break;
    cursor = data.nextCursor;
  }
  return conversations;
}

export async function migrateLegacySessions(session, deviceId, sessions, { syncBase } = {}, fetchImpl = fetch) {
  const results = [];
  for (let offset = 0; offset < sessions.length; offset += 500) {
    const batch = sessions.slice(offset, offset + 500);
    const body = {
      migrationId: `${deviceId}-${Date.now()}-${offset / 500}`,
      deviceId,
      schemaVersion: 0,
      forceUpdate: true,
      sessions: batch.map((item) => ({
        sessionId: item.sessionId,
        sourceDeviceId: deviceId,
        conversationTitle: item.title || `会话 ${item.sessionId.slice(0, 8)}`,
        conversationOrigin: item.isBackgroundAutomation ? "local_scheduler" : item.projectId ? "local_teams" : "legacy_workbuddy_local",
        status: item.status || "completed",
        workDir: item.cwd || "",
        createdAtMs: item.createdAtMs ?? Date.now(),
        updatedAtMs: item.updatedAtMs ?? Date.now(),
        lastActivityAtMs: item.lastActivityAtMs ?? item.updatedAtMs ?? Date.now(),
        isPlayground: item.cwd ? 0 : 1,
        clientContext: {
          localStatus: item.status || "completed",
          sessionKind: item.isBackgroundAutomation ? "automation" : "manual",
          model: item.model || "",
          sourceMode: item.sourceMode || "",
          permissionMode: item.permissionMode || "",
          expert: { id: "", locale: "", runtimeIdentity: "", marketplace: "" },
        },
        ...(item.projectId ? { projectId: item.projectId } : {}),
      })),
    };
    const res = await fetchImpl(`${syncBase || SYNC_BASE}${LEGACY_MIGRATION_PATH}`, {
      method: "POST",
      headers: syncHeaders(session),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`legacy migration HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = unwrap(text, "legacy migration");
    results.push(data);
  }
  return results;
}

/**
 * The registry's Go struct declares `isPlayground` as an `int`, but the app
 * sends a boolean on its commands. Passing the boolean straight through is a
 * hard 400 — `json: cannot unmarshal bool into Go struct field
 * CreateConversationV2Request.isPlayground of type int` — so every
 * `session.create` from the phone failed. Coerce at this boundary, which owns
 * the wire format.
 */
function playgroundFlag(value) {
  return value ? 1 : 0;
}

/**
 * Register a task as a cloud conversation.
 *
 * @param {object} session `{ auth, account }`
 * @param {{ sessionId: string, title: string, deviceId: string, workDir?: string,
 *           model?: string, syncBase?: string }} task
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>} the cloud conversationId
 */
export async function createCloudConversation(session, task, fetchImpl = fetch) {
  const now = Date.now();
  const body = {
    type: "local",
    sessionId: task.sessionId,
    name: task.title,
    conversationOrigin: task.conversationOrigin || (task.isBackgroundAutomation ? "local_scheduler" : task.projectId ? "local_teams" : "legacy_workbuddy_local"),
    workDir: task.workDir || "",
    isPlayground: playgroundFlag(task.isPlayground ?? !task.workDir),
    createdAtMs: task.createdAtMs ?? now,
    updatedAtMs: task.updatedAtMs ?? now,
    lastActivityAtMs: task.lastActivityAtMs ?? task.updatedAtMs ?? now,
    clientContext: {
      localStatus: "active",
      hostId: task.deviceId,
      sessionKind: task.sessionKind || (task.isBackgroundAutomation ? "automation" : "manual"),
      model: task.model || "",
      sourceMode: "",
      permissionMode: "",
      expert: task.expert || { id: "", locale: "", runtimeIdentity: "", marketplace: "" },
    },
    ...(task.projectId ? { projectId: task.projectId } : {}),
  };
  const res = await fetchImpl(`${task.syncBase || SYNC_BASE}${CONVERSATIONS_PATH}`, {
    method: "POST",
    headers: syncHeaders(session),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Idempotent hit (409 / code 14295): the registry keys local conversations on
  // sessionId, so the existing record's conversationId IS the sessionId. This
  // is how edge-sync treats the same response — anything else really failed.
  if (res.status === 409 || text.includes("14295")) return task.sessionId;
  if (!res.ok) throw new Error(`create conversation HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = unwrap(text, "create conversation");
  if (!data?.id) throw new Error(`create conversation response missing id: ${text.slice(0, 200)}`);
  return data.id;
}

/**
 * Tell the cloud a conversation's turn has settled (`POST .../conversations/{id}`).
 * The app's "thinking" state clears from this activity update — the message
 * push alone leaves the turn looking in-flight.
 */
export async function updateConversationActivity(session, conversationId, { lastActivityAtMs, updatedAtMs } = {}, fetchImpl = fetch) {
  const body = { lastActivityAtMs: lastActivityAtMs ?? Date.now() };
  if (updatedAtMs) body.updatedAtMs = updatedAtMs;
  const res = await fetchImpl(`${session.syncBase || SYNC_BASE}/console/as/conversations/${encodeURIComponent(conversationId)}`, {
    method: "POST",
    headers: syncHeaders(session),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`activity update HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

export async function mutateCloudConversation(session, conversationId, action, fields = {}, { syncBase } = {}, fetchImpl = fetch) {
  const id = encodeURIComponent(conversationId);
  const base = syncBase || session.syncBase || SYNC_BASE;
  const suffix = action === "delete" ? "/delete" : action === "archive" || action === "unarchive" ? `/${action}` : "";
  if (!suffix && action !== "rename") throw new Error(`unsupported conversation action: ${action}`);
  const url = `${base}/console/as/conversations/${id}${suffix}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: syncHeaders(session),
    ...(action === "delete" || action === "archive" || action === "unarchive" ? { body: "{}" } : { body: JSON.stringify(fields) }),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${action} conversation HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (text.trim()) unwrap(text, `${action} conversation`);
  return true;
}

/**
 * `conversation.*` broadcast envelope, as edge-sync publishes it: a unique
 * eventId plus the originating deviceId so a receiver can ignore its own echo.
 */
export function conversationEvent(type, deviceId, payload, now = new Date()) {
  return { eventId: randomUUID(), type, deviceId, ts: now.toISOString(), ...payload };
}

/** The `conversation.created` payload the app refreshes its list from. */
export function conversationCreatedPayload(deviceId, { conversationId, sessionId, title, workDir, model, conversationOrigin, projectId }) {
  return conversationEvent("conversation.created", deviceId, {
    conversationId,
    sessionId,
    cwd: workDir || "",
    title,
    isPlayground: !workDir,
    createdAt: Date.now(),
    ...(model ? { model } : {}),
    ...(conversationOrigin ? { conversationOrigin } : {}),
    ...(projectId ? { projectId } : {}),
  });
}

/**
 * The `conversation.updated` payload.
 *
 * The app caches a conversation's space from the event that announced it and
 * never re-derives it from the registry, so a record written by an earlier build
 * — one that reported the session's own working directory as the space — keeps
 * showing up under a space named after that directory. Re-announcing the
 * conversation with the space the host actually assigns is the only way to move
 * it, and the title rides along because the update endpoint's field is `title`.
 */
export function conversationUpdatedPayload(deviceId, { conversationId, sessionId, title, workDir, conversationOrigin, projectId }) {
  return conversationEvent("conversation.updated", deviceId, {
    conversationId,
    sessionId,
    cwd: workDir || "",
    title,
    isPlayground: !workDir,
    updatedAt: Date.now(),
    ...(conversationOrigin ? { conversationOrigin } : {}),
    ...(projectId ? { projectId } : {}),
  });
}

/**
 * Model list for `get_models`, shaped like WorkBuddy's `models.json` entries but
 * with `url` and `apiKey` removed — the app only needs identity and capability,
 * and the credentials must not cross to another device.
 *
 * @param {Array<{ id: string, name?: string, vendor?: string, [key: string]: unknown }>} models
 */
export function publicModelList(models) {
  return (models ?? [])
    .filter((model) => model && typeof model.id === "string" && model.id.trim())
    .map((model) => {
      const safe = { ...model };
      delete safe.url;
      delete safe.apiKey;
      return safe;
    });
}

/** Text of a `prompt.submit`, whether it came as `prompt` or as content blocks. */
export function promptTextOf(command) {
  if (typeof command?.prompt === "string" && command.prompt.trim()) return command.prompt.trim();
  if (Array.isArray(command?.content)) {
    const block = command.content.find((entry) => entry?.type === "text" && entry?.text);
    if (block) return String(block.text).trim();
  }
  return "";
}

/** Headers for the conversation registry: the plugin's auth headers plus the UA. */
function syncHeaders(session) {
  const headers = anonymousHeaders();
  delete headers["X-No-Authorization"];
  delete headers["X-No-User-Id"];
  delete headers["X-No-Enterprise-Id"];
  delete headers["X-No-Department-Info"];
  const auth = session?.auth || {};
  const account = session?.account || {};
  if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  if (account.uid) headers["X-User-Id"] = account.uid;
  if (account.enterpriseId) {
    headers["X-Enterprise-Id"] = account.enterpriseId;
    headers["X-Tenant-Id"] = account.enterpriseId;
  }
  if (auth.domain) headers["X-Domain"] = auth.domain;
  headers["User-Agent"] = CLIENT_UA;
  return headers;
}

/** Accept a bare payload or the `{ code, data }` envelope, and surface a non-zero code. */
function unwrap(text, what) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${what} non-JSON response: ${text.slice(0, 200)}`);
  }
  if (json && typeof json === "object" && "code" in json && json.code !== 0 && json.code !== undefined) {
    throw new Error(`${what} code=${json.code} ${json.msg || ""}`.trim());
  }
  return json?.data ?? json;
}
