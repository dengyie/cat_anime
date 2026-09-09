const { test } = require('node:test')
const assert = require('node:assert/strict')

async function setup({ fetchImpl, persistKey = async () => {} } = {}) {
  const { createAiDomain } = await import('../../services/backend/domains/ai/core.js')
  const { createEmptyState } = await import('../../services/backend/domains/ai/talk-store.js')
  let state = createEmptyState()
  let settings = { version: 0, values: { ai: { enabled: true, model: 'fixture', conversations: { imported: [{ role: 'user', content: 'old' }] } } } }
  const keys = new Map([['ai.default', 'test-key']])
  const patches = []
  const domain = createAiDomain({
    repository: { loadState: () => structuredClone(state), commitState: (next) => { state = structuredClone(next) } },
    settings: { read: () => structuredClone(settings) },
    mutationAuthority: { patch: (request) => {
      assert.equal(request.ifVersion, settings.version)
      patches.push(request)
      settings = { version: settings.version + 1, values: { ...settings.values, ...request.patch } }
    } },
    secrets: { get: (ref) => keys.get(ref) || '', set: async (ref, value) => { await persistKey(); keys.set(ref, value); return { configured: true } } },
    getActivePetPack: async () => ({ manifest: { id: 'cat', displayName: 'Cat', actions: [] } }),
    fetchImpl,
  })
  return { domain, patches, state: () => state, keys }
}

test('AI backend owns provider execution and stores completed turns without rewriting settings', async () => {
  let auth
  const { domain, patches, state } = await setup({ fetchImpl: async (_url, options) => {
    auth = options.headers.Authorization
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  } })
  const result = await domain.chat({ message: 'hi', requestId: 'one' })
  assert.equal(auth, 'Bearer test-key')
  assert.equal(result.reply, 'hello')
  assert.equal(state().messages['control-center:cat:main'].length, 2)
  assert.equal(patches.length, 0)
  domain.saveConfig({ systemPrompt: 'updated' })
  assert.equal(patches.length, 1)
  assert.equal(patches[0].patch.ai.conversations.imported[0].content, 'old')
  assert.equal(JSON.stringify(domain.snapshot()).includes('test-key'), false)
  await domain.dispose()
})

test('AI key writes settle encrypted persistence before the response and key state change', async () => {
  let settle
  const { domain, keys } = await setup({ persistKey: () => new Promise((resolve) => { settle = resolve }) })
  let completed = false
  const pending = domain.saveKey('vision', 'new-key').then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.equal(keys.has('ai.vision'), false)
  settle()
  await pending
  assert.equal(keys.get('ai.vision'), 'new-key')
  await domain.dispose()
})

test('AI backend cancellation aborts the matching provider and does not persist partial messages', async () => {
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const { domain, state } = await setup({ fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    started()
  }) })
  const pending = domain.chat({ message: 'hi', requestId: 'cancel-me' })
  await ready
  assert.deepEqual(domain.cancel('cancel-me'), { requestId: 'cancel-me', canceled: true })
  const result = await pending
  assert.equal(result.canceled, true)
  assert.deepEqual(state().messages['control-center:cat:main'].map(({ role, content }) => ({ role, content })), [{ role: 'user', content: 'hi' }])
  await domain.dispose()
})
