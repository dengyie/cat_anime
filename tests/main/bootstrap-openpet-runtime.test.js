const test = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: setImmediatePromise } = require('node:timers/promises')

const { createOpenPetRuntime } = require('../../src/main/bootstrap/create-openpet-runtime')

test('bootstrap runtime wires plugin install and service block-status lookups through the created catalog service', async () => {
  const dialogCalls = []
  const pluginInstallCandidates = []
  const pluginServiceCandidates = []
  const createWindowCalls = []
  const loadPetWindowCalls = []
  const smokeCalls = []
  const cleanupCalls = []
  const appHandlers = new Map()
  const screenHandlers = new Map()
  const registeredIpcDependencies = []
  const safeLogs = []
  const settingsWindowPayloads = []
  const saveSettingsCalls = []
  const persistenceRequests = []
  const fetchCalls = []
  const fetchImpl = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/ai/state')) return new Response(JSON.stringify({ ok: true, data: { config: {}, messages: [], petPackId: '' } }))
    return new Response(JSON.stringify({ ok: true, data: {
      version: 1,
      values: { ...settings, customCursorScope: 'system', petBehavior: { home: { enabled: true, anchor: { displayId: 'old-display', x: 1, y: 2 } } } }
    } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let unexpectedCursorExit
  let coordinatorOnReady
  let coordinatorDependencies
  let backend = null
  let sidecarStartCalls = 0
  const settings = {
    scale: 1,
    autoStart: false,
    localHttp: {},
    petBehavior: { home: { enabled: true, anchor: { displayId: 'old-display', x: 1, y: 2 } } },
    customCursorScope: 'system',
    customCursor: { enabled: true, assetPath: '/tmp/cursor.png', assetUrl: 'file:///tmp/cursor.png' },
    plugins: { enabled: {}, config: {}, storage: {}, logs: [] },
    ai: { behavior: {} },
    petPacks: { activePackId: 'starter', installed: {} },
    ecosystem: { blocklist: { pluginIds: [], packIds: [], sha256: [] } }
  }
  let petWindow = {
    webContents: { on: (eventName, handler) => { if (eventName === 'did-finish-load') petWindow.didFinishLoad = handler }, send: () => {} },
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    setPosition: () => {},
    isDestroyed: () => false
  }

  const runtime = createOpenPetRuntime({
    app: {
      getPath: () => '/tmp/openpet-runtime-test',
      on: (eventName, handler) => { appHandlers.set(eventName, handler) }
    },
    BrowserWindow: {
      getAllWindows: () => [petWindow]
    },
    dialog: {
      showOpenDialog: async (options) => {
        dialogCalls.push(options)
        return { canceled: false, filePaths: ['/tmp/frames'] }
      }
    },
    shell: { openExternal: () => {} },
    screen: { on: (eventName, handler) => { screenHandlers.set(eventName, handler) } },
    projectRoot: '/workspace/OpenPet',
    packageJson: { version: '1.0.0' },
    settingsRuntime: {
      loadSettings: () => settings,
      saveSettings: () => {},
      syncLoginItemSettings: () => {}
    },
    getPetWindow: () => petWindow,
    setPetWindow: (nextPetWindow) => { petWindow = nextPetWindow },
    fetchImpl,
    createSettingsWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        send: (_channel, payload) => settingsWindowPayloads.push(payload)
      }
    }),
    createWindow: (options = {}) => {
      createWindowCalls.push(options)
      return petWindow
    },
    loadPetWindow: (targetWindow) => loadPetWindowCalls.push(targetWindow),
    registerAppLifecycleLogs: ({ appLogService, onBeforeQuit }) => {
      appLogService.record({ event: 'app.ready' })
      appHandlers.set('before-quit', onBeforeQuit)
    },
    safeRecordAppLog: (_service, entry) => safeLogs.push(entry),
    registerIpcHandlers: (dependencies) => registeredIpcDependencies.push(dependencies),
    createPetRendererSettings: (input) => input,
    normalizeLocalHttpConfig: (_current, nextConfig) => nextConfig,
    reloadAndSendAnimations: () => ({ actions: [] }),
    applyWindowScale: () => {},
    applyPetViewport: () => {},
    clampToWorkArea: (_window, x, y) => ({ x, y }),
    getMovementState: () => null,
    maybeRunPackagedRuntimeSmoke: (payload) => smokeCalls.push(payload),
    maybeRunPackagedCreatorStudioEvidence: () => {},
    maybeRunPackagedCreatorStudioUiE2e: () => {},
    maybeRunPackagedPluginCleanupEvidence: (payload) => cleanupCalls.push(payload),
    maybeRunPackagedCreatorStudioEvidence: () => {},
    maybeRunPackagedCreatorStudioUiE2e: () => {},
    maybeRunPackagedCreateUiSmoke: () => {},
    factories: {
      createAboutService: () => ({ id: 'about' }),
      createActionImportService: () => ({ id: 'action-import' }),
      createActionService: () => ({ id: 'action-service' }),
      createAiService: () => ({ id: 'ai-service' }),
      createAiTalkService: () => ({ id: 'ai-talk-service' }),
      createAiTalkStore: () => ({ id: 'ai-talk-store' }),
      createAppLogService: () => ({ record: () => {}, logPath: '/tmp/app-log.jsonl' }),
      createBasicBehaviorPlugin: () => ({ id: 'basic' }),
      createBehaviorOrchestratorService: () => ({ id: 'behavior' }),
      createCatalogService: () => ({
        getPluginBlockStatus: (candidate) => ({ blocked: candidate === 'blocked-plugin', reasons: candidate === 'blocked-plugin' ? ['policy'] : [] }),
        getPetPackBlockStatus: () => ({ blocked: false, reasons: [] }),
        listCatalog: () => ({ schemaVersion: 1, plugins: [], petPacks: [] })
      }),
      createCursorAssetService: () => ({ repairCursor: async () => ({}) }),
      createSystemCursorService: ({ onUnexpectedExit }) => {
        unexpectedCursorExit = onUnexpectedExit
        return { getStatus: () => ({ supported: true, platform: 'darwin', active: true, helperPid: 77 }), sync: async () => {}, dispose: async () => {} }
      },
      createCreatorStudioDefaultFlowService: () => ({
        id: 'creator-studio-default-flow',
        start: () => {},
        stop: () => {},
        refresh: () => {}
      }),
      createCreatorReferenceService: () => ({
        getReference: () => null,
        bindReference: async () => ({ replaced: false, reference: null }),
        copyReferenceIntoRun: () => ({})
      }),
      createCreatorStudioDefaultFlowService: () => ({
        id: 'creator-studio-default-flow',
        start: () => {},
        stop: () => {},
        refresh: () => {}
      }),
      createCreatorWorkflowService: () => ({ id: 'creator-workflow' }),
      createEventBus: () => ({ on: () => {}, emit: () => {} }),
      createImageGenerationModelService: () => ({ id: 'image-service' }),
      createHatchPetAgentService: (dependencies) => ({ id: 'hatch-pet-agent', dependencies }),
      createTriggerRuleRuntimeService: () => ({
        id: 'trigger-rule-runtime',
        start: () => {},
        stop: () => {},
        refresh: () => {},
        getDiagnostics: () => ({ currentState: { actionId: '' }, decisions: [] })
      }),
      createLocalHttpService: () => ({ start: async () => ({}) }),
      createPetBubbleChatWindowManager: () => ({ id: 'bubble-window' }),
      createPetChatWindowManager: () => ({ id: 'chat-window' }),
      createPetMovementPolicy: () => ({
        normalizeWindowForDisplay: () => ({ x: 0, y: 0 }),
        normalizePetBehaviorSettings: (behavior) => behavior || { home: { enabled: false, anchor: null } },
        resolveDisplayForWindow: () => ({ id: 'display-1' }),
        normalizeAnchorForDisplay: ({ anchor }) => ({ ...anchor, displayId: 'new-display', x: 30, y: 40 })
      }),
      createPetPackService: () => ({ id: 'pet-pack-service' }),
      createPetService: () => ({
        getSettings: () => settings,
        saveSettings: (next) => { saveSettingsCalls.push(next); Object.assign(settings, structuredClone(next)); return settings },
        applySettings: (next) => { Object.assign(settings, structuredClone(next)); return settings },
        reloadAnimations: () => ({ actions: [] })
      }),
      createPetUtteranceLogService: () => ({ id: 'utterance-log' }),
      createPluginGithubImportService: () => ({ id: 'github-import' }),
      createPluginInstallService: ({ getPluginBlockStatus }) => ({
        readBlockStatus: (candidate) => {
          pluginInstallCandidates.push(candidate)
          return getPluginBlockStatus(candidate)
        }
      }),
      createPluginService: ({ getPluginBlockStatus, selectCreatorAssetFrameFolder }) => ({
        readBlockStatus: (candidate) => {
          pluginServiceCandidates.push(candidate)
          return getPluginBlockStatus(candidate)
        },
        pickFrames: selectCreatorAssetFrameFolder,
        stopAllServices: () => {}
      }),
      createSecretService: () => undefined,
      createSettingsService: ({ loadSettings }) => ({ get: loadSettings, save: () => {}, preview: () => ({}) }),
      createSidecarRuntimeCoordinator: (dependencies) => {
        coordinatorDependencies = dependencies
        coordinatorOnReady = dependencies.onReady
        assert.equal(dependencies.secretService, undefined)
        assert.equal(dependencies.getSettings().localHttp, settings.localHttp)
        assert.equal(typeof dependencies.pidLedger.sweep, 'function')
        assert.equal(typeof dependencies.pidLedger.register, 'function')
        assert.equal(typeof dependencies.pidLedger.unregister, 'function')
        return {
          start: () => {
            sidecarStartCalls += 1
            return Promise.reject(new Error('unexpected coordinator rejection'))
          },
          stop: async () => {},
          getBackend: () => backend,
          requestBackend: async (body) => {
            persistenceRequests.push(body)
            return { body: { ok: true, version: persistenceRequests.length + 1, changedPaths: Object.keys(body.patch) } }
          },
          onChanged: () => () => {},
          getState: () => ({ status: 'degraded', backend: null, reason: 'SIDECAR_UNAVAILABLE' })
        }
      },
      syncBundledPlugins: () => ({ synced: [] })
    }
  })

  assert.ok(runtime)
  assert.equal(createWindowCalls.length, 1)
  assert.equal(loadPetWindowCalls.length, 1)
  assert.equal(registeredIpcDependencies.length, 1)
  assert.equal(screenHandlers.has('display-added'), true)
  assert.equal(typeof appHandlers.get('activate'), 'function')
  assert.equal(typeof coordinatorDependencies.onCatalogRequest, 'function')
  assert.deepEqual(await coordinatorDependencies.onCatalogRequest({ operation: 'listCatalog' }), {
    schemaVersion: 1,
    updatedAt: '',
    feedbackUrl: '',
    localBlocklist: { pluginIds: [], packIds: [], sha256: [] },
    catalogBlocklist: { pluginIds: [], packIds: [], sha256: [] },
    blocklist: { pluginIds: [], packIds: [], sha256: [] },
    plugins: [],
    petPacks: []
  })
  await setImmediatePromise()
  assert.equal(sidecarStartCalls, 1)
  assert.equal(runtime.sidecarRuntimeCoordinator.getState().status, 'degraded')
  assert.equal(safeLogs.some((entry) => entry.event === 'sidecar.startup.failed' && entry.message === 'unexpected coordinator rejection'), true)

  await unexpectedCursorExit()
  assert.equal(saveSettingsCalls.length, 0, 'cursor fallback must not write the legacy root while sidecar is unavailable')
  await screenHandlers.get('display-added')()
  assert.deepEqual(settings.petBehavior.home.anchor, { displayId: 'new-display', x: 30, y: 40 })

  backend = { baseUrl: 'http://127.0.0.1:3210/api/v1', sessionToken: 'session-token' }
  await coordinatorOnReady(backend)
  assert.deepEqual(fetchCalls.filter((call) => call.method === 'PATCH').map((call) => call.body.patch), [{ customCursorScope: 'openpet' }])
  assert.deepEqual(persistenceRequests.map((request) => request.patch), [
    { 'petBehavior.home.anchor': { displayId: 'new-display', x: 30, y: 40 } }
  ])
  assert.equal(fetchCalls.some((call) => call.method === 'GET'), true)

  const ipcDependencies = registeredIpcDependencies[0]
  assert.ok(ipcDependencies.sidecarRuntimeCoordinator)
  assert.ok(ipcDependencies.createSettingsWindow())
  assert.equal(settingsWindowPayloads.at(-1).__openpetSecretStorageSecurity, null)
  assert.equal(typeof ipcDependencies.sidecarRuntimeCoordinator.getBackend, 'function')
  assert.equal(ipcDependencies.hatchPetAgentService.id, 'hatch-pet-agent')
  assert.equal(ipcDependencies.creatorWorkflowService.id, 'creator-workflow')
  assert.deepEqual(ipcDependencies.pluginInstallService.readBlockStatus('blocked-plugin'), { blocked: true, reasons: ['policy'] })
  assert.deepEqual(ipcDependencies.pluginService.readBlockStatus('allowed-plugin'), { blocked: false, reasons: [] })
  assert.deepEqual(await ipcDependencies.pluginService.pickFrames(), { canceled: false, sourceDir: '/tmp/frames' })
  assert.equal(dialogCalls.length, 1)
  assert.deepEqual(pluginInstallCandidates, ['blocked-plugin'])
  assert.deepEqual(pluginServiceCandidates, ['allowed-plugin'])

  petWindow.didFinishLoad()
  assert.equal(smokeCalls.length, 1)
  assert.equal(cleanupCalls.length, 1)
})

test('bootstrap runtime waits for plugin shutdown before allowing app quit', async () => {
  const appHandlers = new Map()
  let resolveShutdown
  let quitCalls = 0
  const petWindow = {
    webContents: { on: () => {}, send: () => {} },
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    setPosition: () => {},
    isDestroyed: () => false
  }

  createOpenPetRuntime({
    app: {
      getPath: () => '/tmp/openpet-runtime-test',
      on: (eventName, handler) => { appHandlers.set(eventName, handler) },
      quit: () => { quitCalls += 1 }
    },
    BrowserWindow: { getAllWindows: () => [petWindow] },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: () => {} },
    screen: { on: () => {} },
    projectRoot: '/workspace/OpenPet',
    packageJson: { version: '1.0.0' },
    settingsRuntime: {
      loadSettings: () => ({
        scale: 1,
        autoStart: false,
        localHttp: {},
        petBehavior: { home: { enabled: false, anchor: null } },
        plugins: { enabled: {}, config: {}, storage: {}, logs: [] },
        ai: { behavior: {} },
        petPacks: { activePackId: 'starter', installed: {} },
        ecosystem: { blocklist: { pluginIds: [], packIds: [], sha256: [] } }
      }),
      saveSettings: () => {},
      syncLoginItemSettings: () => {}
    },
    getPetWindow: () => petWindow,
    setPetWindow: () => {},
    createSettingsWindow: () => {},
    createWindow: () => petWindow,
    loadPetWindow: () => {},
    registerAppLifecycleLogs: ({ onBeforeQuit }) => {
      appHandlers.set('before-quit', onBeforeQuit)
    },
    safeRecordAppLog: () => {},
    registerIpcHandlers: () => {},
    createPetRendererSettings: (input) => input,
    normalizeLocalHttpConfig: (_current, nextConfig) => nextConfig,
    reloadAndSendAnimations: () => ({ actions: [] }),
    applyWindowScale: () => {},
    applyPetViewport: () => {},
    clampToWorkArea: (_window, x, y) => ({ x, y }),
    getMovementState: () => null,
    maybeRunPackagedRuntimeSmoke: () => {},
    maybeRunPackagedCreatorStudioEvidence: () => {},
    maybeRunPackagedCreatorStudioUiE2e: () => {},
    maybeRunPackagedPluginCleanupEvidence: () => {},
    maybeRunPackagedCreatorStudioEvidence: () => {},
    maybeRunPackagedCreatorStudioUiE2e: () => {},
    maybeRunPackagedCreateUiSmoke: () => {},
    factories: {
      createAboutService: () => ({ id: 'about' }),
      createActionImportService: () => ({ id: 'action-import' }),
      createActionService: () => ({ id: 'action-service' }),
      createAiService: () => ({ id: 'ai-service' }),
      createHatchPetAgentService: () => ({ id: 'hatch-pet-agent' }),
      createAiTalkService: () => ({ id: 'ai-talk-service' }),
      createAiTalkStore: () => ({ id: 'ai-talk-store' }),
      createAppLogService: () => ({ record: () => {}, logPath: '/tmp/app-log.jsonl' }),
      createBasicBehaviorPlugin: () => ({ id: 'basic' }),
      createBehaviorOrchestratorService: () => ({ id: 'behavior' }),
      createCatalogService: () => ({
        getPluginBlockStatus: () => ({ blocked: false, reasons: [] }),
        getPetPackBlockStatus: () => ({ blocked: false, reasons: [] })
      }),
      createCursorAssetService: () => ({ repairCursor: async () => ({}) }),
      createCreatorStudioDefaultFlowService: () => ({
        id: 'creator-studio-default-flow',
        start: () => {},
        stop: () => {},
        refresh: () => {}
      }),
      createCreatorReferenceService: () => ({
        getReference: () => null,
        bindReference: async () => ({ replaced: false, reference: null }),
        copyReferenceIntoRun: () => ({})
      }),
      createCreatorStudioDefaultFlowService: () => ({
        id: 'creator-studio-default-flow',
        start: () => {},
        stop: () => {},
        refresh: () => {}
      }),
      createCreatorWorkflowService: () => ({ id: 'creator-workflow' }),
      createEventBus: () => ({ on: () => {}, emit: () => {} }),
      createImageGenerationModelService: () => ({ id: 'image-service' }),
      createTriggerRuleRuntimeService: () => ({
        id: 'trigger-rule-runtime',
        start: () => {},
        stop: () => {},
        refresh: () => {},
        getDiagnostics: () => ({ currentState: { actionId: '' }, decisions: [] })
      }),
      createLocalHttpService: () => ({ start: async () => ({}) }),
      createPetBubbleChatWindowManager: () => ({ id: 'bubble-window' }),
      createPetChatWindowManager: () => ({ id: 'chat-window' }),
      createPetMovementPolicy: () => ({
        normalizeWindowForDisplay: () => ({ x: 0, y: 0 }),
        normalizePetBehaviorSettings: (behavior) => behavior || { home: { enabled: false, anchor: null } },
        resolveDisplayForWindow: () => ({ id: 'display-1' }),
        normalizeAnchorForDisplay: ({ anchor }) => anchor
      }),
      createPetPackService: () => ({ id: 'pet-pack-service' }),
      createPetService: () => ({
        getSettings: () => ({
          scale: 1,
          autoStart: false,
          localHttp: {},
          petBehavior: { home: { enabled: false, anchor: null } },
          plugins: { enabled: {}, config: {}, storage: {}, logs: [] },
          ai: { behavior: {} },
          petPacks: { activePackId: 'starter', installed: {} },
          ecosystem: { blocklist: { pluginIds: [], packIds: [], sha256: [] } }
        }),
        saveSettings: () => {},
        reloadAnimations: () => ({ actions: [] })
      }),
      createPetUtteranceLogService: () => ({ id: 'utterance-log' }),
      createPluginGithubImportService: () => ({ id: 'github-import' }),
      createPluginInstallService: () => ({ id: 'install' }),
      createPluginService: () => ({
        stopAllServices: () => new Promise((resolve) => { resolveShutdown = resolve })
      }),
      createSecretService: () => ({ id: 'secret' }),
      createSettingsService: ({ loadSettings }) => ({ get: loadSettings, save: () => {}, preview: () => ({}) }),
      createSidecarRuntimeCoordinator: () => ({ start: async () => null, stop: async () => {}, getBackend: () => null, getState: () => ({ status: 'stopped', backend: null, reason: null }) }),
      syncBundledPlugins: () => ({ synced: [] })
    }
  })

  const beforeQuit = appHandlers.get('before-quit')
  let preventDefaultCalls = 0

  beforeQuit({
    preventDefault: () => { preventDefaultCalls += 1 }
  })

  await Promise.resolve()
  assert.equal(preventDefaultCalls, 1)
  assert.equal(quitCalls, 0)

  resolveShutdown()
  await setImmediatePromise()

  assert.equal(quitCalls, 1)
})
