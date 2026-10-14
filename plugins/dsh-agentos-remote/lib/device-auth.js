/**
 * dsh-agentos-remote — device authentication (WorkBuddy edge-sync parity).
 *
 * The mobile app does not address a machine through the AgentOS workspace
 * registration alone. WorkBuddy Desktop first enrolls the machine in the
 * conversation-sync device registry, and that enrollment is what makes the
 * device show up, stay "online", and become addressable:
 *
 *   1. POST {authBase}/edge-cloud/credentials
 *      body { userId, deviceId, clientType, deviceName, useDefaultScopes,
 *             chSdkVersion, appVersion? }
 *      -> { connectToken, subscriptionTokens:{ [channel]: token }, cfWsUrl,
 *           apisixPublishUrl, keyVersion }
 *      The server decides the channel set; `executor:{deviceId}` (inbound
 *      commands) and `user:{userId}:devices` (presence) are the two that matter.
 *   2. Centrifugo connect to `cfWsUrl` with `connectToken`, subscribe every
 *      returned channel with its own subscription token.
 *   3. Publish `device.online` on `user:{userId}:devices` and repeat it on the
 *      heartbeat. The server's online window is short, so a device that never
 *      heartbeats reads as offline within about a minute.
 *   4. GET {authBase}/console/as/conversation-sync/devices/online
 *      -> the registry snapshot, used to confirm this device actually landed.
 *
 * All of the above is lifted from WorkBuddy's edge-sync extension
 * (resources/extensions/edge-sync/server), which is the only implementation of
 * this path — it is not part of the AgentOS localagent protocol.
 *
 * `deviceId` is a stable per-machine UUID, the same one WorkBuddy keeps in
 * `~/.workbuddy/device-id`. Reusing that file is deliberate: the registry keys
 * devices on it, so a second random id would register a machine the app can
 * never reconcile with the desktop entry that already exists for this box.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anonymousHeaders, AUTH_BASE, CLIENT_UA } from "./login-core.js";

/** channel-sdk version WorkBuddy reports; the server records it per device. */
export const CH_SDK_VERSION = "2.1.5";
/**
 * Fallback heartbeat cadence. The credentials response carries the
 * server-mandated interval (`heartbeatIntervalMs`, 30s observed) and that value
 * wins whenever present — the registry's online window is about a minute, so a
 * slower beat reads as "offline" between beats.
 */
export const DEVICE_HEARTBEAT_MS = 30 * 1000;
/** The registry forgets a device about a minute after its last heartbeat. */
export const DEVICE_ONLINE_WINDOW_MS = 60 * 1000;

/**
 * The heartbeat cadence the server mandated for this device link.
 * Clamped to edge-sync's own bounds (10s min); falls back to 30s.
 */
export function heartbeatIntervalOf(credentials) {
  const ms = Number(credentials?.heartbeatIntervalMs);
  if (Number.isFinite(ms) && ms > 0) return Math.max(ms, 10 * 1000);
  return DEVICE_HEARTBEAT_MS;
}

export const CREDENTIALS_PATH = "/edge-cloud/credentials";
export const DEVICES_ONLINE_PATH = "/console/as/conversation-sync/devices/online";

/** `clientType` the conversation-sync service expects from a desktop-class host. */
export const DEVICE_CLIENT_TYPE = "desktop";

/** Presence channel the app watches for `device.online` / `device.offline`. */
export function devicePresenceChannel(userId) {
  return `user:${userId}:devices`;
}

/** Per-device command channel the app publishes inbound tasks on. */
export function executorChannel(deviceId) {
  return `executor:${deviceId}`;
}

/**
 * The machine's stable device id.
 *
 * Resolution order:
 *   1. `deviceId` config / `DSH_AGENTOS_DEVICE_ID` — an explicit override.
 *   2. `~/.workbuddy/.dsh-agentos-device-id` — this plugin's OWN id file,
 *      created on first use and stable across restarts.
 *
 * Deliberately NOT `~/.workbuddy/device-id` (WorkBuddy Desktop's id): the
 * registry keys devices on this value, so sharing it would make DSH and the
 * desktop fight over one identity — colliding display names, a shared
 * `executor:{id}` command channel, and presence heartbeats from two live
 * processes. A separate id makes DSH appear as its own device.
 *
 * @param {string | null | undefined} explicit
 * @param {{ info?: Function, warn?: Function }} [logger]
 */
export function resolveDeviceId(explicit, logger) {
  const override = explicit || process.env.DSH_AGENTOS_DEVICE_ID;
  if (override) return String(override).trim();

  const file = path.join(os.homedir(), ".workbuddy", ".dsh-agentos-device-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) {
      logger?.info?.(`[agentos-remote] device id from ${file}`);
      return existing;
    }
  } catch {}

  const fresh = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${fresh}\n`);
    logger?.info?.(`[agentos-remote] device id created at ${file}`);
  } catch (error) {
    logger?.warn?.(`[agentos-remote] device id could not be persisted (${error.message}); it will change on restart`);
  }
  return fresh;
}

/** Hostname shown next to the device in the app. */
export function defaultDeviceHostname() {
  return os.hostname?.() || "dsh";
}

/**
 * Request the conversation-sync channel credentials for this device.
 *
 * Mirrors edge-sync `fetchChannelCredentials`: same path, same body, same
 * auth headers as the rest of the plugin. Returns the unwrapped credential
 * object, or throws with the server's status and a short body excerpt.
 *
 * @param {object} session  `{ auth, account }` from the login flow
 * @param {{ deviceId: string, deviceName: string, clientType?: string, appVersion?: string, authBase?: string }} device
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchDeviceCredentials(session, device, fetchImpl = fetch) {
  const url = `${device.authBase || AUTH_BASE}${CREDENTIALS_PATH}`;
  const body = {
    userId: session?.account?.uid || "",
    deviceId: device.deviceId,
    clientType: device.clientType || DEVICE_CLIENT_TYPE,
    deviceName: device.deviceName,
    useDefaultScopes: true,
    chSdkVersion: CH_SDK_VERSION,
    ...(device.appVersion ? { appVersion: device.appVersion } : {}),
  };
  const res = await fetchImpl(url, {
    method: "POST",
    headers: credentialHeaders(session),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`device credentials HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = unwrap(text, "device credentials");
  const missing = ["connectToken", "cfWsUrl"].filter((key) => !data[key]);
  if (missing.length) throw new Error(`device credentials missing field(s): ${missing.join(", ")}`);
  if (!data.subscriptionTokens || typeof data.subscriptionTokens !== "object") {
    throw new Error("device credentials missing subscriptionTokens");
  }
  return data;
}

/**
 * The registry's view of which devices are online.
 * `GET /console/as/conversation-sync/devices/online` -> `{ devices, cacheSource }`.
 *
 * @param {object} session
 * @param {{ authBase?: string }} [options]
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchOnlineDevices(session, options = {}, fetchImpl = fetch) {
  const url = `${options.authBase || AUTH_BASE}${DEVICES_ONLINE_PATH}`;
  const res = await fetchImpl(url, { headers: credentialHeaders(session) });
  const text = await res.text();
  if (!res.ok) throw new Error(`devices/online HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = unwrap(text, "devices/online");
  return {
    devices: Array.isArray(data?.devices) ? data.devices : [],
    cacheSource: data?.cacheSource ?? null,
  };
}

/** True when the registry snapshot lists this device as online. */
export function isDeviceOnline(snapshot, deviceId) {
  return (snapshot?.devices ?? []).some((device) => device?.deviceId === deviceId && device?.online !== false);
}

/**
 * `device.online` / `device.offline` envelope, exactly as edge-sync publishes it
 * on the presence channel.
 */
export function devicePresencePayload(type, deviceId, clientType = DEVICE_CLIENT_TYPE, now = Date.now()) {
  return { type, deviceId, clientType, ts: now };
}

/** Headers for a conversation-sync call: the plugin's auth headers plus the UA. */
function credentialHeaders(session) {
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

/** Accept either a bare payload or the `{ code, data }` envelope the API wraps it in. */
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
