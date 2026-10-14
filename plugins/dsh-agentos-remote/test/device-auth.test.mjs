/**
 * dsh-agentos-remote device-auth tests — run with: node test/device-auth.test.mjs
 *
 * Hermetic: the credential and registry calls run against an injected fetch, so
 * nothing here touches the network or the real ~/.workbuddy directory. What it
 * pins is the conversation-sync contract the mobile app depends on — the request
 * shape, the channel names, and the presence envelope — because a drift in any of
 * them enrolls a device the app can never address.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CH_SDK_VERSION,
  CREDENTIALS_PATH,
  DEVICES_ONLINE_PATH,
  DEVICE_CLIENT_TYPE,
  devicePresenceChannel,
  devicePresencePayload,
  executorChannel,
  fetchDeviceCredentials,
  fetchOnlineDevices,
  heartbeatIntervalOf,
  isDeviceOnline,
  resolveDeviceId,
} from '../lib/device-auth.js'

let failed = 0
function check(label, fn) {
  const run = async () => {
    try {
      await fn()
      console.log(`  ok   ${label}`)
    } catch (error) {
      failed++
      console.log(`  FAIL ${label}\n       ${error.message.split('\n').slice(0, 4).join('\n       ')}`)
    }
  }
  return run()
}

/** A fetch that records the request and answers with `respond`. */
function fakeFetch(respond) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const result = await respond(url, init)
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
    return { ok: result.status === 200, status: result.status, text: async () => body }
  }
  return { fetchImpl, calls }
}

const SESSION = {
  auth: { accessToken: 'tok-1', domain: 'example.test' },
  account: { uid: 'uid-1', enterpriseId: 'ent-1' },
}

console.log('dsh-agentos-remote device-auth tests\n')

const checks = []

checks.push(check('channel names match the conversation-sync registry', () => {
  assert.equal(devicePresenceChannel('uid-1'), 'user:uid-1:devices')
  assert.equal(executorChannel('dev-1'), 'executor:dev-1')
  assert.equal(DEVICE_CLIENT_TYPE, 'desktop', 'the registry only enumerates desktop-class hosts')
}))

checks.push(check('the presence envelope is type + deviceId + clientType + ts', () => {
  assert.deepEqual(devicePresencePayload('device.online', 'dev-1', 'desktop', 123), {
    type: 'device.online',
    deviceId: 'dev-1',
    clientType: 'desktop',
    ts: 123,
  })
}))

checks.push(check('the heartbeat cadence follows the server mandate, never slower', () => {
  // The registry's online window is ~60s; the server sends heartbeatIntervalMs
  // (30s observed) and a slower beat reads as offline between beats.
  assert.equal(heartbeatIntervalOf({ heartbeatIntervalMs: 30000 }), 30000)
  assert.equal(heartbeatIntervalOf({}), 30000, 'missing field falls back to 30s')
  assert.equal(heartbeatIntervalOf({ heartbeatIntervalMs: 5000 }), 10000, 'clamped to the 10s floor')
  assert.equal(heartbeatIntervalOf(undefined), 30000)
}))

checks.push(check('fetchDeviceCredentials posts the enrollment body WorkBuddy sends', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: { data: { connectToken: 'c', cfWsUrl: 'wss://example.test/ws', subscriptionTokens: { 'executor:dev-1': 's' }, keyVersion: 1 } },
  }))
  const credentials = await fetchDeviceCredentials(
    SESSION,
    { deviceId: 'dev-1', deviceName: 'box', appVersion: '1.3.0', authBase: 'https://auth.test' },
    fetchImpl,
  )
  assert.equal(calls[0].url, `https://auth.test${CREDENTIALS_PATH}`)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    userId: 'uid-1',
    deviceId: 'dev-1',
    clientType: 'desktop',
    deviceName: 'box',
    useDefaultScopes: true,
    chSdkVersion: CH_SDK_VERSION,
    appVersion: '1.3.0',
  })
  const headers = calls[0].init.headers
  assert.equal(headers.Authorization, 'Bearer tok-1')
  assert.equal(headers['X-User-Id'], 'uid-1')
  assert.equal(headers['X-Enterprise-Id'], 'ent-1')
  assert.equal(credentials.connectToken, 'c')
  assert.equal(credentials.keyVersion, 1)
}))

checks.push(check('fetchDeviceCredentials rejects a credential set without channels', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { data: { connectToken: 'c', cfWsUrl: 'wss://x' } } }))
  await assert.rejects(
    () => fetchDeviceCredentials(SESSION, { deviceId: 'dev-1', deviceName: 'box' }, fetchImpl),
    /subscriptionTokens/,
  )
}))

checks.push(check('a non-zero API code surfaces instead of enrolling on garbage', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { code: 14001, msg: 'nope' } }))
  await assert.rejects(
    () => fetchDeviceCredentials(SESSION, { deviceId: 'dev-1', deviceName: 'box' }, fetchImpl),
    /code=14001 nope/,
  )
}))

checks.push(check('fetchOnlineDevices reads the registry snapshot', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: { data: { devices: [{ deviceId: 'dev-1', online: true }, { deviceId: 'dev-2', online: false }], cacheSource: 'redis+cf' } },
  }))
  const snapshot = await fetchOnlineDevices(SESSION, { authBase: 'https://auth.test' }, fetchImpl)
  assert.equal(calls[0].url, `https://auth.test${DEVICES_ONLINE_PATH}`)
  assert.equal(snapshot.cacheSource, 'redis+cf')
  assert.equal(isDeviceOnline(snapshot, 'dev-1'), true)
  assert.equal(isDeviceOnline(snapshot, 'dev-2'), false, 'an explicitly offline record does not count')
  assert.equal(isDeviceOnline(snapshot, 'dev-3'), false)
}))

checks.push(check('resolveDeviceId honours an explicit override without touching disk', () => {
  assert.equal(resolveDeviceId('  pinned-id  '), 'pinned-id')
}))

checks.push(check('resolveDeviceId reuses its own device-id file and persists a new one', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-agentos-'))
  const previous = os.homedir
  os.homedir = () => home
  try {
    const created = resolveDeviceId(null)
    const file = path.join(home, '.workbuddy', '.dsh-agentos-device-id')
    assert.equal(readFileSync(file, 'utf8').trim(), created, 'a fresh id is written back so it survives restart')
    assert.equal(resolveDeviceId(null), created, 'the second call reads the same id back')
  } finally {
    os.homedir = previous
    rmSync(home, { recursive: true, force: true })
  }
}))

checks.push(check('resolveDeviceId never claims the WorkBuddy Desktop identity', () => {
  // The desktop owns ~/.workbuddy/device-id; enrolling under it collides with
  // the live desktop process (shared executor channel, fighting presence).
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-agentos-'))
  const previous = os.homedir
  os.homedir = () => home
  try {
    mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
    const desktopId = '2817c23e-70e0-402a-9c04-ba509dae264b'
    writeFileSync(path.join(home, '.workbuddy', 'device-id'), `${desktopId}\n`)
    const created = resolveDeviceId(null)
    assert.notEqual(created, desktopId, 'the desktop id file must be ignored')
    assert.match(created, /^[0-9a-f-]{36}$/, 'a fresh plugin-owned id is generated instead')
  } finally {
    os.homedir = previous
    rmSync(home, { recursive: true, force: true })
  }
}))

await Promise.all(checks)
console.log(failed === 0 ? '\nall device-auth checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
