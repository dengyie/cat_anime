const assert = require('node:assert/strict')
const { createServer } = require('node:http')

async function createAiHttpHarness(t, { aiService, aiTalkService, behaviorOrchestratorService }) {
  const { createRouter } = await import('../../services/backend/http/router.js')
  const middleware = await import('../../services/backend/http/middleware.js')
  const { registerAiRuntimeRoutes } = await import('../../services/backend/routes/ai-runtime.js')
  const { registerAiSecretRoutes } = await import('../../services/backend/routes/ai.js')
  const router = createRouter({ basePath: '/api/v1' })
  router.use(middleware.requestId())
  router.use(middleware.errorBoundary())
  router.use(middleware.jsonBody())
  registerAiRuntimeRoutes(router, { getDomain: () => ({
    provider: aiService,
    saveConfig: (input) => aiService.saveConfig(input),
    invokeTalk: (method, ...args) => aiTalkService[method](...args),
    behavior: behaviorOrchestratorService,
    publishSnapshot() {},
  }) })
  registerAiSecretRoutes(router, { secrets: {
    set: async (id, value) => {
      const result = await aiService[id === 'ai.vision' ? 'saveVisionApiKey' : 'saveApiKey'](value)
      return { configured: result.hasApiKey, maskedTail: 'masked' }
    },
    clear: async () => { await aiService.clearVisionApiKey(); return { configured: false, maskedTail: '' } },
  } })
  const server = createServer((req, res) => void router.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  return async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json()
    assert.equal(response.status, 200, JSON.stringify(payload))
    assert.equal(payload.ok, true)
    return payload.data
  }
}

module.exports = { createAiHttpHarness }
