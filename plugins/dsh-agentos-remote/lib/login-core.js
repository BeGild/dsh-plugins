/**
 * dsh-agentos-remote — WeChat-scan login engine.
 *
 * Implements WorkBuddy's ExternalLinkAuthenticationProvider flow directly
 * against the live service (all steps verified against copilot.tencent.com):
 *
 *   1. POST /v2/plugin/auth/state?platform=workbuddy   (no auth headers;
 *      X-No-Authorization / X-No-User-Id / X-No-Enterprise-Id / X-No-Department-Info)
 *      -> { state, authUrl }            authUrl is the server-issued login page
 *   2. The user opens authUrl (QR / link) and signs in — WeChat scan included.
 *   3. Poll GET /v2/plugin/auth/token?state={state}   every 1s, 5-min budget,
 *      same X-No-* headers. Returns {accessToken, refreshToken, expiresIn, ...}
 *   4. GET /v2/plugin/login/account?state={state}     with Bearer token
 *      -> account (uid, nickname, ...)
 *   5. GET /v2/plugin/accounts                        account snapshot list
 *
 * The session (account+auth) is persisted to
 *   ~/.workbuddy/.dsh-agentos-credentials.json
 * so the device stays logged in across restarts, and the refresh-token loop
 * (lib/index.js refreshAccessToken) keeps it alive indefinitely.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUTH_BASE = process.env.DSH_AGENTOS_AUTH_BASE || "https://copilot.tencent.com";
export const AUTH_PREFIX = "/v2/plugin";
export const LOGIN_PLATFORM = "workbuddy";
export const POLL_INTERVAL_MS = 1000;
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const CLIENT_UA = "windows/10.0.22631 WorkBuddy/37.10.3";

export const CREDENTIALS_FILE = path.join(os.homedir(), ".workbuddy", ".dsh-agentos-credentials.json");

/** Headers that mark an unauthenticated call (mirrors WorkBuddy's X-No-* convention). */
export function anonymousHeaders(extra = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Product": "SaaS",
    "User-Agent": CLIENT_UA,
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
    ...extra,
  };
}

/** Step 1: create the login state and receive the server-issued authUrl. */
export async function createAuthState(platform = LOGIN_PLATFORM) {
  const res = await fetch(`${AUTH_BASE}${AUTH_PREFIX}/auth/state?platform=${platform}`, {
    method: "POST",
    headers: anonymousHeaders(),
    body: "{}",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth/state HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const data = json?.data ?? json;
  if (!data?.state || !data?.authUrl) throw new Error(`auth/state missing state/authUrl: ${text.slice(0, 200)}`);
  return data; // { state, authUrl }
}

/** Step 3: poll for the auth token until the user completes browser sign-in. */
export async function pollForToken(state, { intervalMs = POLL_INTERVAL_MS, timeoutMs = LOGIN_TIMEOUT_MS, onPoll } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (onPoll) onPoll({});
    try {
      const token = await pollForTokenOnce(state, intervalMs);
      if (token) return token;
    } catch (error) {
      if (onPoll) onPoll({ error });
    }
  }
  throw new Error("login polling timed out (5 min) — restart the login to get a fresh QR");
}

/** One token check (used by both the CLI loop and the web UI's per-request poll). */
export async function pollForTokenOnce(state, timeoutMs = POLL_INTERVAL_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1000));
  try {
    const res = await fetch(`${AUTH_BASE}${AUTH_PREFIX}/auth/token?state=${encodeURIComponent(state)}`, {
      headers: anonymousHeaders(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 404 && text.includes("Route Not Found")) throw new Error(`auth/token route vanished: ${text.slice(0, 120)}`);
    const json = JSON.parse(text);
    const token = json?.data ?? null;
    if (!token?.accessToken) return null;
    token.lastRefreshTime = Date.now();
    // Mirror WorkBuddy's calculateExpiresAt: JWT exp, else expiresIn seconds.
    if (!token.expiresAt) {
      try {
        const payload = JSON.parse(Buffer.from(token.accessToken.split(".")[1], "base64").toString("utf8"));
        if (payload.exp) token.expiresAt = payload.exp * 1000;
      } catch {}
    }
    if (!token.expiresAt && token.expiresIn) token.expiresAt = Date.now() + token.expiresIn * 1000;
    return token;
  } finally {
    clearTimeout(timer);
  }
}

/** Step 4+5: fetch the account bound to the state, then the account snapshot. */
export async function fetchAccount(state, authToken) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Product": "SaaS",
    "User-Agent": CLIENT_UA,
    Authorization: `Bearer ${authToken.accessToken}`,
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
  const res = await fetch(`${AUTH_BASE}${AUTH_PREFIX}/login/account?state=${encodeURIComponent(state)}`, { headers });
  if (!res.ok) throw new Error(`login/account HTTP ${res.status}`);
  const json = await res.json();
  const account = json?.data ?? null;
  const snapshot = await fetchAccountSnapshot(authToken);
  if (snapshot.accounts.length) {
    const match = snapshot.accounts.find((a) => a.lastLogin) || snapshot.accounts.find((a) => a.uid === account?.uid) || snapshot.accounts[0];
    return { account: { ...account, ...match }, accounts: snapshot.accounts };
  }
  return { account, accounts: snapshot.accounts };
}

/** GET /v2/plugin/accounts — full account list snapshot. */
export async function fetchAccountSnapshot(authToken) {
  const res = await fetch(`${AUTH_BASE}${AUTH_PREFIX}/accounts`, {
    headers: {
      Accept: "application/json",
      "X-Product": "SaaS",
      "User-Agent": CLIENT_UA,
      Authorization: `Bearer ${authToken.accessToken}`,
    },
  });
  if (!res.ok) return { accounts: [] };
  const json = await res.json();
  return { accounts: json?.data?.accounts ?? [] };
}

export function loadCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
    if (raw?.auth?.accessToken && raw?.account?.uid) return raw;
  } catch {}
  return null;
}

export function saveCredentials(session) {
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(session, null, 2));
  return CREDENTIALS_FILE;
}

/**
 * Full flow: create state -> (caller shows QR for authUrl) -> poll -> account.
 * `open` is called with { state, authUrl } once the state exists.
 * Resolves with the complete session { account, auth, accounts }.
 */
export async function login({ platform = LOGIN_PLATFORM, open, onPoll, intervalMs, timeoutMs } = {}) {
  const authState = await createAuthState(platform);
  if (open) await open(authState);
  const authToken = await pollForToken(authState.state, { onPoll, intervalMs, timeoutMs });
  const { account, accounts } = await fetchAccount(authState.state, authToken);
  return { account, auth: authToken, accounts };
}
