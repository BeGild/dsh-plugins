/**
 * dsh-agentos-remote — the DSH session store as the single source of truth.
 *
 * DSH persists every session at `~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd`
 * (v4 rows, zstd-compressed via node:zlib). The plugin treats those files as
 * the canonical conversation record:
 *
 *   - `listDshSessions()` feeds the startup migration that registers every
 *     local session into the cloud conversation registry, so the phone sees
 *     the same workspaces and sessions as the computer.
 *   - `readDshSession()` + `dshEventsToAcpUpdates()` convert rows into the
 *     ACP sessionUpdate notifications the app renders — history (get_page)
 *     and live turn streaming share one converter, so thoughts, tool calls
 *     and messages look identical live and replayed.
 *
 * The unifying key: the app conversation's sessionId IS the DSH session id
 * (runTask creates/resumes DSH sessions under the app's sessionId), so no
 * separate mapping needs to survive anywhere.
 */
import { decodeStorageRecord } from "./chunk-rows.js";
import { zstdDecompressSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The sessions root, resolved per call so tests can pin a temp home. */
export function sessionsRoot() {
  return path.join(os.homedir(), ".dsh", "sessions");
}
const SESSION_FILE = "session.v4.jsonl.zstd";

/** zstd frame magic, little-endian on disk: every durability flush starts one. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * Decompress a DSH session log.
 *
 * The log is a CONCATENATION of zstd frames — one per durability flush — and
 * Node decodes only the FIRST frame: `zstdDecompressSync` stops at the frame
 * end, and so does `createZstdDecompress()` (measured: a 43 KB log holding 25
 * rows came back as 230 bytes, its header alone). Reading it that way silently
 * loses every event, which is why history replay showed nothing and cold
 * sessions had no title. Each frame is therefore decoded on its own.
 *
 * A frame magic can occur inside compressed bytes, so a slice that fails to
 * decode is not a frame boundary: it is folded into the next slice and retried.
 */
export function decompressSessionLog(buffer) {
  const starts = [];
  for (let i = 0; i + ZSTD_MAGIC.length <= buffer.length; i++) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i);
  }
  if (starts.length <= 1) return zstdDecompressSync(buffer);
  const parts = [];
  let index = 0;
  while (index < starts.length) {
    let decoded;
    let end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
    let next = index + 1;
    for (;;) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(starts[index], end));
        break;
      } catch (error) {
        if (next >= starts.length) throw error;
        next += 1;
        end = next < starts.length ? starts[next] : buffer.length;
      }
    }
    parts.push(decoded);
    index = next;
  }
  return Buffer.concat(parts);
}

/** Every persisted session: { id, dir, file, mtimeMs } — headers read lazily. */
export function listDshSessions() {
  const out = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsRoot(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    let sessions;
    try {
      sessions = fs.readdirSync(path.join(sessionsRoot(), ws.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessions) {
      if (!entry.isDirectory()) continue;
      const file = path.join(sessionsRoot(), ws.name, entry.name, SESSION_FILE);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) out.push({ id: entry.name, dir: path.dirname(file), file, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
  return out;
}

/**
 * The session file for one session id, or null when it does not exist.
 * DSH stores app-created sessions under `session-<uuid>` and plugin-created
 * ones under the bare uuid — both forms resolve here.
 */
export function findDshSessionFile(sessionId) {
  for (const candidate of candidateIds(sessionId)) {
    const file = statSessionFile(candidate);
    if (file) return file;
  }
  return null;
}

/** The id the session store knows this conversation by (with prefix), or null. */
export function resolveDshSessionId(sessionId) {
  for (const candidate of candidateIds(sessionId)) {
    if (statSessionFile(candidate)) return candidate;
  }
  return null;
}

function* candidateIds(sessionId) {
  const safe = String(sessionId ?? "").replace(/[\\/:*?"<>|]/g, "");
  if (!safe) return;
  yield safe;
  if (!safe.startsWith("session-")) yield `session-${safe}`;
}

function statSessionFile(sessionId) {
  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsRoot(), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const file = path.join(sessionsRoot(), ws.name, sessionId, SESSION_FILE);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

/**
 * Decompress and parse one session log.
 * @returns {{ header: object, title: string|null, events: object[] } | null}
 */
export function readDshSession(file) {
  let text;
  try {
    text = decompressSessionLog(fs.readFileSync(file)).toString("utf8");
  } catch {
    return null;
  }
  const events = [];
  let header = null;
  let title = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "session") header = event;
    else if (event?.type === "session/title" && event?.data?.title) title = event.data.title;
    else {
      try {
        events.push(...decodeStorageRecord(event));
      } catch (error) {
        throw new Error(`invalid DSH session storage record: ${error.message}`, { cause: error });
      }
    }
  }
  return header ? { header, title, events } : null;
}

/**
 * Convert DSH session rows into the ACP sessionUpdate notifications the app
 * renders. One row can yield several updates (an assistant message carrying
 * thinking + text blocks becomes a thought chunk and a message chunk).
 * Row types without an app-facing rendering are dropped.
 *
 * @param {object[]} events DSH rows in seq order
 * @param {{ isHistoryReplay?: boolean }} [options]
 */
export function dshEventsToAcpUpdates(events, options = {}) {
  const updates = [];
  const streamed = options.streamed ?? new Map();
  for (const event of events ?? []) {
    if (event?.type !== "assistant/chunk") continue;
    const kind = event.data?.chunk?.type;
    if (kind === "text-delta" || kind === "reasoning-delta") {
      const key = `${kind === "text-delta" ? "text" : "reasoning"}:${event.data.turn}:${event.data.step}`;
      const entry = streamed.get(key);
      streamed.set(key, { seen: true, seq: entry?.seq ?? 0 });
    }
  }
  for (const event of events ?? []) {
    switch (event?.type) {
      case "user/message": {
        const message = event.data;
        // Only a real user turn belongs in the app's transcript. The host
        // injects framework context as user-role messages too, each tagged with
        // its own `source.kind` — the runtime-context snapshot
        // ("Current runtime context. This snapshot supersedes…"), the workspace
        // instructions and skill catalog (both `<system-reminder>` framed),
        // model-selection notes, goal/plan-mode directives and tool-registry
        // updates. Forwarding them shows framework text to the phone as if the
        // user had typed it, and a phone-side check confirmed the app renders
        // them as ordinary messages with no way to tell them apart. WorkBuddy's
        // own client does the same thing the other way round: it strips
        // `<system-reminder>` blocks and drops meta user messages, so framework
        // context never reaches a transcript. A missing `source` (older rows) is
        // forwarded rather than dropped, so a host that omits it cannot silently
        // lose the user's own words.
        const kind = message?.source?.kind;
        if (kind !== undefined && kind !== "user") break;
        const text = textOfBlocks(message?.content);
        if (text) updates.push(chunk("user_message_chunk", message?.id, text, options));
        break;
      }
      case "assistant/message": {
        const message = event.data?.message ?? {};
        const blocks = Array.isArray(message.content) ? message.content : [];
        const thoughts = blocks.filter((block) => block?.type === "thinking").map((block) => block.thinking || block.text).filter(Boolean);
        let thoughtIndex = 0;
        const thoughtKey = `reasoning:${event.data?.turn}:${event.data?.step}`;
        const thoughtEntry = streamed.get(thoughtKey);
        if (thoughts.length && !thoughtEntry?.seen) {
          for (const thought of thoughts) updates.push(chunk("agent_thought_chunk", `${message.id}:t${thoughtIndex++}`, thought, options));
        }
        const text = textOfBlocks(blocks);
        const key = `text:${event.data?.turn}:${event.data?.step}`;
        const textEntry = streamed.get(key);
        if (text && !textEntry?.seen) updates.push(chunk("agent_message_chunk", message.id, text, options));
        break;
      }
      case "assistant/chunk": {
        const delta = event.data?.chunk;
        const type = delta?.type;
        const sessionUpdate = type === "text-delta" ? "agent_message_chunk" : type === "reasoning-delta" ? "agent_thought_chunk" : null;
        const text = typeof delta?.text === "string" ? delta.text : null;
        if (!sessionUpdate || !text) break;
        const key = `${type === "text-delta" ? "text" : "reasoning"}:${event.data?.turn}:${event.data?.step}`;
        const entry = streamed.get(key) ?? { seen: true, seq: 0 };
        streamed.set(key, { seen: true, seq: entry.seq + 1 });
        updates.push(chunkUpdate(sessionUpdate, key, text, { ...options, chunkSeq: entry.seq }));
        break;
      }
      case "turn/end":
        updates.push({
          sessionUpdate: "session_end_turn",
          stopReason: event.data?.reason?.kind === "error" ? "error" : event.data?.reason?.kind === "cancelled" ? "cancelled" : "end_turn",
        });
        break;
      case "tool/call":
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: event.data?.callId,
          title: event.data?.name ?? "",
          status: "pending",
          rawInput: parseMaybeJson(event.data?.arguments),
          rawOutput: "",
        });
        break;
      case "tool/result": {
        const message = event.data?.message ?? {};
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: message.toolCallId ?? message.source?.callId,
          status: "completed",
          rawOutput: textOfBlocks(message.content).slice(0, 4000),
        });
        break;
      }
      default:
        break;
    }
  }
  return updates;
}

/** The app-facing history for a session id: ACP notifications in log order. */
export function dshSessionHistory(sessionId) {
  const stored = resolveDshSessionId(sessionId);
  if (!stored) return null;
  const parsed = readDshSession(statSessionFile(stored));
  if (!parsed) return null;
  return {
    title: parsed.title,
    header: parsed.header,
    events: parsed.events,
    updates: dshEventsToAcpUpdates(parsed.events, { isHistoryReplay: true }),
  };
}

function chunk(sessionUpdate, messageId, text, { isHistoryReplay } = {}) {
  return chunkUpdate(sessionUpdate, messageId, text, { isHistoryReplay });
}

function chunkUpdate(sessionUpdate, messageId, text, { isHistoryReplay, chunkSeq = 0 } = {}) {
  const id = messageId || "message";
  return {
    sessionUpdate,
    messageId: id,
    content: { type: "text", text },
    _meta: { "codebuddy.ai": { messageId: id, chunkSeq, isHistoryReplay: !!isHistoryReplay, timestamp: Date.now() } },
  };
}

function textOfBlocks(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
}

function parseMaybeJson(value) {
  if (typeof value !== "string" || !value) return value ?? "";
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}
