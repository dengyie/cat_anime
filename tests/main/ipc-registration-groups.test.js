const test = require('node:test')
const assert = require('node:assert/strict')

const { IPC } = require('../../src/shared/ipc-channels')
const { registerAiIpc } = require('../../src/main/ipc/register-ai-ipc')
const { registerCreatorIpc } = require('../../src/main/ipc/register-creator-ipc')
const { registerPetRuntimeIpc } = require('../../src/main/ipc/register-pet-runtime-ipc')
const { registerPluginIpc } = require('../../src/main/ipc/register-plugin-ipc')
const { registerServiceIpc } = require('../../src/main/ipc/register-service-ipc')
const { registerSettingsIpc } = require('../../src/main/ipc/register-settings-ipc')
const { registerSystemIpc } = require('../../src/main/ipc/register-system-ipc')

const createIpcMainStub = () => {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    on(channel, handler) {
      listeners.set(channel, handler)
    }
  }
}

test('registerSystemIpc wires quit and settings-open channels', () => {
  const ipcMain = createIpcMainStub()
  const quitSources = []
  const openedWith = []
  const petWindow = { id: 'pet-window' }

  registerSystemIpc({
    ipcMainService: ipcMain,
    getPetWindow: () => petWindow,
    createSettingsWindow: (window) => openedWith.push(window),
    requestAppQuit: (source) => quitSources.push(source)
  })

  ipcMain.listeners.get(IPC.PET_QUIT)()
  ipcMain.listeners.get(IPC.SETTINGS_OPEN)()

  assert.deepEqual(quitSources, ['pet-renderer'])
  assert.deepEqual(openedWith, [petWindow])
})

test('registerSettingsIpc wires settings preview and close flows', () => {
  const ipcMain = createIpcMainStub()
  const previewCalls = []
  const sentMessages = []
  const settingsWindow = {
    closeCalled: 0,
    close() {
      this.closeCalled += 1
    }
  }
  const petWindow = {
    settingsWindow
  }

  registerSettingsIpc({
    ipcMainService: ipcMain,
    petService: {
      previewSettings: (payload) => previewCalls.push(payload),
      getSettings: () => ({ customCursors: [], localHttp: {}, petBehavior: {} }),
      saveSettings: (settings) => settings
    },
    getPetWindow: () => petWindow,
    browserWindowService: {
      fromWebContents: () => settingsWindow
    },
    sendToPetWindow: (_getWindow, channel, payload) => sentMessages.push({ channel, payload }),
    createPetRendererSettings: (settings) => settings,
    collectCustomCursorAssetPaths: () => [],
    mergePetSettingsViewIntoHostSettings: (current, patch) => ({ ...current, ...patch }),
    recordAppLog: () => {}
  })

  ipcMain.listeners.get(IPC.SETTINGS_PREVIEW_SCALE)(null, 1.25)
  ipcMain.listeners.get(IPC.SETTINGS_CLOSE)({ sender: { id: 'settings-web-contents' } })

  assert.deepEqual(previewCalls, [{ scale: 1.25 }])
  assert.deepEqual(sentMessages, [{ channel: IPC.SETTINGS_CHANGED, payload: { scale: 1.25 } }])
  assert.equal(settingsWindow.closeCalled, 1)
  assert.equal(petWindow.settingsWindow, null)
})

test('registerPetRuntimeIpc wires pet movement and focus handlers', () => {
  const ipcMain = createIpcMainStub()
  const syncCalls = []
  const appFocusCalls = []
  const win = {
    position: [10, 20],
    getPosition() {
      return this.position
    },
    getBounds() {
      return { x: this.position[0], y: this.position[1], width: 120, height: 80 }
    },
    setPosition(x, y) {
      this.position = [x, y]
    },
    focusCalled: 0,
    focus() {
      this.focusCalled += 1
    },
    moveTopCalled: 0,
    moveTop() {
      this.moveTopCalled += 1
    },
    isFocused: () => false,
    isMinimized: () => false,
    isDestroyed: () => false,
    webContents: {}
  }

  registerPetRuntimeIpc({
    ipcMainService: ipcMain,
    petService: {
      getAnimations: () => ({ actions: [] }),
      getSettings: () => ({ petBehavior: {}, menuPosition: 'auto' })
    },
    getPetWindow: () => win,
    browserWindowService: {
      fromWebContents: () => win
    },
    appService: {
      focus: (payload) => appFocusCalls.push(payload)
    },
    applyPetViewport: () => {},
    clampToWorkArea: (_target, x, y) => ({ x, y }),
    getMovementState: () => ({ mode: 'idle' }),
    petMovementPolicy: null,
    petBubbleChatWindowService: {
      syncToPetWindow: () => syncCalls.push('sync')
    },
    screenService: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } })
    },
    createSettingsWindow: () => {},
    buildPetContextMenuItems: () => [{ id: 'settings', type: 'action', label: '设置' }],
    measurePetContextMenu: () => ({ width: 100, height: 100 }),
    constrainPetContextMenuSize: () => ({ width: 100, height: 100, contentHeight: 100, scrollable: false }),
    layoutPetContextMenu: ({ size }) => ({
      placement: 'below',
      point: { x: 0, y: 0 },
      size,
      reason: 'preferred-placement',
      petOverlapArea: 0,
      candidates: []
    }),
    showContextMenuWindow: () => {},
    sendToPetWindow: () => {},
    createPetRendererSettings: (settings) => settings,
    recordAppLog: () => {},
    requestAppQuit: () => {}
  })

  const moveResult = ipcMain.handlers.get(IPC.PET_MOVE_BY)({ sender: win.webContents }, { x: 5, y: 7 })
  ipcMain.listeners.get(IPC.PET_REQUEST_FOCUS_FOR_CURSOR)({ sender: win.webContents })

  assert.deepEqual(moveResult, { x: 15, y: 27 })
  assert.deepEqual(win.position, [15, 27])
  assert.deepEqual(syncCalls, ['sync'])
  assert.deepEqual(appFocusCalls, [{ steal: true }])
  assert.equal(win.moveTopCalled, 1)
  assert.equal(win.focusCalled, 1)
})

test('registerAiIpc retains only image and Creator operations after AI HTTP cutover', async () => {
  const ipcMain = createIpcMainStub()
  const dryRunCalls = []
  const hatchCalls = []
  const behaviorAdapterCalls = []

  registerAiIpc({
    ipcMainService: ipcMain,
    aiService: {
      getConfig: () => ({ enabled: true, model: 'gpt-5.5' }),
      saveConfig: (config) => ({ enabled: true, ...config }),
      saveApiKey: (apiKey) => ({ ok: true, apiKey }),
      testConnection: () => ({ ok: true })
    },
    hatchPetAgentService: {
      getConfig: () => ({ enabled: false }),
      saveConfig: (value) => { hatchCalls.push(['save', value]); return value },
      saveApiKey: (value) => { hatchCalls.push(['key', value]); return { hasApiKey: true } },
      clearApiKey: () => { hatchCalls.push(['clear']); return { hasApiKey: false } },
      checkCapability: () => ({ ok: true }),
      getRunStatus: (runId) => { hatchCalls.push(['status', runId]); return { ok: true, runId } }
    },
    aiTalkService: {
      getPersonaProfile: async () => ({ petPackId: 'legacy-cat' }),
      generatePersonaDraft: async (request) => ({ prompt: request.prompt || '' }),
      savePersonaOverride: async (override) => ({ override }),
      getMemoryProfile: async () => ({ items: [] }),
      deleteMemory: async (memoryId) => ({ deleted: memoryId }),
      clearPetPackMemories: async () => ({ items: [] }),
      getConversation: (conversationId) => [{ id: conversationId || 'main' }],
      exportTraceDiagnostics: ({ filters, behaviorDecisions }) => JSON.stringify({ filters, behaviorDecisions })
    },
    imageGenerationModelService: {
      getConfig: () => ({ provider: 'cloud' }),
      saveConfig: (config) => config,
      saveProviderApiKey: () => ({ ok: true }),
      clearProviderApiKey: () => ({ ok: true }),
      checkHealth: async () => ({ ok: true })
    },
    behaviorOrchestratorService: {
      getConfig: () => ({ enabled: true, decisions: [{ id: 'd1' }] }),
      saveConfig: (payload) => payload,
      dryRun: (payload) => {
        dryRunCalls.push(payload)
        return { matched: false }
      },
      replayDecision: (payload) => payload,
      exportDiagnostics: () => ({ ok: true }),
      clearDecisions: () => ({ ok: true })
    },
    petService: {
      getAnimations: () => ({ actions: [{ id: 'wave' }] })
    },
    runAiChatRequest: async (payload, options) => ({ payload, options }),
    createAiConfigView: (config) => ({ kind: 'ai-config', config }),
    createAiPersonaProfileView: (profile) => ({ kind: 'persona-profile', profile }),
    createAiPersonaDraftView: (draft) => ({ kind: 'persona-draft', draft }),
    createAiMemoryProfileView: (profile) => ({ kind: 'memory-profile', profile }),
    createImageGenerationConfigView: (config) => ({ kind: 'image-config', config }),
    createImageGenerationApiKeyResult: (result) => ({ kind: 'image-key', result }),
    createImageGenerationHealthCheckResult: (result) => ({ kind: 'image-health', result }),
    createAiBehaviorConfigView: (config) => {
      behaviorAdapterCalls.push(['config', config])
      return { kind: 'behavior-config', config }
    },
    createAiBehaviorResultView: (result) => {
      behaviorAdapterCalls.push(['result', result])
      return { kind: 'behavior-result', result }
    },
    createAiBehaviorDecisionListView: (decisions) => {
      behaviorAdapterCalls.push(['decisions', decisions])
      return { kind: 'behavior-decisions', decisions }
    }
  })

  assert.equal(ipcMain.handlers.size, 8)
  for (const channel of ipcMain.handlers.keys()) assert.doesNotMatch(channel, /^ai[:\-]/)
  assert.deepEqual(await ipcMain.handlers.get(IPC.IMAGE_GENERATION_GET_CONFIG)(), { kind: 'image-config', config: { provider: 'cloud' } })
  assert.deepEqual(await ipcMain.handlers.get(IPC.IMAGE_GENERATION_CHECK_HEALTH)(null, {}), { kind: 'image-health', result: { ok: true } })
  assert.deepEqual(behaviorAdapterCalls, [])
  assert.deepEqual(dryRunCalls, [])
  assert.ok(ipcMain.handlers.has(IPC.IMAGE_GENERATION_CHECK_HEALTH))
  assert.equal(ipcMain.handlers.has('hatch-pet-agent:save-config'), false)
  assert.equal(ipcMain.handlers.has('hatch-pet-agent:save-api-key'), false)
  assert.deepEqual(await ipcMain.handlers.get(IPC.HATCH_PET_AGENT_CHECK_CAPABILITY)(), { ok: true })
  assert.deepEqual(await ipcMain.handlers.get(IPC.HATCH_PET_AGENT_GET_RUN_STATUS)(null, { runId: 'run-1' }), { ok: true, runId: 'run-1' })
  assert.deepEqual(hatchCalls, [['status', 'run-1']])
})

test('registerPluginIpc wires plugin lifecycle and package inspection handlers', async () => {
  const ipcMain = createIpcMainStub()

  registerPluginIpc({
    ipcMainService: ipcMain,
    dialogService: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/focus-timer.openpet-plugin.zip'] })
    },
    pluginService: {
      listPlugins: () => ({ items: [{ id: 'focus-timer' }] }),
      setEnabled: (pluginId, enabled) => ({ pluginId, enabled }),
      saveConfig: (pluginId, config) => ({ pluginId, config }),
      runCommand: (pluginId, commandId, payload) => ({ pluginId, commandId, payload }),
      runSetup: (pluginId, setupId) => ({ pluginId, setupId }),
      openDashboard: (pluginId, dashboardId) => ({ pluginId, dashboardId }),
      startService: (pluginId, serviceId) => ({ pluginId, serviceId, status: 'started' }),
      stopService: (pluginId, serviceId) => ({ pluginId, serviceId, status: 'stopped' }),
      checkServiceHealth: (pluginId, serviceId) => ({ pluginId, serviceId, ok: true }),
      saveServiceHealthPolicy: (pluginId, serviceId, policy) => ({ pluginId, serviceId, policy }),
      getLogs: (filters) => ({ filters }),
      exportLogs: (filters) => ({ filters, exported: true }),
      clearLogs: () => ({ ok: true }),
      clearStorage: (pluginId) => ({ pluginId, ok: true })
    },
    pluginInstallService: {
      inspectPluginPackage: (filePath) => ({ selectionId: 'sel-1', filePath }),
      clearPendingSelection: (selectionId) => ({ selectionId, ok: true }),
      installPlugin: (selectionId) => ({ kind: 'install', selectionId }),
      updatePlugin: (selectionId) => ({ kind: 'update', selectionId }),
      uninstallPlugin: (pluginId, options) => ({ kind: 'uninstall', pluginId, options })
    },
    pluginGithubImportService: {
      inspectRepositoryUrl: async (repositoryUrl) => ({ repositoryUrl, manifest: { id: 'focus-timer' } })
    },
    createPluginListView: (plugins) => ({ kind: 'plugin-list', plugins }),
    createPluginMutationResult: (result, plugins) => ({ kind: 'plugin-mutation', result, plugins })
  })

  const list = await ipcMain.handlers.get(IPC.PLUGINS_LIST)()
  const inspect = await ipcMain.handlers.get(IPC.PLUGINS_INSPECT_PACKAGE)()
  const install = await ipcMain.handlers.get(IPC.PLUGINS_INSTALL)(null, { selectionId: 'sel-1' })

  assert.deepEqual(list, { kind: 'plugin-list', plugins: { items: [{ id: 'focus-timer' }] } })
  assert.deepEqual(inspect, {
    canceled: false,
    selectionId: 'sel-1',
    filePath: '/tmp/focus-timer.openpet-plugin.zip'
  })
  assert.deepEqual(install, {
    kind: 'plugin-mutation',
    result: { kind: 'install', selectionId: 'sel-1' },
    plugins: { items: [{ id: 'focus-timer' }] }
  })
  assert.ok(ipcMain.handlers.has(IPC.PLUGINS_INSPECT_GITHUB_REPOSITORY))
  assert.ok(ipcMain.handlers.has(IPC.PLUGINS_SAVE_SERVICE_HEALTH_POLICY))
})

test('registerCreatorIpc wires creator workflow handlers', async () => {
  const ipcMain = createIpcMainStub()
  const calls = []
  const creatorWorkflowService = {
    getState: async () => ({ ok: true, provider: { ready: true } }),
    approveReferenceSourcePath: () => ({
      referenceToken: 'token-reference',
      fileName: 'reference.png'
    }),
    bindReference: async (payload) => {
      calls.push({ type: 'bind', payload })
      return { ok: true, replaced: false, reference: payload }
    },
    generateNewCharacter: async (payload) => {
      calls.push({ type: 'new', payload })
      return { ok: true, state: 'completed', code: 'pet_imported', message: 'ok', run: null }
    },
    generateExistingAction: async (payload) => {
      calls.push({ type: 'action', payload })
      return { ok: true, state: 'completed', code: 'action_imported', message: 'ok', run: null }
    },
    acceptCreatorIdentity: async (payload) => {
      calls.push({ type: 'accept-identity', payload })
      return { ok: true, state: 'review-required', code: 'identity_accepted_review_required', message: 'ok', run: null }
    },
    acceptCreatorActionCandidate: async (payload) => {
      calls.push({ type: 'accept-action-candidate', payload })
      return { ok: true, state: 'review-required', code: 'action_candidate_accepted_review_required', message: 'ok', run: null }
    },
    getLastRun: async () => ({ ok: true, run: null })
  }

  registerCreatorIpc({
    ipcMainService: ipcMain,
    showOpenDialogForEvent: async () => ({ canceled: false, filePaths: ['/tmp/reference.png'] }),
    creatorWorkflowService
  })

  assert.deepEqual(await ipcMain.handlers.get(IPC.CREATOR_GET_STATE)(), { ok: true, provider: { ready: true } })
  assert.deepEqual(await ipcMain.handlers.get(IPC.CREATOR_PICK_REFERENCE_IMAGE)({}, {}), {
    ok: true,
    canceled: false,
    referenceToken: 'token-reference',
    fileName: 'reference.png'
  })
  assert.deepEqual(
    await ipcMain.handlers.get(IPC.CREATOR_BIND_REFERENCE)(null, {
      targetType: 'editable-action-host',
      targetId: 'legacy-editable-host',
      referenceToken: 'token-reference'
    }),
    {
      ok: true,
      replaced: false,
      reference: {
        targetType: 'editable-action-host',
        targetId: 'legacy-editable-host',
        referenceToken: 'token-reference'
      }
    }
  )
  await ipcMain.handlers.get(IPC.CREATOR_GENERATE_NEW_CHARACTER)(null, {
    characterName: 'Mango',
    stylePrompt: 'orange cat',
    referenceImageToken: 'token-reference'
  })
  await ipcMain.handlers.get(IPC.CREATOR_GENERATE_EXISTING_ACTION)(null, {
    actionName: 'spin',
    motionPrompt: 'spin quickly',
    referenceImageToken: 'token-reference'
  })
  await ipcMain.handlers.get(IPC.CREATOR_ACCEPT_IDENTITY)(null, {
    runId: 'run-1',
    candidateId: 'canonical-4',
    sha256: 'f'.repeat(64),
    qualityOverride: true,
    acknowledgedWarningCodes: ['visual-score-overall-below-minimum']
  })
  await ipcMain.handlers.get(IPC.CREATOR_ACCEPT_ACTION_CANDIDATE)(null, {
    runId: 'run-1',
    actionId: 'waving',
    candidateId: 'candidate-2',
    sha256: 'c'.repeat(64),
    qualityOverride: true,
    acknowledgedWarningCodes: ['visual-defect-motion-unreadable']
  })
  assert.deepEqual(await ipcMain.handlers.get(IPC.CREATOR_GET_LAST_RUN)(), { ok: true, run: null })
  assert.deepEqual(calls, [
    {
      type: 'bind',
      payload: {
        targetType: 'editable-action-host',
        targetId: 'legacy-editable-host',
        referenceToken: 'token-reference'
      }
    },
    {
      type: 'new',
      payload: {
        characterName: 'Mango',
        stylePrompt: 'orange cat',
        referenceImageToken: 'token-reference'
      }
    },
    {
      type: 'action',
      payload: {
        actionName: 'spin',
        motionPrompt: 'spin quickly',
        referenceImageToken: 'token-reference'
      }
    },
    {
      type: 'accept-identity',
      payload: {
        runId: 'run-1',
        candidateId: 'canonical-4',
        sha256: 'f'.repeat(64),
        qualityOverride: true,
        acknowledgedWarningCodes: ['visual-score-overall-below-minimum']
      }
    },
    {
      type: 'accept-action-candidate',
      payload: {
        runId: 'run-1',
        actionId: 'waving',
        candidateId: 'candidate-2',
        sha256: 'c'.repeat(64),
        qualityOverride: true,
        acknowledgedWarningCodes: ['visual-defect-motion-unreadable']
      }
    }
  ])
})

test('registerServiceIpc wires service status, token rotation, and config persistence handlers', async () => {
  const ipcMain = createIpcMainStub()
  const savedSettings = []
  const startedConfigs = []

  registerServiceIpc({
    ipcMainService: ipcMain,
    petService: {
      getSettings: () => ({ localHttp: { enabled: true, host: '127.0.0.1', port: 8317, token: 'old-token' } }),
      saveSettings: (settings) => {
        savedSettings.push(settings)
        return settings
      }
    },
    localHttpService: {
      getStatus: () => ({ enabled: true, host: '127.0.0.1', port: 8317, mcp: { activeSessions: 1, sessionTtlMs: 1000 } }),
      getLogs: () => [{ id: 'log-1' }],
      exportLogs: () => ({ ok: true }),
      clearLogs: () => ({ ok: true }),
      start: async (config) => {
        startedConfigs.push(config)
        return { enabled: true, host: config.host, port: config.port, mcp: { activeSessions: 0, sessionTtlMs: 1000 } }
      },
      stop: async () => ({ enabled: false, host: '127.0.0.1', port: 0, mcp: { activeSessions: 0, sessionTtlMs: 1000 } }),
      revokeMcpSessions: () => ({ activeSessions: 0, sessionTtlMs: 1000 })
    },
    normalizeLocalHttpConfig: (_current, next) => ({ host: '127.0.0.1', ...next }),
    createLocalHttpToken: () => 'rotated-token',
    createServiceStatusView: (config, runtime) => ({ config, runtime })
  })

  const rotated = await ipcMain.handlers.get(IPC.SERVICE_ROTATE_TOKEN)()
  const saved = await ipcMain.handlers.get(IPC.SERVICE_SAVE_CONFIG)(null, { enabled: true, port: 8456, token: 'custom-token' })

  assert.equal(startedConfigs[0].token, 'rotated-token')
  assert.equal(startedConfigs[1].port, 8456)
  assert.equal(savedSettings.length, 2)
  assert.deepEqual(rotated.runtime, { enabled: true, host: '127.0.0.1', port: 8317, mcp: { activeSessions: 1, sessionTtlMs: 1000 } })
  assert.deepEqual(saved.config, { host: '127.0.0.1', enabled: true, port: 8456, token: 'custom-token' })
  assert.ok(ipcMain.handlers.has(IPC.SERVICE_REVOKE_MCP_SESSIONS))
})

test('registerServiceIpc controls only the sidecar-owned MCP server', async () => {
  const ipcMain = createIpcMainStub()
  const savedSettings = []
  const requests = []
  let settings = { localHttp: { enabled: true, host: '127.0.0.1', port: 8317, token: 'old-token', logs: [] } }
  const localHttpService = new Proxy({}, {
    get: (_target, property) => () => {
      throw new Error(`main-process local HTTP service must not handle ${String(property)}`)
    }
  })

  registerServiceIpc({
    ipcMainService: ipcMain,
    petService: {
      getSettings: () => settings,
      saveSettings: (next) => {
        settings = next
        savedSettings.push(next)
        return next
      }
    },
    localHttpService,
    sidecarRuntimeCoordinator: {
      getBackend: () => ({ baseUrl: 'http://127.0.0.1:3210/api/v1', sessionToken: 'session-token' })
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      const parsed = new URL(url)
      let data = { enabled: settings.localHttp.enabled, host: '127.0.0.1', port: settings.localHttp.port, mcp: { activeSessions: 0, sessionTtlMs: 1000 } }
      if (parsed.pathname.endsWith('/logs') && parsed.searchParams.get('operation') === 'export') data = '[]\n'
      else if (parsed.pathname.endsWith('/logs') && options.method === 'GET') data = { entries: [], page: 1, pageSize: 50, total: 0, totalPages: 1 }
      else if (parsed.pathname.endsWith('/logs') && options.method === 'DELETE') data = []
      else if (parsed.pathname.endsWith('/token/rotate')) data = { token: 'rotated-token', rotated: true, tokenConfigured: true }
      else if (parsed.pathname.endsWith('/token/revoke-sessions')) data = { activeSessions: 0, sessionTtlMs: 1000 }
      else if (parsed.pathname.endsWith('/config')) data = { enabled: JSON.parse(options.body).enabled, host: '127.0.0.1', port: JSON.parse(options.body).port, tokenConfigured: true, mcpProtocolVersion: '2025-03-26' }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data }) }
    },
    normalizeLocalHttpConfig: (_current, next) => ({ host: '127.0.0.1', ...next }),
    createLocalHttpToken: () => 'rotated-token',
    createServiceStatusView: (config, runtime) => ({ config, runtime })
  })

  await ipcMain.handlers.get(IPC.SERVICE_GET_STATUS)()
  await ipcMain.handlers.get(IPC.SERVICE_GET_LOGS)(null, { page: 1 })
  await ipcMain.handlers.get(IPC.SERVICE_EXPORT_LOGS)(null, { format: 'json' })
  await ipcMain.handlers.get(IPC.SERVICE_CLEAR_LOGS)()
  await ipcMain.handlers.get(IPC.SERVICE_REVOKE_MCP_SESSIONS)()
  await ipcMain.handlers.get(IPC.SERVICE_ROTATE_TOKEN)()
  const saved = await ipcMain.handlers.get(IPC.SERVICE_SAVE_CONFIG)(null, { ...settings.localHttp, port: 8456 })

  assert.deepEqual(requests.map((request) => new URL(request.url).pathname + (new URL(request.url).search ? new URL(request.url).search : '')), [
    '/api/v1/service/status',
    '/api/v1/service/logs?page=1',
    '/api/v1/service/logs?operation=export&format=json',
    '/api/v1/service/logs',
    '/api/v1/service/token/revoke-sessions',
    '/api/v1/service/status',
    '/api/v1/service/token/rotate',
    '/api/v1/service/status',
    '/api/v1/service/config',
    '/api/v1/service/status'
  ])
  assert.equal(JSON.parse(requests[8].options.body).enabled, true)
  assert.equal(JSON.parse(requests[8].options.body).port, 8456)
  assert.deepEqual(saved.runtime.mcp, { activeSessions: 0, sessionTtlMs: 1000 })
  assert.equal(savedSettings.length, 2)
})

test('registerServiceIpc fails closed when the configured sidecar is unavailable', async () => {
  const ipcMain = createIpcMainStub()
  const localCalls = []
  const savedSettings = []

  registerServiceIpc({
    ipcMainService: ipcMain,
    petService: {
      getSettings: () => ({ localHttp: { enabled: false, host: '127.0.0.1', port: 0, token: 'old-token' } }),
      saveSettings: (settings) => {
        savedSettings.push(settings)
        return settings
      }
    },
    localHttpService: {
      start: async (config) => {
        localCalls.push(['start', config])
        return { enabled: true, host: config.host, port: config.port }
      },
      stop: async () => {
        localCalls.push(['stop'])
        return { enabled: false, host: '127.0.0.1', port: 0 }
      },
      getStatus: () => {
        localCalls.push(['getStatus'])
        return { enabled: false, host: '127.0.0.1', port: 0 }
      }
    },
    sidecarRuntimeCoordinator: { getBackend: () => null },
    normalizeLocalHttpConfig: (_current, next) => ({ host: '127.0.0.1', ...next }),
    createLocalHttpToken: () => 'unused-token',
    createServiceStatusView: (config, runtime) => ({ config, runtime })
  })

  await assert.rejects(
    () => ipcMain.handlers.get(IPC.SERVICE_SAVE_CONFIG)(null, {
      enabled: true,
      port: 8456,
      token: 'custom-token'
    }),
    /sidecar unavailable/
  )

  assert.deepEqual(localCalls, [])
  assert.deepEqual(savedSettings, [])
})

test('registerServiceIpc does not persist localHttp config when start fails', async () => {
  const ipcMain = createIpcMainStub()
  const savedSettings = []
  const startedConfigs = []

  registerServiceIpc({
    ipcMainService: ipcMain,
    petService: {
      getSettings: () => ({ localHttp: { enabled: false, host: '127.0.0.1', port: 0, token: 'old-token' } }),
      saveSettings: (settings) => {
        savedSettings.push(settings)
        return settings
      }
    },
    localHttpService: {
      getStatus: () => ({ enabled: false, host: '127.0.0.1', port: 0, mcp: { activeSessions: 0, sessionTtlMs: 1000 } }),
      start: async (config) => {
        startedConfigs.push(config)
        throw new Error('Local HTTP service port must be between 0 and 65535')
      },
      stop: async () => {
        throw new Error('stop should not run when enabling fails')
      },
      revokeMcpSessions: () => ({ activeSessions: 0, sessionTtlMs: 1000 })
    },
    normalizeLocalHttpConfig: (_current, next) => ({ host: '127.0.0.1', ...next }),
    createLocalHttpToken: () => 'unused-token',
    createServiceStatusView: (config, runtime) => ({ config, runtime })
  })

  await assert.rejects(
    () => ipcMain.handlers.get(IPC.SERVICE_SAVE_CONFIG)(null, {
      enabled: true,
      port: 70000,
      token: 'bad-port-token'
    }),
    /port must be between 0 and 65535/
  )

  assert.equal(startedConfigs.length, 1)
  assert.equal(startedConfigs[0].port, 70000)
  assert.deepEqual(savedSettings, [], 'failed start must not write enabled:true to settings')
})

test('registerServiceIpc does not persist rotated token when start fails', async () => {
  const ipcMain = createIpcMainStub()
  const savedSettings = []
  const startedConfigs = []

  registerServiceIpc({
    ipcMainService: ipcMain,
    petService: {
      getSettings: () => ({ localHttp: { enabled: true, host: '127.0.0.1', port: 8317, token: 'old-token' } }),
      saveSettings: (settings) => {
        savedSettings.push(settings)
        return settings
      }
    },
    localHttpService: {
      getStatus: () => ({ enabled: true, host: '127.0.0.1', port: 8317, mcp: { activeSessions: 1, sessionTtlMs: 1000 } }),
      start: async (config) => {
        startedConfigs.push(config)
        throw new Error('Local HTTP service failed to bind after token rotation')
      },
      stop: async () => {
        throw new Error('stop should not run during rotation')
      },
      revokeMcpSessions: () => ({ activeSessions: 0, sessionTtlMs: 1000 })
    },
    normalizeLocalHttpConfig: (_current, next) => ({ host: '127.0.0.1', ...next }),
    createLocalHttpToken: () => 'rotated-token',
    createServiceStatusView: (config, runtime) => ({ config, runtime })
  })

  await assert.rejects(
    () => ipcMain.handlers.get(IPC.SERVICE_ROTATE_TOKEN)(),
    /failed to bind/
  )

  assert.equal(startedConfigs.length, 1)
  assert.equal(startedConfigs[0].token, 'rotated-token')
  assert.deepEqual(savedSettings, [], 'failed rotation must not persist the new token')
})
