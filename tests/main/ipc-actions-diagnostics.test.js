const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

const ipcPath = require.resolve('../../src/main/ipc')
const { IPC } = require('../../src/shared/ipc-channels')

const loadIpcWithElectron = (electronStub) => {
  delete require.cache[ipcPath]
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(ipcPath)
  } finally {
    Module._load = originalLoad
  }
}

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

const createRequiredServices = (overrides = {}) => ({
  getPetWindow: () => null,
  petService: {
    onSay: () => {},
    onAction: () => {},
    onEvent: () => {},
    getAnimations: () => ({ actions: [] }),
    getPreviewAnimations: () => ({
      defaultAction: 'idle',
      clickAction: 'wave',
      actions: [
        { id: 'idle', label: 'Idle', kind: 'idle' },
        { id: 'wave', label: 'Wave', kind: 'custom' }
      ],
      triggerRules: [],
      triggerProposalInbox: []
    }),
    reloadAnimations: () => ({
      defaultAction: 'idle',
      clickAction: 'wave',
      actions: [
        { id: 'idle', label: 'Idle', kind: 'idle' },
        { id: 'wave', label: 'Wave', kind: 'custom' }
      ],
      triggerRules: [],
      triggerProposalInbox: []
    }),
    getSettings: () => ({ localHttp: {}, menuPosition: 'auto' }),
    saveSettings: (settings) => settings,
    previewSettings: () => {},
    say: (payload) => payload,
    playAction: (payload) => payload,
    setEvent: (payload) => payload
  },
  petPackService: {
    listPacks: () => ({ activePackId: 'legacy-cat', packs: [] }),
    inspectPackSource: () => ({}),
    clearPendingSelection: () => ({ ok: true }),
    importPack: () => ({ ok: true }),
    exportPack: () => ({ ok: true }),
    setActivePack: () => ({ ok: true }),
    removePack: () => ({ ok: true })
  },
  aiService: {
    getConfig: () => ({}),
    saveConfig: (config) => config,
    saveApiKey: () => ({ ok: true }),
    testConnection: () => ({ ok: true }),
    getConversation: () => [],
    chat: () => ({ reply: 'ok' })
  },
  behaviorOrchestratorService: {
    getConfig: () => ({ enabled: false }),
    saveConfig: (config) => config,
    dryRun: () => ({ matched: false }),
    replayDecision: () => ({ matched: false }),
    exportDiagnostics: () => ({}),
    clearDecisions: () => ({ ok: true })
  },
  pluginService: {
    listPlugins: () => [],
    getLogs: () => [],
    exportLogs: () => ({ ok: true }),
    clearLogs: () => ({ ok: true }),
    setEnabled: () => ({ ok: true }),
    saveConfig: () => ({ ok: true }),
    runCommand: () => ({ ok: true }),
    runSetup: () => ({ ok: true }),
    openDashboard: () => ({ ok: true }),
    startService: () => ({ ok: true }),
    stopService: () => ({ ok: true }),
    checkServiceHealth: () => ({ ok: true }),
    saveServiceHealthPolicy: () => ({ ok: true }),
    clearStorage: () => ({ ok: true })
  },
  pluginInstallService: {
    inspectPluginPackage: () => ({}),
    clearPendingSelection: () => ({ ok: true }),
    installPlugin: () => ({ ok: true }),
    updatePlugin: () => ({ ok: true }),
    uninstallPlugin: () => ({ ok: true })
  },
  pluginGithubImportService: {
    inspectRepositoryUrl: () => ({ ok: true })
  },
  catalogService: {
    listCatalog: () => [],
    prepareInstall: () => ({ ok: true }),
    installSelection: () => ({ ok: true }),
    clearSelection: () => ({ ok: true }),
    addBlocklistEntry: () => [],
    removeBlocklistEntry: () => []
  },
  localHttpService: {
    getStatus: () => ({ enabled: false, host: '127.0.0.1', port: 0, mcp: { activeSessions: 0, sessionTtlMs: 0 } }),
    getLogs: () => [],
    exportLogs: () => ({ ok: true }),
    clearLogs: () => ({ ok: true }),
    start: async () => ({}),
    stop: async () => ({}),
    revokeMcpSessions: () => ({ activeSessions: 0, sessionTtlMs: 0 })
  },
  actionImportService: {
    inspectActionFrames: () => ({ inspection: { valid: true } }),
    importActionFrames: () => ({ ok: true }),
    updateActionConfig: (payload) => payload,
    deleteAction: () => ({ ok: true })
  },
  actionService: {
    applyCreatorActionMutation: (payload) => ({
      defaultAction: payload?.defaultAction || 'idle',
      clickAction: payload?.clickAction || 'wave',
      actions: [
        { id: 'idle', label: 'Idle', kind: 'idle' },
        { id: 'wave', label: 'Wave', kind: 'custom' }
      ],
      triggerRules: [],
      triggerProposalInbox: []
    })
  },
  applyWindowScale: () => {},
  clampToWorkArea: (_win, x, y) => ({ x, y }),
  getMovementState: () => null,
  createSettingsWindow: () => {},
  dialogService: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  ...overrides
})

test('retired Actions IPC handlers are not registered', async () => {
  const ipcMain = createIpcMainStub()
  const { registerIpcHandlers } = loadIpcWithElectron({
    ipcMain,
    BrowserWindow: { fromWebContents: () => null },
    app: { quit: () => {} },
    dialog: {},
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 900, height: 700 } })
    }
  })

  registerIpcHandlers({
    ...createRequiredServices(),
    ipcMainService: ipcMain,
  })
  for (const name of [
    'ACTIONS_GET', 'ACTIONS_SAVE_CONFIG', 'ACTIONS_INSPECT_FRAMES', 'ACTIONS_IMPORT_FRAMES',
    'ACTIONS_CLEAR_FRAME_SELECTION', 'ACTIONS_DELETE', 'ACTIONS_PREVIEW_TRIGGER_PROPOSAL',
    'ACTIONS_SUBMIT_TRIGGER_PROPOSAL', 'ACTIONS_ACCEPT_TRIGGER_PROPOSAL',
    'ACTIONS_REJECT_TRIGGER_PROPOSAL', 'ACTIONS_UPDATE_TRIGGER_RULE', 'ACTIONS_DELETE_TRIGGER_RULE'
  ]) assert.equal(ipcMain.handlers.has(IPC[name]), false, name + ' handler must be retired')
})

test('Shell Pet Pack activate bridge returns runtime diagnostics and emits one successful activation event', async () => {
  const ipcMain = createIpcMainStub()
  const notifications = []
  const { registerIpcHandlers } = loadIpcWithElectron({
    ipcMain,
    BrowserWindow: { fromWebContents: () => null },
    app: { quit: () => {} },
    dialog: {},
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 900, height: 700 } })
    }
  })

  const runtime = registerIpcHandlers({
    ...createRequiredServices({
      petPackService: {
        listPacks: () => ({
          activePackId: 'citrus-cat',
          packs: [{
            id: 'citrus-cat',
            displayName: 'Citrus Cat',
            version: '1.2.0',
            source: 'local',
            rootPath: '/demo/pet-packs/citrus-cat',
            active: true,
            actionCount: 4,
            defaultAction: 'idle',
            clickAction: 'wave'
          }]
        }),
        setActivePack: (packId) => {
          if (packId === 'missing-cat') throw new Error('Pet pack is not installed: missing-cat')
          if (packId === 'blocked-cat') throw new Error('Pet pack is blocked: package hash denied')
          return {
            ok: true,
            pack: {
              id: 'citrus-cat',
              displayName: 'Citrus Cat'
            }
          }
        },
        inspectPackSource: () => ({}),
        clearPendingSelection: () => ({ ok: true }),
        importPack: () => ({ ok: true }),
        exportPack: () => ({ ok: true }),
        removePack: () => ({ ok: true })
      }
    }),
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'citrus-cat', petPackDisplayName: 'Citrus Cat' }),
      getConversation: () => []
    },
    ipcMainService: ipcMain,
    sidecarRuntimeCoordinator: {
      notifyBackend: (body) => {
        notifications.push(body)
        return true
      }
    },
    triggerRuleRuntimeService: {
      refresh: () => ({
        currentState: { actionId: 'idle' },
        decisions: []
      }),
      getDiagnostics: () => ({
        currentState: { actionId: 'idle' },
        decisions: [
          {
            ruleId: 'rule:event:wave:1',
            triggerType: 'event',
            outcome: 'matched',
            reason: 'rule matched',
            actionId: 'wave',
            binding: 'plugin:event',
            source: 'plugin:test'
          }
        ]
      })
    }
  })

  const result = await runtime.handlePetPackRequest({ operation: 'activate', payload: { packId: 'citrus-cat' } })
  await assert.rejects(
    runtime.handlePetPackRequest({ operation: 'activate', payload: { packId: 'missing-cat' } }),
    (error) => error?.code === 'NOT_FOUND'
  )
  await assert.rejects(
    runtime.handlePetPackRequest({ operation: 'activate', payload: { packId: 'blocked-cat' } }),
    (error) => error?.code === 'PET_PACK_INCOMPATIBLE'
  )

  assert.deepEqual(result.animations.triggerRuntimeDiagnostics, {
    currentState: { actionId: 'idle' },
    decisions: [
      {
        ruleId: 'rule:event:wave:1',
        triggerType: 'event',
        outcome: 'matched',
        reason: 'rule matched',
        actionId: 'wave',
        binding: 'plugin:event',
        source: 'plugin:test'
      }
    ]
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].type, 'pet.pack-activated')
  assert.equal(notifications[0].payload.activePackId, 'citrus-cat')
  assert.equal(notifications[0].payload.petChatState.petPack.id, 'citrus-cat')
})
