/**
 * Filesystem state for installed packages and connector secrets.
 *
 * Layout, under the configured state directory:
 *
 *   plugins/<id>/...           an installed ZCode plugin, hooks included
 *   installed.json             one record per install
 *
 * @module dsh-skill-market/store
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const INSTALLED = 'installed.json'

/** Read installed.json, treating a missing file as an empty catalog. */
export async function readInstalled(stateDir) {
  return readJson(join(stateDir, INSTALLED), {})
}

/** Replace installed.json. */
export async function writeInstalled(stateDir, records) {
  await writeJson(join(stateDir, INSTALLED), records)
}

/**
 * Write bundle-relative files under the skill root, replacing each top-level
 * bundle directory first. Returns those directory names.
 */
export async function writeBundles(skillsDir, files) {
  const roots = [...new Set(Object.keys(files).map((relative) => String(relative).split('/')[0]))]
  for (const root of roots) await rm(safeChild(skillsDir, root), { recursive: true, force: true })
  await mkdir(skillsDir, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const target = safeChild(skillsDir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return roots
}

export async function removeBundles(skillsDir, roots) {
  for (const root of roots ?? []) await rm(safeChild(skillsDir, root), { recursive: true, force: true })
}

/** Write a whole plugin tree, replacing the previous install of the same id. */
export async function writePluginTree(pluginsDir, id, files) {
  const dir = safeChild(pluginsDir, id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const target = safeChild(dir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return dir
}

export async function removePluginTree(pluginsDir, id) {
  await rm(safeChild(pluginsDir, id), { recursive: true, force: true })
}

/** Refuse a destination that escapes its parent. */
export function safeChild(parent, relative) {
  const normalised = String(relative).replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalised || normalised.split('/').includes('..')) {
    throw new Error(`refusing to write outside the install directory: ${relative}`)
  }
  const target = resolve(parent, normalised)
  const root = resolve(parent)
  if (target !== root && !target.startsWith(root + sep) && !target.startsWith(root + '/')) {
    throw new Error(`refusing to write outside the install directory: ${relative}`)
  }
  return target
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

