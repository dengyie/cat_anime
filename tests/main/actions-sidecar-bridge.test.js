const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { createActionsSidecarBridge } = require('../../src/main/ipc/actions-sidecar-bridge')
const { createActionImportService } = require('../../src/main/services/action-import-service')

function fixture(overrides = {}) {
  const calls = []
  let activePackId = 'active-cat'
  const view = { defaultAction: 'idle', clickAction: 'wave', actions: [{ id: 'idle' }, { id: 'wave' }], triggerRuntimeDiagnostics: { decisions: [] } }
  const bridge = createActionsSidecarBridge({
    actionService: {}, petService: {}, getPetWindow: () => null,
    getActivePackId: () => activePackId,
    showOpenDialogForEvent: async (event) => { calls.push(['dialog', event]); return { canceled: false, filePaths: ['/selected/frames'] } },
    actionImportService: {
      inspectActionFrames: async (input) => { calls.push(['inspect', input]); return { actionId: input.actionId, folderName: 'frames', inspection: { valid: true } } },
      importActionFrames: async (input) => { calls.push(['import', input]); return { importedAction: { id: input.actionId } } },
    },
    createActionsViewState: () => view,
    reloadAndSendAnimations: () => { calls.push(['reload']); return view },
    refreshTriggerRuleRuntime: () => {}, recordAppLog: () => {},
    ...overrides,
  })
  return { bridge, calls, view, setActivePackId: (id) => { activePackId = id } }
}

test('native Actions selection is opaque and reused by reinspection and import', async () => {
  const { bridge, calls, view } = fixture()
  const event = { sender: {} }
  const selection = await bridge.inspect(event, { actionId: 'jump' })
  assert.match(selection.selectionId, /^[0-9a-f-]{36}$/)
  assert.equal('path' in selection || 'sourceDir' in selection, false)
  assert.deepEqual(calls[0], ['dialog', event])
  const reinspected = await bridge.handle({ operation: 'reinspect', payload: { selectionId: selection.selectionId, actionId: 'jump' } })
  assert.equal(reinspected.selectionId, selection.selectionId)
  const result = await bridge.handle({ operation: 'import', payload: { selectionId: selection.selectionId, actionId: 'jump', label: 'Jump' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.animations, view)
  assert.deepEqual(calls.find(([operation]) => operation === 'import'), ['import', { sourceDir: '/selected/frames', actionId: 'jump', label: 'Jump' }])
  await assert.rejects(() => bridge.handle({ operation: 'reinspect', payload: { selectionId: selection.selectionId, actionId: 'jump' } }), { code: 'NOT_FOUND' })
})

test('queued Actions import rejects a selection from a different active pet pack', async () => {
  const { bridge, calls, setActivePackId } = fixture()
  const selection = await bridge.inspect(null, { actionId: 'jump' })
  setActivePackId('another-cat')
  await assert.rejects(() => bridge.handle({ operation: 'import', payload: { selectionId: selection.selectionId, actionId: 'jump' } }), { code: 'CONFLICT' })
  assert.equal(calls.some(([operation]) => operation === 'import'), false)
})

test('an invalid frame inspection returns its diagnostics without importing or clearing the selection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpet-actions-empty-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const frames = path.join(root, 'empty')
  fs.mkdirSync(frames)
  const actionImportService = createActionImportService({ framesRoot: path.join(root, 'frames'), spritesDir: path.join(root, 'sprites'), configPath: path.join(root, 'animations.json') })
  const { bridge } = fixture({ actionImportService, showOpenDialogForEvent: async () => ({ canceled: false, filePaths: [frames] }) })
  const selection = await bridge.inspect(null, { actionId: 'jump' })
  assert.equal(selection.inspection.valid, false)
  const result = await bridge.handle({ operation: 'import', payload: { selectionId: selection.selectionId, actionId: 'jump' } })
  assert.equal(result.ok, false)
  assert.equal(result.inspectionResult.selectionId, selection.selectionId)
  assert.ok(result.inspectionResult.inspection.errors.length > 0)
  assert.equal(fs.existsSync(path.join(root, 'animations.json')), false)
  const retry = await bridge.handle({ operation: 'reinspect', payload: { selectionId: selection.selectionId, actionId: 'jump' } })
  assert.equal(retry.selectionId, selection.selectionId)
})
