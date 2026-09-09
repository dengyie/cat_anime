const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { setTimeout: delay } = require('node:timers/promises')
const { createParser } = require('eventsource-parser')
const { createAiSidecarProxy } = require('../../src/main/ai-sidecar-proxy')

async function setup(t, { fetchImpl, present } = {}) {
  const { createAiDomain } = await import('../../services/backend/domains/ai/core.js')
  const { createEmptyState } = await import('../../services/backend/domains/ai/talk-store.js')
  const { createRouter } = await import('../../services/backend/http/router.js')
  const middleware = await import('../../services/backend/http/middleware.js')
  const { registerAiRuntimeRoutes } = await import('../../services/backend/routes/ai-runtime.js')
  let state = createEmptyState()
  let packId = 'cat'
  const domain = createAiDomain({
    repository: { loadState: () => structuredClone(state), commitState: (value) => { state = structuredClone(value) } },
    settings: { read: () => ({ version: 0, values: { ai: { enabled: true, model: 'fixture' } } }) },
    mutationAuthority: { patch() { throw new Error('Chat must not write settings') } },
    secrets: { get: () => 'fixture-key' },
    getActivePetPack: async () => ({ manifest: { id: packId, displayName: packId, actions: [] } }),
    fetchImpl,
  })
  const router = createRouter({ basePath: '/api/v1' })
  router.use(middleware.requestId())
  router.use(middleware.errorBoundary())
  router.use(middleware.bearerAuth({ getSessionToken: () => 'session' }))
  router.use(middleware.jsonBody())
  registerAiRuntimeRoutes(router, { getDomain: () => domain, present })
  const server = createServer((req, res) => void router.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const backend = { baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, sessionToken: 'session' }
  const proxy = createAiSidecarProxy({ getBackend: () => backend, getActivePetPackId: () => packId })
  t.after(async () => { proxy.aiTalkService.dispose(); await domain.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const send = (input, signal) => fetch(`${backend.baseUrl}/ai/chat`, {
    method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(input), signal,
  })
  return { domain, proxy, backend, send, state: () => state, setPack: (id) => { packId = id } }
}

function events(text) {
  const output = []
  createParser({ onEvent: (event) => output.push({ event: event.event, data: JSON.parse(event.data) }) }).feed(text)
  return output
}

function streamingResponse() {
  const chunks = ['hello', ' world'].map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`).join('')
  return new Response(`${chunks}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}

test('AI HTTP streams progress and one matching terminal result with durable message order', async (t) => {
  const shown = []
  const { send, state } = await setup(t, { fetchImpl: async () => streamingResponse(), present: async (result) => { shown.push(result); return result } })
  const response = await send({ message: 'hi', requestId: 'stream-1' })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const received = events(await response.text())
  assert.ok(received.some(({ event }) => event === 'ai.chat-delta'))
  const terminal = received.filter(({ event }) => event === 'ai.chat-done')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].data.requestId, 'stream-1')
  assert.equal(terminal[0].data.data.reply, 'hello world')
  assert.deepEqual(state().messages['control-center:cat:main'].map(({ content }) => content), ['hi', 'hello world'])
  assert.equal(shown.length, 1)
})

test('AI HTTP returns a redacted terminal error when the provider fails', async (t) => {
  const { send } = await setup(t, { fetchImpl: async () => { throw new Error('fixture-key private failure') } })
  const response = await send({ message: 'hi', requestId: 'failed' })
  const text = await response.text()
  const terminal = events(text).at(-1)
  assert.equal(terminal.event, 'ai.chat-done')
  assert.equal(terminal.data.ok, false)
  assert.equal(terminal.data.requestId, 'failed')
  assert.doesNotMatch(text, /fixture-key|private failure/)
})

test('Disconnecting the AI stream aborts the provider and suppresses presentation', async (t) => {
  const started = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const shown = []
  const { send } = await setup(t, {
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted.resolve(true); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
      started.resolve()
    }),
    present: async (result) => { shown.push(result); return result },
  })
  const controller = new AbortController()
  const response = await send({ message: 'hi', requestId: 'disconnect' }, controller.signal)
  await started.promise
  controller.abort()
  await response.body.cancel().catch(() => {})
  assert.equal(await Promise.race([aborted.promise, delay(500).then(() => false)]), true)
  assert.equal(shown.length, 0)
})

test('Shell proxy parses SSE at the versioned backend URL and never requests host presentation', async (t) => {
  const { proxy } = await setup(t, { fetchImpl: async () => streamingResponse(), present: () => { throw new Error('Shell requests must present locally') } })
  const received = []
  const result = await proxy.aiTalkService.streamChat({ message: 'hi', requestId: 'proxy', onState: (state) => received.push(state) })
  assert.equal(result.reply, 'hello world')
  assert.ok(received.length > 0)
  assert.equal(proxy.aiTalkService.getConversation().at(-1).content, 'hello world')
})

test('Shell proxy forwards caller cancellation to its streaming HTTP request', async (t) => {
  const started = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const { proxy } = await setup(t, { fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted.resolve(true); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    started.resolve()
  }) })
  const controller = new AbortController()
  const result = proxy.aiTalkService.streamChat({ message: 'hi', requestId: 'caller-cancel', signal: controller.signal }).catch((error) => error)
  await started.promise
  controller.abort()
  assert.equal(await Promise.race([aborted.promise, delay(500).then(() => false)]), true)
  await result
})

test('AI HTTP rejects malformed input before opening a stream or invoking the provider', async (t) => {
  let calls = 0
  const { send } = await setup(t, { fetchImpl: async () => { calls++; return streamingResponse() } })
  for (const input of [[], { message: '' }, { message: 'hi', requestId: {} }, { message: 'x'.repeat(4001) }]) {
    const response = await send(input)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'VALIDATION_FAILED')
  }
  assert.equal(calls, 0)
})

test('Canceling a queued chat never starts a second provider or persists its message', async (t) => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let calls = 0
  const { send, backend, state } = await setup(t, { fetchImpl: async () => { calls++; started.resolve(); await release.promise; return streamingResponse() } })
  const first = await send({ message: 'first', requestId: 'first', present: false })
  await started.promise
  const queued = await send({ message: 'must not persist', requestId: 'queued', present: false })
  const cancel = await fetch(`${backend.baseUrl}/ai/chat/queued/cancel`, { method: 'POST', headers: { authorization: 'Bearer session' } })
  assert.deepEqual((await cancel.json()).data, { requestId: 'queued', canceled: true })
  release.resolve()
  await first.text()
  const terminal = events(await queued.text()).at(-1)
  assert.equal(terminal.data.data.canceled, true)
  assert.equal(calls, 1)
  assert.deepEqual(state().messages['control-center:cat:main'].map(({ content }) => content), ['first', 'hello world'])
})

test('A pack switch preserves the original turn ownership and hydrates only the new pack in Shell', async (t) => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { proxy, setPack, state } = await setup(t, { fetchImpl: async () => { started.resolve(); await release.promise; return streamingResponse() } })
  const pending = proxy.aiTalkService.streamChat({ message: 'original', requestId: 'switch' })
  await started.promise
  setPack('new-pack')
  release.resolve()
  const result = await pending
  assert.equal(result.petPackId, 'cat')
  assert.equal(state().messages['control-center:cat:main'].at(-1).content, 'hello world')
  assert.deepEqual(proxy.aiTalkService.getConversation(), [])
  assert.equal(proxy.aiTalkService.getPersonaProfile().petPackId, 'new-pack')
})
