#!/usr/bin/env node
/**
 * dsh-agentos-remote — interactive WeChat-scan login.
 *
 * Run on ANY machine (WorkBuddy desktop NOT required):
 *   node node_modules/dsh-agentos-remote/login.js
 *
 * Shows a scannable QR + a fallback URL, waits for you to sign in, then
 * saves credentials to ~/.workbuddy/.dsh-agentos-credentials.json.
 * The plugin picks them up on its next start and keeps them fresh via the
 * refresh-token loop.
 */
import * as QRCode from "qrcode";
import { createAuthState, pollForToken, fetchAccount, saveCredentials, CREDENTIALS_FILE } from "./lib/login-core.js";

const log = (...args) => console.log(...args);

log("dsh-agentos-remote — WorkBuddy account login");
log("");

let state;
try {
  state = await createAuthState();
} catch (error) {
  console.error(`Failed to create login state: ${error.message}`);
  process.exit(1);
}

log("1) Open this URL in a browser and sign in (WeChat scan or SSO):");
log("");
log("   " + state.authUrl);
log("");

try {
  const qrTerminal = await QRCode.toString(state.authUrl, { type: "terminal", small: true, margin: 1 });
  log("2) Or scan this QR code with WeChat:");
  log("");
  log(qrTerminal);
} catch {
  log("(QR rendering unavailable — use the URL above)");
}

log("Waiting for sign-in (5 min budget)…");

try {
  const token = await pollForToken(state.state, {
    onPoll: ({ pending }) => {
      if (pending === false) log("Sign-in detected, fetching account…");
    },
  });
  log("Token received.");
  const { account, accounts } = await fetchAccount(state.state, token);
  const file = saveCredentials({ account, auth: token, accounts });
  log("");
  log(`Logged in as: ${account?.nickname || account?.uid || "unknown"} (uid=${account?.uid})`);
  log(`Credentials saved: ${file}`);
  log("The dsh-agentos-remote plugin will use them automatically on next start.");
  process.exit(0);
} catch (error) {
  console.error(`Login failed: ${error.message}`);
  process.exit(1);
}
