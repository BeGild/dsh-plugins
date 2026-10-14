/**
 * dsh-agentos-remote conversation-sync tests — run with: node test/conversation-sync.test.mjs
 *
 * Hermetic: the registry call runs against an injected fetch. What it pins is the
 * contract the mobile app's task list depends on — the create request, the
 * broadcast envelope, and the model list leaving this machine without credentials.
 */
import assert from 'node:assert/strict'
import {
  CONVERSATIONS_PATH,
  conversationCreatedPayload,
  conversationsChannel,
  createCloudConversation,
  listCloudConversations,
  migrateLegacySessions,
  mutateCloudConversation,
  promptTextOf,
  publicModelList,
} from '../lib/conversation-sync.js'
import { AgentosRemoteService, PROJECTION_VERSION } from '../lib/index.js'

let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label}\n       ${error.message.split('\n').slice(0, 4).join('\n       ')}`)
  }
}

function fakeFetch(respond) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const result = await respond()
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
    return { ok: result.status === 200, status: result.status, text: async () => body }
  }
  return { fetchImpl, calls }
}

const SESSION = { auth: { accessToken: 'tok-1', domain: 'example.test' }, account: { uid: 'uid-1' } }

console.log('dsh-agentos-remote conversation-sync tests\n')

await check('the broadcast channel is the per-user conversation channel', () => {
  assert.equal(conversationsChannel('uid-1'), 'user:uid-1:conversations')
})

await check('createCloudConversation registers a local task and returns its id', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { code: 0, data: { id: 'conv-1' } } }))
  const id = await createCloudConversation(
    SESSION,
    { sessionId: 'sess-1', title: '查一下日志', deviceId: 'dev-1', workDir: '/work/dsh', model: 'm-1', syncBase: 'https://sync.test' },
    fetchImpl,
  )
  assert.equal(id, 'conv-1')
  assert.equal(calls[0].url, `https://sync.test${CONVERSATIONS_PATH}`)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.type, 'local')
  assert.equal(body.sessionId, 'sess-1')
  assert.equal(body.name, '查一下日志')
  assert.equal(body.workDir, '/work/dsh')
  assert.equal(body.isPlayground, 0, 'a task with a workDir is not a playground')
  assert.equal(body.clientContext.hostId, 'dev-1')
  assert.equal(body.clientContext.model, 'm-1')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1')
})

await check('an idempotent 14295 hit returns the sessionId as the conversationId', async () => {
  // The registry keys local conversations on sessionId; re-registering an
  // app conversation (e.g. after a plugin restart) answers 14295 and the
  // existing record's id IS the sessionId — the same shortcut edge-sync takes.
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { code: 14295, msg: 'already exists' } }))
  const id = await createCloudConversation(SESSION, { sessionId: 'sess-dup', title: 't', deviceId: 'd' }, fetchImpl)
  assert.equal(id, 'sess-dup')
})

await check('the app\u2019s boolean isPlayground is sent as the int the registry demands', async () => {
  // The Go struct types isPlayground as an int. Forwarding the app's boolean
  // made every session.create answer HTTP 400 "cannot unmarshal bool into Go
  // struct field CreateConversationV2Request.isPlayground of type int".
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { code: 0, data: { id: 'conv-2' } } }))
  await createCloudConversation(SESSION, { sessionId: 's1', title: 't', deviceId: 'd', isPlayground: true }, fetchImpl)
  await createCloudConversation(SESSION, { sessionId: 's2', title: 't', deviceId: 'd', isPlayground: false }, fetchImpl)
  const [first, second] = calls.map(({ init }) => JSON.parse(init.body))
  assert.equal(first.isPlayground, 1)
  assert.equal(second.isPlayground, 0)
  assert.equal(typeof first.isPlayground, 'number')
})

await check('a real registry rejection surfaces instead of reporting a phantom task', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { code: 15000, msg: 'nope' } }))
  await assert.rejects(
    () => createCloudConversation(SESSION, { sessionId: 's', title: 't', deviceId: 'd' }, fetchImpl),
    /code=15000 nope/,
  )
})

await check('the created event carries the conversation id, title and originating device', () => {
  const event = conversationCreatedPayload('dev-1', {
    conversationId: 'conv-1',
    sessionId: 'sess-1',
    title: '查一下日志',
    workDir: '/work/dsh',
    model: 'm-1',
  })
  assert.equal(event.type, 'conversation.created')
  assert.equal(event.deviceId, 'dev-1', 'receivers drop echoes from their own device')
  assert.equal(event.conversationId, 'conv-1')
  assert.equal(event.title, '查一下日志')
  assert.equal(typeof event.eventId, 'string')
  assert.equal(event.model, 'm-1')
})

await check('the model list keeps identity and capability but never credentials', () => {
  const list = publicModelList([
    { id: 'm-1', name: 'Model One', vendor: 'Custom', url: 'https://secret', apiKey: 'sk-secret', supportsImages: true },
    { id: '  ', name: 'blank' },
    null,
  ])
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'm-1')
  assert.equal(list[0].supportsImages, true)
  assert.equal('url' in list[0], false)
  assert.equal('apiKey' in list[0], false)
})

await check('a model pick is remembered and reported back on the reply channel', async () => {
  const published = []
  const service = Object.create(AgentosRemoteService.prototype)
  service.config = { models: [{ id: 'm-1', name: 'One', apiKey: 'sk-secret' }], model: undefined }
  service.conversations = new Map()
  service.selectedModel = null
  // Reply delivery is exercised by publishEncryptedReply's own wiring; here we
  // pin the command semantics: what gets answered, on which channel.
  service.publishEncryptedReply = async (channel, result) => { published.push({ channel, result }) }
  const logger = { info: () => {}, warn: () => {} }

  const models = await service.dispatchCommand({ type: 'get_models' }, logger)
  assert.equal(models.data.models[0].id, 'm-1')
  assert.equal('apiKey' in models.data.models[0], false, 'credentials never reach the app')

  await service.onDeviceCommand({ type: 'session.set_model', model: 'm-1', replyChannel: 'reply-1' }, logger)
  assert.equal(service.selectedModel, 'm-1')
  assert.deepEqual(published.at(-1), { channel: 'reply-1', result: { success: true, model: 'm-1' } })
  assert.equal(service.modelFor(undefined), 'm-1', 'the pick applies to the next task')
})

await check('a command without a reply channel still runs and answers nothing', async () => {
  const service = Object.create(AgentosRemoteService.prototype)
  service.config = { models: [] }
  service.conversations = new Map()
  service.selectedModel = null
  let answered = false
  service.publishEncryptedReply = async () => { answered = true }
  await service.onDeviceCommand({ type: 'session.set_model', model: 'm-2' }, { info: () => {}, warn: () => {} })
  assert.equal(service.selectedModel, 'm-2')
  assert.equal(answered, false, 'no replyChannel, no reply delivery')
})

await check('a picked model resolves to the provider its list entry names', () => {
  // The same id can sit under two providers, so the route must follow the
  // entry rather than a single global provider.
  const service = Object.create(AgentosRemoteService.prototype)
  service.config = {
    provider: 'ssaiproxy',
    models: [
      { id: 'deepseek-flash', provider: 'ssaiproxy' },
      { id: 'grok-4.7', provider: 'ssaihub' },
    ],
  }
  service.conversations = new Map()
  service.selectedModel = 'grok-4.7'
  assert.deepEqual(service.routeFor('whatever'), { provider: 'ssaihub', model: 'grok-4.7' })

  service.selectedModel = null
  assert.deepEqual(service.routeFor('whatever'), { provider: 'ssaiproxy', model: null }, 'no pick falls back to the configured provider')
})

await check('conversation list follows the host workspace model, not the raw cwd', async () => {
  const service = Object.create(AgentosRemoteService.prototype)
  const workspace = { id: 'w-two', path: 'E:/two', title: 'two' }
  const rows = [
    { id: 's1', cwd: 'E:/one', title: 'alpha', status: 'idle', createdAt: 1 },
    { id: 's2', cwd: 'E:/two', title: 'beta', status: 'running', createdAt: 2, workspace },
    { id: 's3', cwd: 'E:/two', title: 'gamma', status: 'idle', createdAt: 3, workspace },
  ]
  service.config = { models: [] }
  service.bindings = { getBySession(id) { return id === 's3' ? { sessionId: id, conversationId: 'c3', conversationOrigin: 'local_scheduler' } : null } }
  service.runtime = { async listSessions() { return rows } }
  const result = await service.dispatchCommand({ type: 'wb:conversations:list', args: [{ workspacePath: 'E:/two', state: 'idle', conversationOrigin: 'local_scheduler', size: 1 }] }, { info() {} })
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, 's3')
  // The space is the WORKSPACE the host groups by, so every session of one
  // project shares a single space instead of one per session directory.
  assert.equal(result.items[0].space.type, 'workdir')
  assert.equal(result.items[0].space.cwd, 'E:/two')
  assert.equal(result.items[0].space.name, 'two')
  assert.equal(result.items[0].space.workspaceId, 'w-two')
  assert.equal(result.items[0].projectId, undefined)
  assert.equal(result.hasMore, false)

  // A session in no workspace is ungrouped, exactly like the sidebar's 未分组.
  const all = await service.dispatchCommand({ type: 'wb:conversations:list', args: [{ size: 10 }] }, { info() {} })
  assert.equal(all.items.find((item) => item.id === 's1').space.type, 'playground')
})

await check('session.create binds, joins the workspace, and reports it as the space', async () => {
  const service = Object.create(AgentosRemoteService.prototype)
  const writes = []
  const attached = []
  service.runtime = {
    async createSession() { return { sessionId: 'effective-session' } },
    async attachToWorkspace(sessionId, cwd) { attached.push([sessionId, cwd]) },
    async workspaceForPath(cwd) { return cwd === '/work' ? { id: 'w-1', path: '/work', title: 'work' } : null },
  }
  service.bindings = { set(binding) { writes.push(binding); return binding } }
  service.conversations = new Map()
  service.config = { models: [] }
  service.session = SESSION
  service.deviceId = 'device-1'
  service.workspaceDir = '/work'
  service.modelFor = () => null
  service.routeForModel = () => ({})
  service.publishConversationBroadcast = async () => {}
  const originalFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { id: 'cloud-session' } }) }
  }
  try {
    const result = await service.createConversation({ sessionId: 'requested-session', title: 'task' }, { info() {} })
    assert.equal(result.sessionId, 'effective-session')
    assert.equal(writes[0].sessionId, 'effective-session')
    assert.deepEqual(attached, [['effective-session', '/work']], 'the session joins the host workspace')
    assert.equal(bodies[0].workDir, '/work', 'the registry is told the workspace path, not the raw cwd')
    assert.equal(bodies[0].isPlayground, 0)
    assert.equal(writes[0].workspaceId, 'w-1')

    // A directory outside every workspace stays ungrouped rather than becoming
    // a space of its own.
    const outside = await service.createConversation({ sessionId: 'other', title: 'task', cwd: '/elsewhere' }, { info() {} })
    assert.equal(outside.success, true)
    assert.equal(bodies[1].workDir, '')
    assert.equal(bodies[1].isPlayground, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('empty host sessions stay out of the list; the app\u2019s own do not', async () => {
  // The sidebar hides sessions that never received a message (measured: 12 of a
  // workspace's 14 sessions were listed; the two missing were exactly the blank
  // ones). An empty session the app opened is kept, because the app shows it
  // while its first message is being composed.
  const service = Object.create(AgentosRemoteService.prototype)
  service.runtime = {
    async listSessions() {
      return [
        { id: 'host-empty', blank: true },
        { id: 'app-empty', blank: true },
        { id: 'used', blank: false },
      ]
    },
  }
  service.bindings = { getBySession: (id) => (id === 'app-empty' ? { sessionId: id, conversationId: 'c' } : null) }
  const visible = await service.visibleSessions()
  assert.deepEqual(visible.map((s) => s.id), ['app-empty', 'used'])
})

await check('stale records are reclaimed: gone, empty, or a child session', async () => {
  // The phone's list is entirely fed by what this plugin registers, so the plugin
  // owns the cleanup. The registry has no list endpoint, so a record whose local
  // session is gone would otherwise sit on the phone forever.
  const service = Object.create(AgentosRemoteService.prototype)
  service.runtime = {
    async listSessions() {
      return [
        { id: 'kept', blank: false },
        { id: 'empty', blank: true },
        { id: 'app-empty', blank: true },
      ]
    },
  }
  const bindings = new Map([
    ['gone', { sessionId: 'gone', conversationId: 'c-gone' }],
    ['empty', { sessionId: 'empty', conversationId: 'c-empty' }],
    ['app-empty', { sessionId: 'app-empty', conversationId: 'c-app', createdBy: 'app' }],
    ['kept', { sessionId: 'kept', conversationId: 'c-kept' }],
  ])
  const dropped = []
  service.bindings = {
    values: () => [...bindings.values()],
    delete: (id) => { dropped.push(id); bindings.delete(id); return true },
  }
  service.conversations = new Map()
  service.session = SESSION
  service.deviceId = 'device-1'
  const originalFetch = globalThis.fetch
  const deleted = []
  globalThis.fetch = async (url) => {
    deleted.push(url.split('/conversations/')[1])
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }
  }
  try {
    await service.pruneStaleConversations({ info() {}, warn() {} })
    assert.deepEqual(dropped.sort(), ['empty', 'gone'])
    assert.deepEqual(deleted.sort(), ['c-empty/delete', 'c-gone/delete'])
    assert.equal(bindings.has('app-empty'), true, 'the app\u2019s own empty conversation survives')
    assert.equal(bindings.has('kept'), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('an unregistered session is created with the bare uuid and mapped', async () => {
  // The registry rejects a `session-` prefixed id with
  // `{status: "skipped", reason: "invalid_field"}` and registers nothing, while
  // the same body with the bare uuid imports and returns the conversationId (both
  // verified live). Registration goes through the CREATE endpoint rather than the
  // bulk migration, because the migration answers `skipped` with no id when
  // nothing changed — which left sessions registered in the cloud but unmapped
  // locally, invisible on the phone.
  const service = Object.create(AgentosRemoteService.prototype)
  const writes = []
  service.runtime = { async listSessions() { return [{ id: 'session-4de0592e-030e-4351-a799-c6b71f531d43', cwd: 'E:/work', title: '真实标题', status: 'idle' }] } }
  service.bindings = { getBySession: () => null, set(binding) { writes.push(binding); return binding } }
  service.conversations = new Map()
  service.session = SESSION
  service.deviceId = 'device-1'
  service.sessionsMigrated = 0
  service.publishConversationBroadcast = async () => {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.includes('/conversations/v2'), `the create endpoint is used, saw ${url}`)
    const body = JSON.parse(init.body)
    assert.equal(body.sessionId, '4de0592e-030e-4351-a799-c6b71f531d43', 'the bare uuid is sent')
    assert.equal(body.name, '真实标题')
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { id: 'cloud-1' } }) }
  }
  try {
    await service.migrateLocalSessions({ info() {} })
    assert.equal(writes[0].sessionId, 'session-4de0592e-030e-4351-a799-c6b71f531d43', 'the binding keeps the local session id')
    assert.equal(writes[0].conversationId, 'cloud-1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('a title refresh updates the record in place and re-announces its space', async () => {
  // An earlier build wrote placeholder names because the log's title row was
  // unreadable. The repair goes through the update endpoint rather than the bulk
  // migration: the migration answers `{status:"updated"}` while leaving the
  // record untouched (measured live — `workDir` and `updatedAt` both stayed
  // put), whereas `POST /conversations/{id}` really applies `title`, and
  // `isPlayground: 1` really clears a `workDir` an earlier build wrote. The
  // app caches a conversation's space from the event that announced it, so the
  // corrected space rides a `conversation.updated` — not a `created`, which
  // would read as a second task.
  const service = Object.create(AgentosRemoteService.prototype)
  const writes = []
  const broadcasts = []
  const existing = { sessionId: 'session-dsh-2', conversationId: 'dsh-2', title: '会话 session-d', cwd: 'E:/work', projectionVersion: PROJECTION_VERSION - 1, workDir: '' }
  service.runtime = { async listSessions() { return [{ id: 'session-dsh-2', cwd: 'E:/work', title: '修好后的标题', status: 'idle' }] } }
  service.bindings = {
    getBySession: (id) => (id === 'session-dsh-2' ? existing : null),
    set(binding) { writes.push(binding); return binding },
  }
  service.conversations = new Map()
  service.session = SESSION
  service.deviceId = 'device-1'
  service.sessionsMigrated = 0
  service.noteCommand = () => {}
  service.publishConversationBroadcast = async (event) => broadcasts.push(event)
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, msg: 'OK', data: { id: 'dsh-2' } }) }
  }
  try {
    await service.migrateLocalSessions({ info() {} })
    assert.equal(calls.length, 1, 'one update request; the bulk migration is not used to refresh')
    assert.ok(calls[0].url.endsWith('/console/as/conversations/dsh-2'), calls[0].url)
    assert.deepEqual(calls[0].body, { title: '修好后的标题', isPlayground: 1 })
    assert.equal(writes[0].title, '修好后的标题')
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0].type, 'conversation.updated')
    assert.equal(broadcasts[0].cwd, '', 'a session in no workspace reports no space')
    assert.equal(broadcasts[0].title, '修好后的标题')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('a binding from an older record shape is refreshed once, even when its title already matches', async () => {
  // The registry has no list endpoint, so a record an earlier build wrote cannot
  // be read back and compared. The version is what retires it: every binding from
  // an older shape posts its current title and grouping once. That is what moves
  // the sessions an earlier build reported under the host's install directory —
  // the phone showed them in a space named after that directory while the sidebar
  // files them under 未分组.
  const service = Object.create(AgentosRemoteService.prototype)
  const writes = []
  const broadcasts = []
  const existing = { sessionId: 'session-dsh-3', conversationId: 'dsh-3', title: '已经正确', cwd: 'C:/install', projectionVersion: PROJECTION_VERSION - 1 }
  service.runtime = { async listSessions() { return [{ id: 'session-dsh-3', cwd: 'E:/work', title: '已经正确', status: 'idle', workspace: { id: 'ws-1', path: 'E:/work/proj', title: 'proj' } }] } }
  service.bindings = { getBySession: (id) => (id === 'session-dsh-3' ? existing : null), set(binding) { writes.push(binding); return binding } }
  service.conversations = new Map()
  service.session = SESSION
  service.deviceId = 'device-1'
  service.sessionsMigrated = 0
  service.noteCommand = () => {}
  service.publishConversationBroadcast = async (event) => broadcasts.push(event)
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, msg: 'OK', data: { id: 'dsh-3' } }) }
  }
  try {
    await service.migrateLocalSessions({ info() {} })
    assert.deepEqual(calls[0].body, { title: '已经正确', isPlayground: 0 })
    assert.equal(broadcasts[0].cwd, 'E:/work/proj', 'the workspace is the space the app groups by')
    assert.equal(writes[0].projectionVersion, PROJECTION_VERSION)
    assert.equal(writes[0].workDir, 'E:/work/proj')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('history page projects controller DSH event records and resolves conversation ids', async () => {
  const service = Object.create(AgentosRemoteService.prototype)
  service.bindings = {
    getBySession: () => null,
    getByConversation: (id) => id === 'cloud-id' ? { sessionId: 'dsh-id', conversationId: 'cloud-id' } : null,
  }
  service.runtime = { async page(request) {
    assert.equal(request.sessionId, 'dsh-id')
    return { records: [{ seq: 7, type: 'user/message', data: { id: 'u1', content: [{ type: 'text', text: 'hello' }] } }], hasMore: false }
  } }
  const result = await service.dispatchCommand({ type: 'get_page', sessionId: 'cloud-id', commandId: 'req' }, { info() {} })
  assert.equal(result.sessionId, 'dsh-id')
  assert.equal(result.conversationId, 'cloud-id')
  assert.equal(result.messages[0].params.update.content.text, 'hello')
})

await check('cloud list follows cursors and migration preserves DSH session ids', async () => {
  let listCalls = 0
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init })
    if (url.includes('/migrations/legacy')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { accepted: true } }) }
    listCalls++
    const data = listCalls === 1
      ? { conversations: [{ sessionId: 'session-1', conversationId: 'cloud-1' }], hasMore: true, nextCursor: 'opaque/next' }
      : { conversations: [{ sessionId: 'session-2', conversationId: 'cloud-2' }], hasMore: false }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) }
  }
  const listed = await listCloudConversations(SESSION, { deviceId: 'device-1', syncBase: 'https://sync.test' }, fetchImpl)
  assert.deepEqual(listed.map((entry) => entry.sessionId), ['session-1', 'session-2'])
  assert.match(requests[1].url, /cursor=opaque%2Fnext/)
  await migrateLegacySessions(SESSION, 'device-1', [{ sessionId: 'session-1', title: 'task' }], { syncBase: 'https://sync.test' }, fetchImpl)
  const migration = requests.at(-1)
  const body = JSON.parse(migration.init.body)
  assert.equal(body.sessions[0].sessionId, 'session-1')
  assert.equal(body.sessions[0].sourceDeviceId, 'device-1')
})

await check('history page resolves an unbound conversation id', async () => {
  // For a local record the cloud conversationId IS the session id, so a
  // conversation this process never registered still pages correctly. Bailing
  // out without a binding made every listed-but-unregistered session load empty.
  const service = Object.create(AgentosRemoteService.prototype)
  service.bindings = { getBySession: () => null, getByConversation: () => null }
  service.runtime = { async page(request) {
    assert.equal(request.sessionId, 'session-4de0592e')
    return { records: [{ seq: 2, type: 'user/message', data: { id: 'u1', content: [{ type: 'text', text: 'from history' }] } }], hasMore: false }
  } }
  const result = await service.dispatchCommand({ type: 'get_page', sessionId: 'session-4de0592e', commandId: 'req' }, { info() {} })
  assert.equal(result.sessionId, 'session-4de0592e')
  assert.equal(result.conversationId, 'session-4de0592e')
  assert.equal(result.messages[0].params.update.content.text, 'from history')
})

await check('an untitled session gets a readable placeholder, not the raw id prefix', () => {
  // DSH ids already start with `session-`, so slicing the raw id named
  // untitled sessions "会话 session-" in the phone's list.
  const service = Object.create(AgentosRemoteService.prototype)
  assert.equal(service.titleForSession({ id: 'session-4de0592e-030e-4351', title: undefined }), '会话 4de0592e')
  assert.equal(service.titleForSession({ id: 'session-4de0592e', title: '真实标题' }), '真实标题')
})

await check('lifecycle REST helpers use WorkBuddy routes and reject failed responses', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { code: 0, data: {} } }))
  await mutateCloudConversation(SESSION, 'conv/a', 'rename', { title: 'Renamed', isUserDefinedTitle: 1 }, { syncBase: 'https://sync.test' }, fetchImpl)
  await mutateCloudConversation(SESSION, 'conv/a', 'archive', {}, { syncBase: 'https://sync.test' }, fetchImpl)
  await mutateCloudConversation(SESSION, 'conv/a', 'unarchive', {}, { syncBase: 'https://sync.test' }, fetchImpl)
  await mutateCloudConversation(SESSION, 'conv/a', 'delete', {}, { syncBase: 'https://sync.test' }, fetchImpl)
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://sync.test/console/as/conversations/conv%2Fa',
    'https://sync.test/console/as/conversations/conv%2Fa/archive',
    'https://sync.test/console/as/conversations/conv%2Fa/unarchive',
    'https://sync.test/console/as/conversations/conv%2Fa/delete',
  ])
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Renamed', isUserDefinedTitle: 1 })
  assert.deepEqual(JSON.parse(calls[1].init.body), {})
  const failedFetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' })
  await assert.rejects(() => mutateCloudConversation(SESSION, 'conv-1', 'archive', {}, {}, failedFetch), /HTTP 503/)
})

await check('rename and archive preserve distinct conversation and session ids; delete is explicit', async () => {
  const service = Object.create(AgentosRemoteService.prototype)
  const calls = []
  const binding = { sessionId: 'dsh-session', conversationId: 'cloud-conversation', cwd: '/work', title: 'Old' }
  service.bindings = {
    getByConversation: (id) => id === binding.conversationId ? binding : null,
    getBySession: (id) => id === binding.sessionId ? binding : null,
    set: (value) => { Object.assign(binding, value); calls.push(['binding', value]); return value },
    delete: (id) => { calls.push(['delete-binding', id]); return true },
  }
  service.session = SESSION
  service.deviceId = 'device-1'
  service.publishConversationBroadcast = async (event) => calls.push(['broadcast', event])
  service.stopTurnWatcher = () => {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(['fetch', url, JSON.parse(init.body || '{}')])
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }
  }
  try {
    const renamed = await service.dispatchCommand({ type: 'wb:conversations:rename', args: [{ conversationId: binding.conversationId, title: 'New' }] }, { info() {} })
    assert.equal(renamed.conversationId, 'cloud-conversation')
    assert.equal(renamed.sessionId, 'dsh-session')
    assert.equal(calls.find(([kind]) => kind === 'fetch')[1], 'https://www.workbuddy.cn/console/as/conversations/cloud-conversation')
    assert.equal(calls.find(([kind, event]) => kind === 'broadcast' && event.type === 'conversation.renamed')[1].sessionId, 'dsh-session')
    const archived = await service.dispatchCommand({ type: 'wb:conversations:archive', args: [{ conversationId: binding.conversationId }] }, { info() {} })
    assert.equal(archived.archived, true)
    const deleted = await service.dispatchCommand({ type: 'wb:conversations:delete', args: [{ conversationId: binding.conversationId }] }, { info() {} })
    assert.equal(deleted.success, false)
    assert.match(deleted.error, /session:delete/)
    assert.equal(calls.some(([kind]) => kind === 'delete-binding'), false, 'unsupported deletion must not mutate the local mapping')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('pin mutation remains explicit until a local WorkBuddy store bridge exists', async () => {
  const service = Object.create(AgentosRemoteService.prototype)
  const result = await service.dispatchCommand({ type: 'wb:conversations:pin' }, { info() {} })
  assert.equal(result.success, false)
  assert.match(result.error, /local desktop database/)
})

await check('an unsupported command is refused rather than silently dropped', async () => {
  const service = Object.create(AgentosRemoteService.prototype)
  const result = await service.dispatchCommand({ type: 'get_artifact' }, { info: () => {} })
  assert.equal(result.success, false)
  assert.match(result.error, /get_artifact/)
})

await check('prompt text is read from either the prompt field or a text block', () => {
  assert.equal(promptTextOf({ prompt: '  hello ' }), 'hello')
  assert.equal(promptTextOf({ content: [{ type: 'image' }, { type: 'text', text: ' from block ' }] }), 'from block')
  assert.equal(promptTextOf({}), '')
})

console.log(failed === 0 ? '\nall conversation-sync checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
