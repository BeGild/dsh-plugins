/**
 * dsh-agentos-remote — encrypted message envelopes (WorkBuddy edge-sync parity).
 *
 * The device channels are not plaintext. Every payload the mobile app sends on
 * `executor:{deviceId}` and every reply the host publishes is an AES-GCM-256
 * envelope, HMAC-signed, versioned by the key set the credentials delivered:
 *
 *   envelope = { v:1, msgId, partIndex, partTotal, eventId, [seq], ts,
 *                iv, ciphertext, tag, keyVersion, [senderDeviceId],
 *                [eventType], sig, [traceId, spanId, traceFlags,
 *                traceOperation] }
 *
 *   - key: 32 raw bytes per channel scope from credentials.encryptionKeys /
 *     credentials.signingKeys (base64). Current version: credentials.keyVersion.
 *   - cipher: AES-256-GCM, 12-byte IV, 16-byte tag carried separately,
 *     AAD = "<msgId>|<partIndex>|<partTotal>|<keyVersion>" (utf8).
 *   - signature: HMAC-SHA256 with the scope's signing key, over the canonical
 *     JSON of every field except sig and the trace extras, in the exact field
 *     order below — the byte string is the signed input, so field order and
 *     undefined-omission are part of the contract.
 *   - large payloads: split into partSizeMax = maxPayloadBytes - 1024 slices,
 *     one envelope each, same msgId, partIndex 0..partTotal-1. The app
 *     reassembles by msgId.
 *   - transport: presence is the only WS publish; everything else (replies on
 *     `reply:...`, conversation broadcasts on `user:{uid}:conversations`) goes
 *     as one HTTP POST per envelope to credentials.apisixPublishUrl with the
 *     publishToken.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const ENVELOPE_PROTOCOL_VERSION = 1;
/** Headroom subtracted from maxPayloadBytes to size each slice. */
export const ENVELOPE_OVERHEAD = 1024;
/** Credentials' default maxPayloadBytes. */
export const ENVELOPE_MAX_PAYLOAD_BYTES = 49152;

export function envelopeSerialize(env) {
  const obj = { v: env.v, msgId: env.msgId, partIndex: env.partIndex, partTotal: env.partTotal, eventId: env.eventId };
  if (env.seq !== undefined) obj.seq = env.seq;
  obj.ts = env.ts;
  obj.iv = env.iv;
  obj.ciphertext = env.ciphertext;
  obj.tag = env.tag;
  obj.keyVersion = env.keyVersion;
  if (env.senderDeviceId !== undefined) obj.senderDeviceId = env.senderDeviceId;
  if (env.eventType !== undefined) obj.eventType = env.eventType;
  return Buffer.from(JSON.stringify(obj), "utf8");
}

export function envelopeAAD(msgId, partIndex, partTotal, keyVersion) {
  return Buffer.from(`${msgId}|${partIndex}|${partTotal}|${keyVersion}`, "utf8");
}

/**
 * Key lookup with edge-sync's fallback chain: exact scope, then the
 * user-limited reduction (`reply:<id>#<uid>` → `reply:#<uid>` — every user
 * shares one reply key), then a trailing-segment wildcard
 * (`executor:a:b` → `executor:*`).
 */
export function lookupScopeKey(keys, scope) {
  if (!keys) return null;
  const exact = keys[scope];
  if (exact !== undefined) return exact;
  const hashIdx = scope.indexOf("#");
  if (hashIdx > 0) {
    const firstColon = scope.indexOf(":");
    if (firstColon > 0 && firstColon < hashIdx) {
      const userScope = scope.slice(0, firstColon + 1) + scope.slice(hashIdx);
      const reduced = keys[userScope];
      if (reduced !== undefined) return reduced;
    }
  }
  const lastColon = scope.lastIndexOf(":");
  if (lastColon > 0) {
    const wildcard = `${scope.slice(0, lastColon + 1)}*`;
    const fallback = keys[wildcard];
    if (fallback !== undefined) return fallback;
  }
  return null;
}

/**
 * The AES + HMAC key pair for one channel, or null when the credentials grant
 * nothing for it. `keyVersion` is the credentials' current version — envelopes
 * we produce carry it, and inbound envelopes are accepted only when their
 * version matches what we can decrypt.
 */
export function resolveChannelKeys(credentials, channel) {
  const encB64 = lookupScopeKey(credentials?.encryptionKeys, channel);
  const sigB64 = lookupScopeKey(credentials?.signingKeys, channel);
  if (!encB64 || !sigB64) return null;
  const enc = Buffer.from(encB64, "base64");
  const sig = Buffer.from(sigB64, "base64");
  if (enc.length !== 32) throw new Error(`[envelope] AES key for ${channel} is ${enc.length} bytes, expected 32`);
  return { enc, sig, keyVersion: credentials.keyVersion ?? 1 };
}

export function envelopeSignatureValid(env, sigKey) {
  if (!env?.sig) return false;
  const expected = createHmac("sha256", sigKey).update(envelopeSerialize(env)).digest();
  const provided = Buffer.from(env.sig, "base64");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Decrypt one envelope part. Throws when the key, AAD or tag do not match. */
export function decryptEnvelopePart(env, encKey, sigKey) {
  if (!envelopeSignatureValid(env, sigKey)) {
    throw new Error(`[envelope] HMAC verify failed (msgId=${env.msgId} part=${env.partIndex})`);
  }
  const iv = Buffer.from(env.iv, "base64");
  if (iv.length !== 12) throw new Error(`[envelope] IV must be 12 bytes, got ${iv.length}`);
  const tag = Buffer.from(env.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
  decipher.setAAD(envelopeAAD(env.msgId, env.partIndex, env.partTotal, env.keyVersion));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, "base64")), decipher.final()]);
}

/**
 * Reassemble a complete multi-part delivery into its payload. `parts` are
 * envelopes sharing one msgId in any order; order/identity mismatches and
 * signature or cipher failures all throw.
 */
export function assembleEnvelopes(parts, encKey, sigKey) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("[envelope] empty delivery");
  const first = parts[0];
  if (parts.length !== first.partTotal) {
    throw new Error(`[envelope] expected ${first.partTotal} parts, got ${parts.length}`);
  }
  const ordered = [...parts].sort((a, b) => a.partIndex - b.partIndex);
  const slices = ordered.map((env, index) => {
    if (env.msgId !== first.msgId) throw new Error("[envelope] msgId mismatch inside delivery");
    if (env.partIndex !== index) throw new Error(`[envelope] partIndex ${env.partIndex} out of sequence at ${index}`);
    return decryptEnvelopePart(env, encKey, sigKey);
  });
  return JSON.parse(Buffer.concat(slices).toString("utf8"));
}

/**
 * Encrypt + sign a payload into envelopes. Large payloads split exactly like
 * edge-sync: slices of maxPayloadBytes - ENVELOPE_OVERHEAD, shared msgId, one
 * random IV per part. `eventId`/`ts`/`senderDeviceId` mirror the desktop's
 * metadata so the app can correlate and drop echoes.
 */
export function packEnvelopes(payload, encKey, sigKey, keyVersion, options = {}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? ENVELOPE_MAX_PAYLOAD_BYTES;
  const partSizeMax = maxPayloadBytes - ENVELOPE_OVERHEAD;
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const partTotal = Math.max(1, Math.ceil(plaintext.length / partSizeMax));
  if (partTotal > 65535) throw new Error(`[envelope] partTotal ${partTotal} exceeds uint16 max`);
  const msgId = options.msgId ?? newUlid();
  const eventId = options.eventId ?? randomUUID();
  const ts = options.ts ?? Date.now();
  const envelopes = [];
  for (let index = 0; index < partTotal; index++) {
    const slice = plaintext.subarray(index * partSizeMax, Math.min((index + 1) * partSizeMax, plaintext.length));
    const iv = randomBytes(12);
    const aad = envelopeAAD(msgId, index, partTotal, keyVersion);
    const cipher = createCipheriv("aes-256-gcm", encKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(slice), cipher.final()]);
    const noSig = { v: ENVELOPE_PROTOCOL_VERSION, msgId, partIndex: index, partTotal, eventId, ts, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"), keyVersion };
    if (options.seq !== undefined) noSig.seq = options.seq;
    if (options.senderDeviceId !== undefined) noSig.senderDeviceId = options.senderDeviceId;
    if (options.eventType !== undefined) noSig.eventType = options.eventType;
    noSig.sig = createHmac("sha256", sigKey).update(envelopeSerialize(noSig)).digest("base64");
    envelopes.push(noSig);
  }
  return envelopes;
}

/**
 * One HTTP publish, exactly like edge-sync's APISIX path: one envelope per
 * request, the channel and its scope echoed in headers, the publishToken as
 * the bearer. Presence never goes through here (it is the WS-only channel).
 */
export async function publishEnvelopeHttp(envelope, { url, channel, userId, publishToken, fetchImpl = fetch } = {}) {
  if (!url) throw new Error("[envelope] apisixPublishUrl is not configured");
  const scope = channel.slice(0, channel.indexOf(":")) || channel;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Channel": channel,
      "X-Channel-Scope": scope,
      ...(userId ? { "X-User-Id": userId } : {}),
      ...(publishToken ? { Authorization: `Bearer ${publishToken}` } : {}),
    },
    body: JSON.stringify({ channel, data: envelope }),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`[envelope] publish HTTP ${res.status}: ${text.slice(0, 200)}`);
  return true;
}

/** ULID-shaped message id (timestamp + randomness, Crockford base32). */
function newUlid() {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let tsRem = Date.now();
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = ALPHABET[tsRem & 31] + out;
    tsRem = Math.floor(tsRem / 32);
  }
  const rnd = randomBytes(10);
  let buf = 0;
  let bits = 0;
  let rndStr = "";
  for (const byte of rnd) {
    buf = (buf << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rndStr += ALPHABET[(buf >>> bits) & 31];
    }
  }
  return out + rndStr.slice(0, 16);
}
