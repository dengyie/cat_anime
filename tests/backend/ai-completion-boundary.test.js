const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')

async function setup(t) {
  const { createAiDomain } = await import('../../services/backend/domains/ai/core.js')
  const { createEmptyState } = await import('../../services/backend/domains/ai/talk-store.js')
  const { createRouter } = await import('../../services/backend/http/router.js')
  const middleware = await import('../../services/backend/http/middleware.js')
  const { registerAiRuntimeRoutes } = await import('../../services/backend/routes/ai-runtime.js')
  let state = createEmptyState()
  let settings = { version: 0, values: { ai: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://chat.example/v1', model: 'chat-model' } } }
  const calls = []
  const patches = []
  const domain = createAiDomain({
    repository: { loadState: () => structuredClone(state), commitState: (next) => { state = structuredClone(next) } },
    settings: { read: () => structuredClone(settings) },
    mutationAuthority: { patch: (request) => {
      assert.equal(request.ifVersion, settings.version)
      patches.push(request)
      settings = { version: settings.version + 1, values: { ...settings.values, ...request.patch } }
    } },
    secrets: { get: (ref) => ({ 'ai.default': 'chat-secret', 'ai.hatch-pet': 'hatch-secret', 'other-secret': 'unrelated-secret' })[ref] || '' },
    getActivePetPack: async () => ({ manifest: { id: 'cat', displayName: 'Cat', actions: [] } }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return Response.json({ choices: [{ message: { content: 'ok', tool_calls: [{ type: 'function', function: { name: 'inspect', arguments: '{"ok":true}' } }] }, finish_reason: 'tool_calls' }] })
    },
  })
  const router = createRouter({ basePath: '/api/v1' })
  router.use(middleware.requestId())
  router.use(middleware.errorBoundary())
  router.use(middleware.bearerAuth({ getSessionToken: () => 'session' }))
  router.use(middleware.jsonBody())
  registerAiRuntimeRoutes(router, { getDomain: () => domain })
  const server = createServer((req, res) => void router.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await domain.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  return { domain, calls, patches, send: (path, body, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
    method, headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) }
}

const request = { messages: [{ role: 'user', content: 'inspect' }], tool: { type: 'function', function: { name: 'inspect', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } }

test('HTTP completions reject caller-owned provider routing before invoking any provider', async (t) => {
  const { send, calls } = await setup(t)
  for (const override of [{ configOverride: { baseUrl: 'https://untrusted.example/v1', apiKeyRef: 'other-secret', model: 'x' } }, { apiKeyRef: 'other-secret' }, { signal: {} }]) {
    const response = await send('/ai/completions', { method: 'completeStructuredTool', request: { ...request, ...override } })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'VALIDATION_FAILED')
  }
  assert.equal(calls.length, 0)
})

test('Hatch completions resolve the latest configuration and its canonical secret in the backend', async (t) => {
  const { send, calls, patches } = await setup(t)
  const config = await send('/ai/hatch/config', { configMode: 'override', baseUrl: 'https://hatch.example/v1', provider: 'openai-compatible', model: 'hatch-model' }, 'PATCH')
  assert.equal(config.status, 200)
  assert.equal(patches.length, 1)
  const response = await send('/ai/completions', { method: 'completeStructuredTool', capability: 'hatch-pet', request })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://hatch.example/v1/chat/completions')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer hatch-secret')
  assert.equal(JSON.parse(calls[0].options.body).model, 'hatch-model')
  assert.equal(JSON.stringify(await config.json()).includes('hatch-secret'), false)
})
