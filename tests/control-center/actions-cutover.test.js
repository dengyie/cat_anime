const assert = require('node:assert/strict')
const { test } = require('node:test')

const view = { defaultAction: 'idle', clickAction: 'wave', actions: [{ id: 'idle' }, { id: 'wave' }], triggerRules: [], triggerProposalInbox: [], triggerRuntimeDiagnostics: { decisions: [] } }
const completed = { ok: true, canceled: false, animations: view, result: { importedAction: { id: 'wave', label: 'Wave' } } }
const success = (data) => ({ ok: true, data, meta: { requestId: 'actions-test', elapsedMs: 1 } })

test('Actions HTTP returns the active view and preserves diagnostic fields', async () => {
  const { createActionsHttpApi } = await import('../../src/control-center/src/features/actions/api.ts')
  const { createApiClient } = await import('../../src/control-center/src/api/client.ts')
  const requests = []
  const client = createApiClient({ request: async (request) => { requests.push(request); return success(view) } })
  assert.deepEqual(await createActionsHttpApi(client).getActions(), view)
  assert.equal(requests[0].path, '/actions')
})

test('Actions preserves native selection handles and does not turn queued jobs into import results', async () => {
  const { createActionsHttpApi } = await import('../../src/control-center/src/features/actions/api.ts')
  const { createApiClient } = await import('../../src/control-center/src/api/client.ts')
  const requests = []
  const responses = [
    { canceled: false, selectionId: 'native:one', folderName: 'frames', actionId: 'wave', inspection: { valid: true } },
    { ok: true }, { jobId: 'import-1' },
  ]
  const client = createApiClient({ request: async (request) => { requests.push(request); return success(responses.shift()) } })
  const api = createActionsHttpApi(client)
  await api.reinspectActionFrames({ selectionId: 'native:one', actionId: 'wave' })
  await api.clearActionFrameSelection({ selectionId: 'native:one' })
  assert.deepEqual(await api.importActionFrames({ selectionId: 'native:one', actionId: 'wave', label: 'Wave' }), { jobId: 'import-1' })
  assert.deepEqual(JSON.parse(requests[0].body), { selectionId: 'native:one', actionId: 'wave' })
  assert.equal(requests[1].path, '/actions/frames/selection?selectionId=native%3Aone')
  assert.deepEqual(JSON.parse(requests[2].body), { selectionId: 'native:one', actionId: 'wave', label: 'Wave' })
})

test('Actions initial inspection goes through the injected native picker', async (t) => {
  const previous = globalThis.window
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous })
  const calls = []
  globalThis.window = { controlCenterAPI: { inspectActionFrames: async (payload) => { calls.push(payload); return { canceled: false, selectionId: 'native-selection' } } } }
  const { actionsHttpApi } = await import('../../src/control-center/src/features/actions/api.ts')
  assert.deepEqual(await actionsHttpApi.inspectActionFrames({ actionId: 'wave' }), { canceled: false, selectionId: 'native-selection' })
  assert.deepEqual(calls, [{ actionId: 'wave' }])
})

test('Actions Job resolution waits for terminal evidence and surfaces failures or invalid results', async () => {
  const { resolveActionImportJob } = await import('../../src/control-center/src/features/actions/api.ts')
  for (const job of [null, { status: 'queued', result: completed }, { status: 'running', result: completed }]) {
    assert.deepEqual(resolveActionImportJob(job), { kind: 'pending' })
  }
  assert.deepEqual(resolveActionImportJob({ status: 'succeeded', result: completed }), { kind: 'succeeded', result: completed })
  for (const status of ['failed', 'canceled', 'interrupted']) assert.equal(resolveActionImportJob({ status }).kind, 'failed')
  assert.equal(resolveActionImportJob({ status: 'failed', error: { message: 'Active pack changed' } }).message, 'Active pack changed')
  assert.equal(resolveActionImportJob({ status: 'succeeded', result: { jobId: 'still-queued' } }).kind, 'failed')
  const invalidFrames = { ok: false, inspectionResult: { canceled: false, selectionId: 'keep-for-retry', inspection: { valid: false, errors: ['Missing alpha'] } } }
  assert.deepEqual(resolveActionImportJob({ status: 'succeeded', result: invalidFrames }), { kind: 'succeeded', result: invalidFrames })
})

test('Actions SSE refreshes only new action-change events', async () => {
  const { nextActionsEventId } = await import('../../src/control-center/src/features/actions/api.ts')
  assert.equal(nextActionsEventId({ lastEventId: '1', lastEventName: 'pet.actions-changed' }, null), '1')
  assert.equal(nextActionsEventId({ lastEventId: '1', lastEventName: 'pet.actions-changed' }, '1'), null)
  assert.equal(nextActionsEventId({ lastEventId: '2', lastEventName: 'pet.pack-activated' }, null), null)
})
