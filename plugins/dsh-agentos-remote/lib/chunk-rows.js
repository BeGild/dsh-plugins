/**
 * dsh-agentos-remote — packed chunk-row decoding, local to this plugin.
 *
 * DSH's JSONL session log packs a run of consecutive assistant deltas into ONE
 * row (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`) instead of
 * storing each delta separately. Reading a log therefore means expanding those
 * rows back into the `assistant/chunk` events the ACP converter renders.
 *
 * The reference decoder lives at `@deepseek-ai/dsh-session/chunk-rows`, but
 * that subpath is NOT exported by every host build: the Desktop-bundled
 * 0.2.0-rc.2 `@deepseek-ai/dsh-session` exports only `.` / `./invariant` /
 * `./types` / `./surface`, so importing `./chunk-rows` fails the ENTIRE plugin
 * load with `ERR_PACKAGE_PATH_NOT_EXPORTED` — the plugin never activates and
 * the whole profile refuses to boot. This module reimplements the same
 * validation and expansion so the plugin carries no host-internal subpath
 * dependency and works on both the 0.1.x and 0.2.x hosts.
 *
 * A malformed row THROWS rather than degrading to a plain event: treating a
 * corrupt run as one event would silently drop the whole run from history.
 */

/** Reference parity: arrays count as records here, so a stray array falls through unchanged. */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/** Exact-key check: `value` has every key in `keys` and nothing else. */
function hasExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The uniform malformed-row diagnostic. */
function malformed(tag, why) {
  throw new Error(`malformed ${tag} storage row: ${why}`);
}

/** Admit a numeric value as a Session sequence (non-negative safe integer). */
function admitSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload. */
function validateRunData(tag, data, payloadKey) {
  if (typeof data.turn !== "number" || typeof data.step !== "number" || typeof data.index !== "number") {
    malformed(tag, "turn/step/index must be numbers");
  }
  const payload = data[payloadKey];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== "string")) {
    malformed(tag, `${payloadKey} must be a non-empty string array`);
  }
  const dt = data.dt;
  if (!Array.isArray(dt) || dt.some((gap) => !Number.isSafeInteger(gap))) {
    malformed(tag, "dt must be an array of safe integers");
  }
  if (dt.length !== payload.length - 1) {
    malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`);
  }
  return payload;
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation. */
function validateRow(value, tag) {
  if (!hasExactKeys(value, ["type", "seq0", "time0", "data"])) {
    malformed(tag, "envelope must be exactly {type, seq0, time0, data}");
  }
  if (!Number.isSafeInteger(value.seq0) || value.seq0 < 0 || Object.is(value.seq0, -0)) {
    malformed(tag, "seq0 must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.time0)) {
    malformed(tag, "time0 must be a safe integer");
  }
  const data = value.data;
  if (!isRecord(data)) malformed(tag, "data must be an object");
  let payload;
  if (tag === "tool-call-chunks") {
    const withName = hasExactKeys(data, ["turn", "step", "index", "id", "name", "dt", "args"]);
    if (!withName && !hasExactKeys(data, ["turn", "step", "index", "id", "dt", "args"])) {
      malformed(tag, "data must be exactly {turn, step, index, id, name?, dt, args}");
    }
    if (typeof data.id !== "string" || (withName && typeof data.name !== "string")) {
      malformed(tag, "id (and name when present) must be strings");
    }
    payload = validateRunData(tag, data, "args");
  } else {
    if (!hasExactKeys(data, ["turn", "step", "index", "dt", "texts"])) {
      malformed(tag, "data must be exactly {turn, step, index, dt, texts}");
    }
    payload = validateRunData(tag, data, "texts");
  }
  // Reconstruction bounds: the encoder only packs runs whose member seqs and
  // times are all safe integers, so a running value that leaves safe range is
  // outside any encoder's image and float arithmetic would round it silently.
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - value.seq0) {
    malformed(tag, "member seqs must stay safe integers");
  }
  let time = value.time0;
  for (const gap of data.dt) {
    time += gap;
    if (!Number.isSafeInteger(time)) malformed(tag, "member times must stay safe integers");
  }
  admitSeq(value.seq0);
  return value;
}

/** Expand a validated row back into its exact original events, in order. */
function expandRow(row) {
  const members = row.type === "tool-call-chunks" ? row.data.args : row.data.texts;
  const events = [];
  let time = row.time0;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1];
    let chunk;
    switch (row.type) {
      case "text-chunks":
        chunk = { type: "text-delta", index: row.data.index, text: members[k] };
        break;
      case "reasoning-chunks":
        chunk = { type: "reasoning-delta", index: row.data.index, text: members[k] };
        break;
      case "tool-call-chunks":
        chunk = {
          type: "tool-call-delta",
          index: row.data.index,
          id: row.data.id,
          ...(Object.hasOwn(row.data, "name") ? { name: row.data.name } : {}),
          argumentsDelta: members[k],
        };
        break;
      default:
        // validateRow only ever admits the three row tags above.
        throw new Error(`chunk-rows received unsupported row ${String(row.type)}`);
    }
    events.push({
      type: "assistant/chunk",
      seq: row.seq0 + k,
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    });
  }
  return events;
}

/**
 * Decode one parsed JSONL line value into the session event(s) it stores.
 *
 * Chunk-row-tagged values validate and expand; every other value passes
 * through as a single event after admitting a numeric `seq`.
 *
 * @param {unknown} value one line's `JSON.parse` result.
 * @returns {object[]} the stored events, in log order.
 */
export function decodeStorageRecord(value) {
  if (!isRecord(value)) return [value];
  const tag = value.type;
  if (tag !== "text-chunks" && tag !== "reasoning-chunks" && tag !== "tool-call-chunks") {
    if (typeof value.seq === "number") admitSeq(value.seq);
    return [value];
  }
  return expandRow(validateRow(value, tag));
}
