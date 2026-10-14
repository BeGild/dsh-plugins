import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DshRuntime } from "../lib/dsh-runtime.js";
import { SessionBindings } from "../lib/session-bindings.js";

let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

console.log("dsh-agentos-remote runtime tests\n");

await check("session bindings persist and restore distinct ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-bindings-"));
  const file = path.join(dir, "bindings.json");
  const first = new SessionBindings(file);
  first.set({ sessionId: "session-a", conversationId: "cloud-a", cwd: "E:/a" });
  first.set({ sessionId: "session-b", conversationId: "cloud-b", cwd: "E:/b" });
  const second = new SessionBindings(file);
  assert.equal(second.getBySession("session-a").conversationId, "cloud-a");
  assert.equal(second.getByConversation("cloud-b").sessionId, "session-b");
  fs.rmSync(dir, { recursive: true, force: true });
});

await check("session bindings resolve either id spelling", async () => {
  // DSH mints `session-<uuid>` while the registry — and the app — use the bare
  // uuid, and mappings written by different builds hold either form. A strict
  // comparison made the sync read 44 live sessions as gone and delete their
  // records.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-bindings-"));
  try {
    const file = path.join(dir, "bindings.json");
    const bindings = new SessionBindings(file);
    bindings.set({ sessionId: "session-abc", conversationId: "abc" });
    assert.equal(bindings.getBySession("session-abc").conversationId, "abc");
    assert.equal(bindings.getBySession("abc").conversationId, "abc", "the bare spelling finds it too");
    assert.equal(bindings.getByConversation("abc").sessionId, "session-abc");
    assert.equal(bindings.values().length, 1, "one record, not one per spelling")
    bindings.delete("abc")
    assert.equal(bindings.getBySession("session-abc"), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check("runtime uses session controller and nests model route only through selectModel", async () => {
  const calls = [];
  const runtime = new DshRuntime({
    sessionController: {
      async create(request) { calls.push(["create", request]); return { sessionId: request.sessionId }; },
      async selectModel(request) { calls.push(["selectModel", request]); },
      async prompt(request, signal) { calls.push(["prompt", request, signal]); return { accepted: true }; },
      async page(request, signal) { calls.push(["page", request, signal]); return { records: [], hasMore: false }; },
    },
  });
  await runtime.createSession({ sessionId: "sid", cwd: "E:/dsh", model: "m", provider: "p" });
  await runtime.prompt({ sessionId: "sid", content: [{ type: "text", text: "hi" }], requestId: "r" });
  await runtime.page({ sessionId: "sid" });
  assert.deepEqual(calls.map(([name, request]) => [name, request]), [
    ["create", { sessionId: "sid", cwd: "E:/dsh" }],
    ["selectModel", { sessionId: "sid", model: "m", provider: "p" }],
    ["prompt", { sessionId: "sid", content: [{ type: "text", text: "hi" }], requestId: "r" }],
    // The address must carry `kind`: 0.2.0 resolves the session through
    // `address.kind === "session" ? address.sessionId : address.childSessionId`,
    // so a bare `{ sessionId }` reads as session "undefined".
    ["page", { address: { kind: "session", sessionId: "sid" }, throughSeq: -1, maxMessages: 50 }],
  ]);
  // prompt and page call `signal.throwIfAborted()` unconditionally on 0.2.0, so
  // omitting the signal is a TypeError rather than a degraded call.
  for (const [name, , signal] of calls) {
    if (name !== "prompt" && name !== "page") continue;
    assert.equal(typeof signal?.throwIfAborted, "function", `${name} receives an AbortSignal`);
    assert.equal(signal.aborted, false);
  }
});

await check("a retried session.create reuses the live session instead of failing", async () => {
  // The app retries session.create after its own bookkeeping failed, while the
  // DSH session from the first attempt is still live. controller.create rejects
  // a duplicate id, so the retry must resolve to the existing session.
  const calls = [];
  const live = { id: "sid" };
  const runtime = new DshRuntime({
    sessions: { get: (id) => (id === "sid" ? live : undefined) },
    sessionController: {
      async create() { calls.push("create"); throw new Error('session "sid" already exists'); },
      async selectModel(request) { calls.push(["selectModel", request]); },
    },
  });
  const created = await runtime.createSession({ sessionId: "sid", cwd: "E:/dsh", model: "m", provider: "p" });
  assert.equal(created.sessionId, "sid");
  assert.deepEqual(calls, ["create", ["selectModel", { sessionId: "sid", model: "m", provider: "p" }]]);

  // A genuinely unknown id still surfaces the failure rather than inventing a session.
  const strict = new DshRuntime({
    sessions: { get: () => undefined },
    sessionController: { async create() { throw new Error("boom"); } },
  });
  await assert.rejects(() => strict.createSession({ sessionId: "other", cwd: "E:/dsh" }), /boom/);
});

await check("an empty controller page falls back to the session log", async () => {
  // The controller reads through the session-query index, and a profile may
  // never open it (`openAt: never`): it then answers an EMPTY page instead of
  // failing, so an empty page must not be trusted when the log has events.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-runtime-page-"));
  const originalHome = os.homedir;
  os.homedir = () => home;
  try {
    const dir = path.join(home, ".dsh", "sessions", "--work--", "cold");
    fs.mkdirSync(dir, { recursive: true });
    const rows = [
      { type: "session", id: "cold", cwd: "E:/work" },
      { seq: 0, type: "user/message", data: { id: "u1", role: "user", content: [{ type: "text", text: "from the log" }], source: { kind: "user" } } },
    ];
    const { zstdCompressSync } = await import("node:zlib");
    fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(rows.map(JSON.stringify).join("\n") + "\n")));

    const runtime = new DshRuntime({
      sessionController: { async page() { return { records: [], hasMore: false }; } },
    });
    const page = await runtime.page({ sessionId: "cold" });
    assert.deepEqual(page.records.map((record) => record.type), ["user/message"]);

    // A controller that does answer keeps its result.
    const answering = new DshRuntime({
      sessionController: { async page() { return { records: [{ seq: 9, type: "user/message" }], hasMore: true }; } },
    });
    assert.deepEqual(await answering.page({ sessionId: "cold" }), { records: [{ seq: 9, type: "user/message" }], hasMore: true });
  } finally {
    os.homedir = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("subagent sessions are not conversations; forked ones are", async () => {
  // The sidebar lists top-level conversations only. A delegated child
  // (`origin: "subagent"`, `delegationDepth > 0`) must not become a conversation
  // of its own on the phone — three such sessions showed up there while the
  // sidebar never listed them. A FORK keeps `parentSession` but stays top-level.
  const runtime = new DshRuntime({
    sessionQuery: {
      async listSessions() {
        return [
          { header: { id: "session-parent", cwd: "E:/work", createdAt: 1 } },
          { header: { id: "child-1", cwd: "E:/work", createdAt: 2, origin: "subagent", delegationDepth: 1, parentSession: "session-parent" } },
          { header: { id: "child-2", cwd: "E:/work", createdAt: 3, delegationDepth: 2, parentSession: "session-parent" } },
          { header: { id: "session-fork", cwd: "E:/work", createdAt: 4, delegationDepth: 0, parentSession: "session-parent" } },
        ]
      },
    },
  });
  runtime.titleOf = () => undefined;
  const sessions = await runtime.listSessions();
  assert.deepEqual(sessions.map((s) => s.id), ["session-parent", "session-fork"])
});

await check("a history page is turn-aligned and starts at the user message", async () => {
  // A page that begins mid-turn carries only the assistant and tool rows, and
  // the app renders nothing for it — a long session's last five message rows are
  // all assistant/tool rows, so its conversation looked empty on the phone.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-runtime-turn-"));
  const originalHome = os.homedir;
  os.homedir = () => home;
  try {
    const dir = path.join(home, ".dsh", "sessions", "--work--", "long");
    fs.mkdirSync(dir, { recursive: true });
    const rows = [
      { type: "session", id: "long", cwd: "E:/work" },
      { seq: 0, type: "step/start", data: { turn: 1, step: 1 } },
      { seq: 1, type: "user/message", data: { id: "u1", role: "user", content: [{ type: "text", text: "the question" }], source: { kind: "user", rpcId: "r1" } } },
      { seq: 2, type: "assistant/message", data: { turn: 1, step: 1, message: { id: "a1", content: [{ type: "text", text: "first" }] } } },
      // A long tail of tool rows, exactly what buried the user message.
      ...Array.from({ length: 8 }, (_, k) => ({ seq: 3 + k, type: "tool/call", data: { callId: `c${k}`, name: "bash", arguments: "{}" } })),
      { seq: 11, type: "assistant/message", data: { turn: 1, step: 2, message: { id: "a2", content: [{ type: "text", text: "final answer" }] } } },
      { seq: 12, type: "turn/end", data: { reason: { kind: "end_turn" } } },
    ];
    const { zstdCompressSync } = await import("node:zlib")
    fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(rows.map(JSON.stringify).join("\n") + "\n")))

    const runtime = new DshRuntime({})

    // The app renders only the page it opens with, so the opening page (no
    // cursor) carries the whole conversation and says there is nothing older.
    const opening = await runtime.page({ sessionId: "long" })
    assert.equal(opening.records.length, rows.length - 1, "the opening page carries the whole log")
    assert.equal(opening.hasMore, false, "nothing older to fetch, so the app does not re-request and duplicate")
    const openingUpdates = (await import("../lib/session-store.js")).dshEventsToAcpUpdates(opening.records, { isHistoryReplay: true })
    assert.equal(openingUpdates[0].sessionUpdate, "user_message_chunk")
    assert.ok(openingUpdates.some((u) => u.content?.text === "final answer"), "the answer is in the opening page")

    // A paged request (cursor) is turn-aligned: it must not start mid-turn, or
    // the app renders nothing for it.
    const page = await runtime.page({ sessionId: "long", beforeSeq: 13, maxMessages: 3 })
    assert.equal(page.records[0].type, "user/message", "a paged request opens with the turn's user message")
    assert.equal(page.records[0].data.content[0].text, "the question")
    const updates = (await import("../lib/session-store.js")).dshEventsToAcpUpdates(page.records, { isHistoryReplay: true })
    assert.equal(updates[0].sessionUpdate, "user_message_chunk")
    assert.equal(updates.at(-1).sessionUpdate, "session_end_turn")
    assert.ok(
      updates.some((u) => u.content?.text === "final answer"),
      "the turn's final answer is inside the page",
    )
  } finally {
    os.homedir = originalHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

await check("history fallback pages events by beforeSeq and maxMessages", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-runtime-history-"));
  const originalHome = os.homedir;
  os.homedir = () => home;
  try {
    const dir = path.join(home, ".dsh", "sessions", "--work--", "sid");
    fs.mkdirSync(dir, { recursive: true });
    const rows = [
      { type: "session", id: "sid", cwd: "E:/work" },
      ...Array.from({ length: 5 }, (_, seq) => ({
        seq,
        type: "user/message",
        data: { id: `u${seq}`, role: "user", content: [{ type: "text", text: `${seq}` }] },
      })),
    ];
    fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), (await import("node:zlib")).zstdCompressSync(Buffer.from(rows.map(JSON.stringify).join("\n") + "\n")));
    const runtime = new DshRuntime({});
    const page = await runtime.page({ sessionId: "sid", beforeSeq: 4, maxMessages: 2 });
    assert.deepEqual(page.records.map((event) => event.seq), [2, 3]);
    assert.equal(page.hasMore, true);
  } finally {
    os.homedir = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log(failed === 0 ? "\nall runtime checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
