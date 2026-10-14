import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function bindingsFile() {
  return path.join(os.homedir(), ".workbuddy", ".dsh-agentos-bindings.json");
}

/**
 * DSH mints session ids as `session-<uuid>` while the conversation registry —
 * and therefore the app — uses the bare uuid, and records written by different
 * builds hold either form. Indexing both means a lookup never misses a mapping
 * that exists: a strict comparison made the sync treat 44 live sessions as gone
 * and delete their records.
 */
function idForms(id) {
  const value = String(id ?? "");
  if (!value) return [];
  const bare = value.replace(/^session-/, "");
  return bare === value ? [value] : [value, bare];
}

/** The id spellings one session answers to; exported for callers that match ids. */
export function sessionIdForms(id) {
  return idForms(id);
}

export class SessionBindings {
  constructor(file = bindingsFile()) {
    this.file = file;
    this.bySession = new Map();
    this.byConversation = new Map();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const binding of parsed.bindings ?? []) this.set(binding, false);
    } catch {}
  }

  set(binding, persist = true) {
    if (!binding?.sessionId || !binding?.conversationId) {
      throw new Error("session binding requires both ids");
    }
    const record = { ...binding };
    const previous = this.bySession.get(String(record.sessionId));
    if (previous) for (const form of idForms(previous.conversationId)) this.byConversation.delete(form);
    const previousSession = this.byConversation.get(String(record.conversationId));
    if (previousSession) for (const form of idForms(previousSession)) this.bySession.delete(form);
    for (const form of idForms(record.sessionId)) this.bySession.set(form, record);
    for (const form of idForms(record.conversationId)) this.byConversation.set(form, record.sessionId);
    if (persist) this.save();
    return record;
  }

  getBySession(sessionId) {
    return this.bySession.get(String(sessionId)) ?? null;
  }

  getByConversation(conversationId) {
    const sessionId = this.byConversation.get(String(conversationId));
    return sessionId ? this.getBySession(sessionId) : null;
  }

  values() {
    return [...new Set(this.bySession.values())];
  }

  delete(sessionId) {
    const binding = this.getBySession(sessionId);
    if (!binding) return false;
    for (const form of idForms(binding.sessionId)) this.bySession.delete(form);
    for (const form of idForms(binding.conversationId)) this.byConversation.delete(form);
    this.save();
    return true;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, bindings: this.values() }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
