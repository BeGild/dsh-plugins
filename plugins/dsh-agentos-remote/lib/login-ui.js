/**
 * dsh-agentos-remote — Web UI QR login (remote-friendly).
 *
 * Registers DSH webServer routes so the user can complete WeChat-scan login
 * from the DSH web GUI itself — no local browser, no terminal, no WorkBuddy
 * desktop required on the DSH host. This is the path for remote deployments:
 * the user already reaches DSH over HTTP (port forwarding / LAN), so the login
 * page rides the same channel.
 *
 * Routes (all under /agentos-remote/login):
 *   GET /                       self-contained login page (QR + live status)
 *   GET /api/start              create auth state -> { state, authUrl, qr }
 *   GET /api/poll?state=...     server-side token check -> {status}
 *                               (on success: account fetch + credential save)
 */
import QRCode from "qrcode";
import { createAuthState, pollForTokenOnce, fetchAccount, saveCredentials, anonymousHeaders } from "./login-core.js";
const PAGE_PATH = "/agentos-remote/login";
const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH · WorkBuddy 登录</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", sans-serif; display:flex; justify-content:center; padding:32px 16px; margin:0; }
  .card { max-width: 420px; width:100%; border:1px solid #8884; border-radius:14px; padding:28px; text-align:center; }
  h1 { font-size:18px; margin:0 0 6px; } .sub { opacity:.65; font-size:13px; margin-bottom:20px; }
  #qr { width:240px; height:240px; margin:0 auto; border-radius:10px; background:#fff; padding:10px; box-sizing:border-box; }
  #qr img { width:100%; height:100%; image-rendering:pixelated; }
  .url { font-size:12px; word-break:break-all; opacity:.7; margin:14px 0; }
  .status { margin-top:16px; font-size:14px; min-height:20px; }
  .ok { color:#188038; font-weight:600; } .err { color:#c5221f; }
  button { margin-top:14px; padding:8px 18px; border-radius:8px; border:1px solid #8886; background:transparent; cursor:pointer; font-size:13px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#f9ab00; margin-right:6px; animation:p 1s infinite alternate; }
  @keyframes p { to { opacity:.3 } }
</style></head><body>
<div class="card">
  <h1>WorkBuddy 账号登录</h1>
  <div class="sub">微信扫码后,本 DSH 实例即以你的账号远控运行 · 无需安装 WorkBuddy</div>
  <div id="qr">生成二维码中…</div>
  <div class="url" id="url"></div>
  <div class="status" id="status"><span class="dot"></span>等待扫码…</div>
  <button onclick="start()">刷新二维码</button>
</div>
<script>
const S = document.getElementById('status');
function setStatus(html, cls) { S.innerHTML = html; S.className = 'status ' + (cls || ''); }
async function start() {
  setStatus('<span class="dot"></span>生成二维码中…');
  try {
    const r = await fetch('api/start'); const j = await r.json();
    if (!j.ok) throw new Error(j.error || ('HTTP ' + r.status));
    document.getElementById('qr').innerHTML = '<img alt="登录二维码">';
    document.querySelector('#qr img').src = j.qr;
    document.getElementById('url').textContent = j.authUrl;
    setStatus('<span class="dot"></span>等待扫码…');
    poll(j.state);
  } catch (e) { setStatus('初始化失败: ' + e.message, 'err'); }
}
async function poll(state) {
  for (;;) {
    let j;
    try { const r = await fetch('api/poll?state=' + encodeURIComponent(state)); j = await r.json(); }
    catch { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (j.status === 'ok') {
      document.getElementById('qr').innerHTML = '<div style="font-size:64px;padding-top:50px">&#10004;&#65039;</div>';
      setStatus('登录成功:' + (j.nickname || '') + ' · 已保存凭据', 'ok');
      return;
    }
    if (j.status === 'expired') { setStatus('二维码已过期,请点击刷新', 'err'); return; }
    await new Promise(r => setTimeout(r, 2000));
  }
}
start();
</script></body></html>`;

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Wire the login routes onto a DSH webServer service instance.
 * @param {import('@deepseek-ai/dsh-host-webserver').WebServer} webServer
 * @param {(session: object) => void} onSession  called with the fresh session after a successful login
 * @param {{ info?, warn? }} logger
 * @returns dispose function
 */
export function registerLoginUi(webServer, onSession, logger = console) {
  /** state -> { session?, doneAt? } for in-flight logins */
  const pending = new Map();
  const disposers = [];

  disposers.push(webServer.register({
    kind: "exact",
    path: PAGE_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(HTML);
    },
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: `${PAGE_PATH}/api/start`,
    handler: async (_req, res) => {
      try {
        const authState = await createAuthState();
        pending.set(authState.state, { created: Date.now() });
        // GC stale states (> 6 min)
        for (const [k, v] of pending) if (Date.now() - v.created > 6 * 60 * 1000) pending.delete(k);
        const qr = await QRCode.toDataURL(authState.authUrl, { width: 480, margin: 1 });
        json(res, 200, { ok: true, state: authState.state, authUrl: authState.authUrl, qr });
      } catch (error) {
        json(res, 502, { ok: false, error: error.message });
      }
    },
  }));

  disposers.push(webServer.register({
    kind: "prefix",
    path: `${PAGE_PATH}/api/poll`,
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const state = url.searchParams.get("state") ?? "";
      const entry = pending.get(state);
      if (!entry) { json(res, 200, { status: "expired" }); return; }
      try {
        // One poll step (2s budget inside): reuse the login engine's token check.
        const token = await pollForTokenOnce(state, 2000);
        if (!token) { json(res, 200, { status: "pending" }); return; }
        logger.info?.("[agentos-remote] login token received via web UI, fetching account…");
        const { account, accounts } = await fetchAccount(state, token);
        const session = { account, auth: token, accounts };
        saveCredentials(session);
        pending.delete(state);
        onSession?.(session);
        json(res, 200, { status: "ok", nickname: account?.nickname || account?.uid || "" });
      } catch (error) {
        if (entry.failures === undefined) entry.failures = 0;
        if (++entry.failures > 20) pending.delete(state);
        json(res, 200, { status: "pending", error: error.message });
      }
    },
  }));

  // Pre-warm: the login page needs anonymous headers consistent with login-core.
  void anonymousHeaders;
  return () => { for (const d of disposers) { try { d(); } catch {} } };
}
