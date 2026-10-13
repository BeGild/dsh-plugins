/**
 * Catalog downloads.
 *
 * ZCode is one JSON document. Both WorkBuddy catalogs are zip archives; only
 * the index and the one requested package are inflated, so a search does not
 * unpack all 268 skills.
 *
 * @module dsh-skill-market/fetch
 */
import { inflateRawSync } from 'node:zlib'

const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50

/**
 * Fetch bytes with a timeout. Throws a plain Error naming the URL on failure.
 * @param {string} url
 * @param {number} timeoutMs
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchBytes(url, timeoutMs, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('this host provides no fetch()')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`GET ${url} timed out after ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function decodeText(bytes) {
  return new TextDecoder('utf8').decode(bytes)
}

/**
 * List a zip archive without inflating it.
 * Supports stored and deflated entries, which is everything both catalogs use.
 * @param {Uint8Array} bytes
 * @returns {{ name: string, method: number, compressedSize: number, size: number, offset: number }[]}
 */
export function listZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const central = findCentralDirectory(view)
  const entries = []
  let cursor = central.offset
  for (let index = 0; index < central.count; index += 1) {
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL) break
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decodeText(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    entries.push({
      name,
      method,
      compressedSize,
      size,
      offset: localOffset + 30 + localNameLength + localExtraLength,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findCentralDirectory(view) {
  const min = Math.max(0, view.byteLength - 22 - 65_535)
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue
    return {
      count: view.getUint16(offset + 10, true),
      offset: view.getUint32(offset + 16, true),
    }
  }
  throw new Error('not a zip archive: missing the end of central directory')
}

/** Inflate one listed entry. */
export function readZipEntry(bytes, entry) {
  const slice = bytes.subarray(entry.offset, entry.offset + entry.compressedSize)
  if (entry.method === 0) return slice
  if (entry.method === 8) return inflateRawSync(slice)
  throw new Error(`zip entry ${entry.name} uses unsupported method ${entry.method}`)
}

/** Read one text entry by exact name, or undefined when the archive lacks it. */
export function readZipText(bytes, name) {
  const entry = listZip(bytes).find((item) => item.name === name)
  if (!entry) return undefined
  return decodeText(readZipEntry(bytes, entry))
}

/**
 * Read every entry under `prefix`, keyed by its path relative to the prefix.
 * Directory entries are skipped.
 */
export function readZipTree(bytes, prefix) {
  const files = {}
  for (const entry of listZip(bytes)) {
    if (!entry.name.startsWith(prefix) || entry.name.endsWith('/')) continue
    files[entry.name.slice(prefix.length)] = readZipEntry(bytes, entry)
  }
  return files
}
