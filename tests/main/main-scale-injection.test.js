const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const mainPath = require.resolve('../../main')
const flushAsync = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}
const flushImmediate = async () => new Promise((resolve) => setImmediate(resolve))

test('main forwards IPC-provided scale values to the window scaler', async () => {
  delete require.cache[mainPath]

  const scaleCalls = []
  const animationReloadCalls = []
  const appHandlers = new Map()
  const appLogs = []
  let stopAllServicesCalls = 0
  let resolveShutdown = null
  let quitCalls = 0
  let registeredIpcDependencies = null
  let registeredPluginDependencies = null
  let createdCreatorStudioDefaultFlowDependencies = null
  let createdTriggerRuleRuntimeDependencies = null
  let triggerRuleRuntimeRefreshCalls = 0
  let activePetPackBroadcastCalls = 0
  let createdAiTalkStorePath = null
  let createdAiTalkDependencies = null
  let bundledPluginSyncDependencies = null
  const petWindow = {
    webContents: { on: () => {}, send: () => {} },
    isMinimized: () => false,
    restore: () => {},
    focus: () => {}
  }

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: () => path.join(__dirname, '..', '.tmp-main-scale-injection'),
          isPackaged: false,
          on: (eventName, handler) => { appHandlers.set(eventName, handler) },
          quit: () => { quitCalls += 1 },
          requestSingleInstanceLock: () => true,
          setLoginItemSettings: () => {},
          whenReady: () => ({ then: (callback) => { callback(); return { catch: () => {} } } })
        },
        BrowserWindow: {
          getAllWindows: () => [petWindow]
        },
        dialog: {},
        shell: { openExternal: () => {} }
      }
    }

    if (request === './src/main/window') {
      return {
        applyWindowScale: (targetWindow, scale) => scaleCalls.push({ targetWindow, scale }),
        createSettingsWindow: () => {},
        createWindow: () => petWindow,
        loadPetWindow: () => {}
      }
    }

    if (request === './src/main/ipc') {
      return {
        createPetRendererSettings: (settings) => settings,
        normalizeLocalHttpConfig: (_currentConfig, nextConfig) => nextConfig,
        reloadAndSendAnimations: (getPetWindow, petService) => {
          animationReloadCalls.push({ petWindow: getPetWindow(), petService })
          return { actions: [] }
        },
        registerIpcHandlers: (dependencies) => {
          registeredIpcDependencies = dependencies
          return {
            broadcastActivePetPackChanged: () => { activePetPackBroadcastCalls += 1 }
          }
        }
      }
    }

    if (request === './src/main/settings') {
      return {
        loadSettings: () => ({
          scale: 1,
          autoStart: false,
          localHttp: {},
          ai: { behavior: {} },
          plugins: { enabled: {}, config: {}, storage: {}, logs: [] },
          petPacks: { activePackId: 'legacy-cat', installed: {} },
          ecosystem: { blocklist: { pluginIds: [], packIds: [], sha256: [] } }
        }),
        saveSettings: () => {},
        syncLoginItemSettings: () => {}
      }
    }

    if (request === './src/main/screen') {
      return {
        clampToWorkArea: (_win, x, y) => ({ x, y }),
        getMovementState: () => null
      }
    }

    if (request === './src/main/services/event-bus') {
      return { createEventBus: () => ({ on: () => {}, emit: () => {} }) }
    }

    if (request === './src/main/services/settings-service') {
      return {
        createSettingsService: ({ loadSettings }) => {
          let settings = loadSettings()
          return {
            get: () => settings,
            preview: (partial) => ({ ...settings, ...partial }),
            save: (nextSettings) => { settings = nextSettings; return settings }
          }
        }
      }
    }

    if (request === './src/main/services/action-service') {
      return {
        createActionService: () => ({
          getConfig: () => ({ actions: [] }),
          getPreviewConfig: () => ({ actions: [] }),
          reloadConfig: () => ({ actions: [] })
        })
      }
    }

    if (request === './src/main/services/pet-service') {
      return {
        createPetService: ({ settingsService }) => ({
          getSettings: () => settingsService.get(),
          saveSettings: (settings) => settingsService.save(settings),
          previewSettings: (partial) => settingsService.preview(partial),
          getAnimations: () => ({ actions: [] }),
          getPreviewAnimations: () => ({ actions: [] }),
          reloadAnimations: () => ({ actions: [] }),
          onSay: () => {},
          onAction: () => {},
          onEvent: () => {},
          say: (payload) => payload,
          playAction: (payload) => payload,
          setEvent: (payload) => payload
        })
      }
    }

    const serviceFactories = {
      './src/main/services/pet-pack-service': { createPetPackService: () => ({ listPacks: () => [], getActivePetPack: () => ({ manifest: { id: 'legacy-cat', persona: null, actions: [] } }) }) },
      './src/main/services/secret-service': { createSecretService: () => ({ id: 'secret-service' }) },
      './src/main/services/ai-service': { createAiService: () => ({ id: 'ai-service' }) },
      './src/main/services/hatch-pet-agent-service': { createHatchPetAgentService: () => ({ id: 'hatch-pet-agent-service' }) },
      './src/main/services/ai-talk-store': {
        createAiTalkStore: ({ storePath }) => {
          createdAiTalkStorePath = storePath
          return { id: 'ai-talk-store' }
        }
      },
      './src/main/services/ai-talk-service': {
        createAiTalkService: (dependencies) => {
          createdAiTalkDependencies = dependencies
          return { id: 'ai-talk-service' }
        }
      },
      './src/main/services/trigger-rule-runtime-service': {
        createTriggerRuleRuntimeService: (dependencies) => {
          createdTriggerRuleRuntimeDependencies = dependencies
          return {
            start: () => {},
            stop: () => {},
            refresh: () => { triggerRuleRuntimeRefreshCalls += 1 },
            getDiagnostics: () => ({ decisions: [] })
          }
        }
      },
      './src/main/services/behavior-orchestrator-service': { createBehaviorOrchestratorService: () => ({ getConfig: () => ({ enabled: false }) }) },
      './src/main/services/creator-reference-service': {
        createCreatorReferenceService: () => ({
          getReference: () => null,
          bindReference: async () => ({ replaced: false, reference: null }),
          copyReferenceIntoRun: () => ({})
        })
      },
      './src/main/services/creator-studio-default-flow-service': {
        createCreatorStudioDefaultFlowService: (dependencies) => {
          createdCreatorStudioDefaultFlowDependencies = dependencies
          return { id: 'creator-studio-default-flow-service' }
        }
      },
      './src/main/services/creator-workflow-service': {
        createCreatorWorkflowService: () => ({ id: 'creator-workflow-service' })
      },
      './src/main/services/plugin-service': {
        createPluginService: (dependencies) => {
          registeredPluginDependencies = dependencies
          return {
            stopAllServices: () => {
              stopAllServicesCalls += 1
              return new Promise((resolve) => { resolveShutdown = resolve })
            }
          }
        }
      },
      './src/main/services/plugin-install-service': { createPluginInstallService: () => ({}) },
      './src/main/services/bundled-plugin-sync-service': {
        syncBundledPlugins: (dependencies) => {
          bundledPluginSyncDependencies = dependencies
          return { synced: [{ pluginId: 'openpet.creator-studio', removed: ['stale-copy'] }] }
        }
      },
      './src/main/services/plugin-github-import-service': { createPluginGithubImportService: () => ({}) },
      './src/main/services/local-http-service': { createLocalHttpService: () => ({ start: async () => ({}) }) },
      './src/main/services/action-import-service': { createActionImportService: () => ({}) },
      './src/main/services/cursor-asset-service': { createCursorAssetService: () => ({ repairCursor: async (cursor) => cursor || {} }) },
      './src/main/services/app-log-service': { createAppLogService: () => ({ record: (entry) => appLogs.push(entry), logPath: '/tmp/openpet-app.jsonl' }) },
      './src/main/services/catalog-service': { createCatalogService: () => ({ getPetPackBlockStatus: () => ({ blocked: false, reasons: [] }), getPluginBlockStatus: () => ({ blocked: false, reasons: [] }) }) },
      './src/main/plugins/official/basic-behavior': { createBasicBehaviorPlugin: () => ({}) },
      './apps/desktop/src/sidecar/runtime-coordinator': { createSidecarRuntimeCoordinator: () => ({ start: async () => null, stop: async () => {} }) },
      './src/main/packaged-runtime-smoke-runner': { maybeRunPackagedRuntimeSmoke: () => {} },
      './src/main/packaged-plugin-cleanup-evidence-runner': { maybeRunPackagedPluginCleanupEvidence: () => {} },
      './src/main/packaged-creator-studio-evidence-runner': { maybeRunPackagedCreatorStudioEvidence: () => {} },
      './src/main/packaged-creator-studio-ui-e2e-runner': { maybeRunPackagedCreatorStudioUiE2e: () => {} },
      './src/main/packaged-create-ui-smoke-runner': { maybeRunPackagedCreateUiSmoke: () => {} },
      './src/main/user-data-path': { configureUserDataPath: () => {} }
    }
    if (serviceFactories[request]) return serviceFactories[request]

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    require(mainPath)
    await flushAsync()
    assert.ok(registeredIpcDependencies)

    const ipcWindow = { id: 'ipc-window' }
    registeredIpcDependencies.applyWindowScale(ipcWindow, 0.5)
    registeredPluginDependencies.onPetPackActivated()
    let preventDefaultCalls = 0
    appHandlers.get('before-quit')({ preventDefault: () => { preventDefaultCalls += 1 } })
    appHandlers.get('will-quit')()

    await flushAsync()
    assert.equal(preventDefaultCalls, 1)
    assert.equal(stopAllServicesCalls, 1)
    assert.equal(quitCalls, 0)

    resolveShutdown()
    await flushImmediate()

    assert.deepEqual(scaleCalls, [{ targetWindow: ipcWindow, scale: 0.5 }])
    assert.equal(animationReloadCalls.length, 1)
    assert.equal(animationReloadCalls[0].petWindow, petWindow)
    assert.equal(triggerRuleRuntimeRefreshCalls, 1)
    assert.equal(activePetPackBroadcastCalls, 1)
    assert.equal(createdAiTalkStorePath, null)
    assert.equal(createdAiTalkDependencies, null)
    assert.ok(createdTriggerRuleRuntimeDependencies)
    assert.equal(createdTriggerRuleRuntimeDependencies.actionService.getConfig().actions.length, 0)
    assert.equal(typeof createdTriggerRuleRuntimeDependencies.petService.playAction, 'function')
    assert.equal(typeof registeredIpcDependencies.aiTalkService.streamChat, 'function')
    assert.equal(typeof registeredIpcDependencies.aiTalkService.hydrate, 'function')
    assert.equal(registeredIpcDependencies.creatorStudioDefaultFlowService.id, 'creator-studio-default-flow-service')
    assert.equal(createdCreatorStudioDefaultFlowDependencies.pluginService.stopAllServices != null, true)
    assert.equal(registeredPluginDependencies.secretService.id, 'secret-service')
    assert.equal(bundledPluginSyncDependencies.pluginDir, path.join(__dirname, '..', '.tmp-main-scale-injection', 'plugins'))
    assert.deepEqual(bundledPluginSyncDependencies.bundledPluginDirs, [
      path.resolve(__dirname, '../../examples/plugins/creator-studio'),
      path.resolve(__dirname, '../../examples/plugins/agent-awareness'),
      path.resolve(__dirname, '../../examples/plugins/im-gateway')
    ])
    assert.deepEqual(appLogs.map((entry) => entry.event), [
      'app.ready',
      'plugins.bundled.synced',
      'app.before-quit',
      'ai-talk.shutdown.started',
      'app.will-quit',
      'ai-talk.shutdown.completed'
    ])
    assert.equal(quitCalls, 1)
  } finally {
    Module._load = originalLoad
    delete require.cache[mainPath]
  }
})

test('main still stops plugin services when lifecycle logging fails during quit', async () => {
  delete require.cache[mainPath]

  const appHandlers = new Map()
  let stopAllServicesCalls = 0
  let resolveShutdown = null
  let quitCalls = 0
  const petWindow = {
    webContents: { on: () => {}, send: () => {} },
    isMinimized: () => false,
    restore: () => {},
    focus: () => {}
  }

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: () => path.join(__dirname, '..', '.tmp-main-scale-injection'),
          isPackaged: false,
          on: (eventName, handler) => { appHandlers.set(eventName, handler) },
          quit: () => { quitCalls += 1 },
          requestSingleInstanceLock: () => true,
          setLoginItemSettings: () => {},
          whenReady: () => ({ then: (callback) => { callback(); return { catch: () => {} } } })
        },
        BrowserWindow: {
          getAllWindows: () => [petWindow]
        },
        dialog: {},
        screen: { on: () => {} },
        shell: { openExternal: () => {} }
      }
    }

    if (request === './src/main/window') {
      return {
        applyWindowScale: () => {},
        createSettingsWindow: () => {},
        createWindow: () => petWindow,
        loadPetWindow: () => {}
      }
    }

    if (request === './src/main/ipc') {
      return {
        createPetRendererSettings: (settings) => settings,
        normalizeLocalHttpConfig: (_currentConfig, nextConfig) => nextConfig,
        reloadAndSendAnimations: () => ({ actions: [] }),
        registerIpcHandlers: () => {}
      }
    }

    if (request === './src/main/settings') {
      return {
        loadSettings: () => ({
          scale: 1,
          autoStart: false,
          localHttp: {},
          ai: { behavior: {} },
          plugins: { enabled: {}, config: {}, storage: {}, logs: [] },
          petPacks: { activePackId: 'legacy-cat', installed: {} },
          ecosystem: { blocklist: { pluginIds: [], packIds: [], sha256: [] } }
        }),
        saveSettings: () => {},
        syncLoginItemSettings: () => {}
      }
    }

    if (request === './src/main/screen') {
      return {
        clampToWorkArea: (_win, x, y) => ({ x, y }),
        getMovementState: () => null
      }
    }

    if (request === './src/main/services/event-bus') {
      return { createEventBus: () => ({ on: () => {}, emit: () => {} }) }
    }

    if (request === './src/main/services/settings-service') {
      return {
        createSettingsService: ({ loadSettings }) => {
          let settings = loadSettings()
          return {
            get: () => settings,
            preview: (partial) => ({ ...settings, ...partial }),
            save: (nextSettings) => { settings = nextSettings; return settings }
          }
        }
      }
    }

    if (request === './src/main/services/action-service') {
      return {
        createActionService: () => ({
          getConfig: () => ({ actions: [] }),
          getPreviewConfig: () => ({ actions: [] }),
          reloadConfig: () => ({ actions: [] })
        })
      }
    }

    if (request === './src/main/services/pet-service') {
      return {
        createPetService: ({ settingsService }) => ({
          getSettings: () => settingsService.get(),
          saveSettings: (settings) => settingsService.save(settings),
          previewSettings: (partial) => settingsService.preview(partial),
          getAnimations: () => ({ actions: [] }),
          getPreviewAnimations: () => ({ actions: [] }),
          reloadAnimations: () => ({ actions: [] }),
          onSay: () => {},
          onAction: () => {},
          onEvent: () => {},
          say: (payload) => payload,
          playAction: (payload) => payload,
          setEvent: (payload) => payload
        })
      }
    }

    const serviceFactories = {
      './src/main/services/pet-pack-service': { createPetPackService: () => ({ listPacks: () => [], getActivePetPack: () => ({ manifest: { id: 'legacy-cat', persona: null, actions: [] } }) }) },
      './src/main/services/secret-service': { createSecretService: () => ({}) },
      './src/main/services/ai-service': { createAiService: () => ({}) },
      './src/main/services/hatch-pet-agent-service': { createHatchPetAgentService: () => ({}) },
      './src/main/services/ai-talk-store': { createAiTalkStore: () => ({}) },
      './src/main/services/ai-talk-service': { createAiTalkService: () => ({}) },
      './src/main/services/behavior-orchestrator-service': { createBehaviorOrchestratorService: () => ({ getConfig: () => ({ enabled: false }) }) },
      './src/main/services/creator-reference-service': {
        createCreatorReferenceService: () => ({
          getReference: () => null,
          bindReference: async () => ({ replaced: false, reference: null }),
          copyReferenceIntoRun: () => ({})
        })
      },
      './src/main/services/creator-studio-default-flow-service': { createCreatorStudioDefaultFlowService: () => ({}) },
      './src/main/services/creator-workflow-service': { createCreatorWorkflowService: () => ({}) },
      './src/main/services/plugin-service': {
        createPluginService: () => ({
          stopAllServices: () => {
            stopAllServicesCalls += 1
            return new Promise((resolve) => { resolveShutdown = resolve })
          }
        })
      },
      './src/main/services/plugin-install-service': { createPluginInstallService: () => ({}) },
      './src/main/services/bundled-plugin-sync-service': {
        syncBundledPlugins: () => ({ synced: [{ pluginId: 'openpet.creator-studio', removed: [] }] })
      },
      './src/main/services/plugin-github-import-service': { createPluginGithubImportService: () => ({}) },
      './src/main/services/local-http-service': { createLocalHttpService: () => ({ start: async () => ({}) }) },
      './src/main/services/action-import-service': { createActionImportService: () => ({}) },
      './src/main/services/cursor-asset-service': { createCursorAssetService: () => ({ repairCursor: async (cursor) => cursor || {} }) },
      './src/main/services/app-log-service': { createAppLogService: () => ({ record: () => { throw new Error('disk full') }, logPath: '/tmp/openpet-app.jsonl' }) },
      './src/main/services/catalog-service': { createCatalogService: () => ({ getPetPackBlockStatus: () => ({ blocked: false, reasons: [] }), getPluginBlockStatus: () => ({ blocked: false, reasons: [] }) }) },
      './src/main/plugins/official/basic-behavior': { createBasicBehaviorPlugin: () => ({}) },
      './apps/desktop/src/sidecar/runtime-coordinator': { createSidecarRuntimeCoordinator: () => ({ start: async () => null, stop: async () => {} }) },
      './src/main/packaged-runtime-smoke-runner': { maybeRunPackagedRuntimeSmoke: () => {} },
      './src/main/packaged-plugin-cleanup-evidence-runner': { maybeRunPackagedPluginCleanupEvidence: () => {} },
      './src/main/packaged-creator-studio-evidence-runner': { maybeRunPackagedCreatorStudioEvidence: () => {} },
      './src/main/packaged-creator-studio-ui-e2e-runner': { maybeRunPackagedCreatorStudioUiE2e: () => {} },
      './src/main/packaged-create-ui-smoke-runner': { maybeRunPackagedCreateUiSmoke: () => {} },
      './src/main/user-data-path': { configureUserDataPath: () => {} }
    }
    if (serviceFactories[request]) return serviceFactories[request]

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    require(mainPath)
    await flushAsync()

    let preventDefaultCalls = 0
    appHandlers.get('before-quit')({ preventDefault: () => { preventDefaultCalls += 1 } })

    await flushAsync()
    assert.equal(preventDefaultCalls, 1)
    assert.equal(quitCalls, 0)

    resolveShutdown()
    await flushImmediate()

    assert.equal(stopAllServicesCalls, 1)
    assert.equal(quitCalls, 1)
  } finally {
    Module._load = originalLoad
    delete require.cache[mainPath]
  }
})

test('main persists repaired cursor metadata and collection entry when repair rewrites the asset path', async () => {
  delete require.cache[mainPath]

  const initialCursor = {
    enabled: true,
    assetPath: '/tmp/cursor.png',
    assetUrl: '',
    fileName: 'cursor.png',
    width: 0,
    height: 0,
    hotspotX: 0,
    hotspotY: 0
  }
  const savedSettings = []
  const appLogs = []
  const petWindow = {
    webContents: { on: () => {}, send: () => {} },
    isMinimized: () => false,
    restore: () => {},
    focus: () => {}
  }

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: () => path.join(__dirname, '..', '.tmp-main-scale-injection'),
          isPackaged: false,
          on: () => {},
          quit: () => {},
          requestSingleInstanceLock: () => true,
          setLoginItemSettings: () => {},
          whenReady: () => ({ then: (callback) => { callback(); return { catch: () => {} } } })
        },
        BrowserWindow: { getAllWindows: () => [petWindow] },
        dialog: {},
        screen: { on: () => {} },
        shell: { openExternal: () => {} }
      }
    }

    if (request === './src/main/window') {
      return {
        applyWindowScale: () => {},
        createSettingsWindow: () => {},
        createWindow: () => petWindow,
        loadPetWindow: () => {}
      }
    }

    if (request === './src/main/ipc') {
      return {
        createPetRendererSettings: (settings) => settings,
        normalizeLocalHttpConfig: (_currentConfig, nextConfig) => nextConfig,
        reloadAndSendAnimations: () => ({ actions: [] }),
        registerIpcHandlers: () => {}
      }
    }

    if (request === './src/main/settings') {
      return {
        loadSettings: () => ({
          scale: 1,
          autoStart: false,
          selectedCursorId: 'cursor-old',
          customCursor: initialCursor,
          customCursors: [{
            id: 'cursor-old',
            type: 'custom',
            name: 'Cursor',
            assetPath: initialCursor.assetPath,
            assetUrl: initialCursor.assetUrl,
            fileName: initialCursor.fileName,
            width: 0,
            height: 0,
            byteSize: 100,
            hotspotX: 0,
            hotspotY: 0,
            createdAt: '2026-06-20T00:00:00.000Z'
          }, {
            id: 'cursor-other',
            type: 'custom',
            name: 'Other Cursor',
            assetPath: '/tmp/other-cursor.png',
            assetUrl: '',
            fileName: 'other-cursor.png',
            width: 0,
            height: 0,
            byteSize: 100,
            hotspotX: 0,
            hotspotY: 0,
            createdAt: '2026-06-20T00:00:00.000Z'
          }],
          localHttp: {},
          ai: { behavior: {} },
          plugins: { enabled: {}, config: {}, storage: {}, logs: [] },
          petPacks: { activePackId: 'legacy-cat', installed: {} },
          ecosystem: { blocklist: { pluginIds: [], packIds: [], sha256: [] } }
        }),
        saveSettings: (settings) => savedSettings.push(settings),
        syncLoginItemSettings: () => {}
      }
    }

    if (request === './src/main/services/settings-service') {
      return {
        createSettingsService: ({ loadSettings, saveSettings }) => {
          let settings = loadSettings()
          return {
            get: () => settings,
            preview: (partial) => ({ ...settings, ...partial }),
            save: (nextSettings) => {
              settings = nextSettings
              saveSettings(nextSettings)
              return settings
            }
          }
        }
      }
    }

    if (request === './src/main/services/cursor-asset-service') {
      return {
        createCursorAssetService: () => ({
          repairCursor: async () => ({
            ...initialCursor,
            assetPath: '/tmp/cursor-repaired.png',
            assetUrl: 'file:///tmp/cursor-repaired.png',
            width: 64,
            height: 64,
            hotspotX: 13,
            hotspotY: 8
          })
        })
      }
    }

    const serviceFactories = {
      './src/main/screen': { clampToWorkArea: (_win, x, y) => ({ x, y }), getMovementState: () => null },
      './src/main/services/event-bus': { createEventBus: () => ({ on: () => {}, emit: () => {} }) },
      './src/main/services/action-service': { createActionService: () => ({ getConfig: () => ({ actions: [] }), getPreviewConfig: () => ({ actions: [] }), reloadConfig: () => ({ actions: [] }) }) },
      './src/main/services/pet-service': { createPetService: ({ settingsService }) => ({ getSettings: () => settingsService.get(), saveSettings: (settings) => settingsService.save(settings), previewSettings: (partial) => settingsService.preview(partial), getAnimations: () => ({ actions: [] }), getPreviewAnimations: () => ({ actions: [] }), reloadAnimations: () => ({ actions: [] }), onSay: () => {}, onAction: () => {}, onEvent: () => {}, say: (payload) => payload, playAction: (payload) => payload, setEvent: (payload) => payload }) },
      './src/main/services/pet-pack-service': { createPetPackService: () => ({ listPacks: () => [] }) },
      './src/main/services/secret-service': { createSecretService: () => ({}) },
      './src/main/services/ai-service': { createAiService: () => ({}) },
      './src/main/services/hatch-pet-agent-service': { createHatchPetAgentService: () => ({}) },
      './src/main/services/image-generation-model-service': { createImageGenerationModelService: () => ({}) },
      './src/main/services/behavior-orchestrator-service': { createBehaviorOrchestratorService: () => ({ getConfig: () => ({ enabled: false }) }) },
      './src/main/services/creator-reference-service': {
        createCreatorReferenceService: () => ({
          getReference: () => null,
          bindReference: async () => ({ replaced: false, reference: null }),
          copyReferenceIntoRun: () => ({})
        })
      },
      './src/main/services/creator-studio-default-flow-service': { createCreatorStudioDefaultFlowService: () => ({}) },
      './src/main/services/creator-workflow-service': { createCreatorWorkflowService: () => ({}) },
      './src/main/services/plugin-service': { createPluginService: () => ({ stopAllServices: () => {} }) },
      './src/main/services/plugin-install-service': { createPluginInstallService: () => ({}) },
      './src/main/services/plugin-github-import-service': { createPluginGithubImportService: () => ({}) },
      './src/main/services/local-http-service': { createLocalHttpService: () => ({ start: async () => ({}) }) },
      './src/main/services/action-import-service': { createActionImportService: () => ({}) },
      './src/main/services/app-log-service': { createAppLogService: () => ({ record: (entry) => appLogs.push(entry), logPath: '/tmp/openpet-app.jsonl' }) },
      './src/main/services/catalog-service': { createCatalogService: () => ({ getPetPackBlockStatus: () => ({ blocked: false, reasons: [] }), getPluginBlockStatus: () => ({ blocked: false, reasons: [] }) }) },
      './src/main/plugins/official/basic-behavior': { createBasicBehaviorPlugin: () => ({}) },
      './apps/desktop/src/sidecar/runtime-coordinator': { createSidecarRuntimeCoordinator: () => ({ start: async () => null, stop: async () => {} }) },
      './src/main/packaged-runtime-smoke-runner': { maybeRunPackagedRuntimeSmoke: () => {} },
      './src/main/packaged-plugin-cleanup-evidence-runner': { maybeRunPackagedPluginCleanupEvidence: () => {} },
      './src/main/packaged-creator-studio-evidence-runner': { maybeRunPackagedCreatorStudioEvidence: () => {} },
      './src/main/packaged-creator-studio-ui-e2e-runner': { maybeRunPackagedCreatorStudioUiE2e: () => {} },
      './src/main/packaged-create-ui-smoke-runner': { maybeRunPackagedCreateUiSmoke: () => {} },
      './src/main/user-data-path': { configureUserDataPath: () => {} }
    }
    if (serviceFactories[request]) return serviceFactories[request]

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    require(mainPath)
    await flushAsync()

    assert.ok(savedSettings.length >= 1)
    const repairedSettings = savedSettings.at(-1)
    assert.equal(repairedSettings.customCursor.assetPath, '/tmp/cursor-repaired.png')
    assert.equal(repairedSettings.customCursor.assetUrl, 'file:///tmp/cursor-repaired.png')
    assert.equal(repairedSettings.customCursor.width, 64)
    assert.equal(repairedSettings.customCursor.height, 64)
    assert.equal(repairedSettings.customCursor.hotspotX, 13)
    assert.equal(repairedSettings.customCursor.hotspotY, 8)
    assert.equal(repairedSettings.customCursors[0].assetPath, '/tmp/cursor-repaired.png')
    assert.equal(repairedSettings.customCursors[0].assetUrl, 'file:///tmp/cursor-repaired.png')
    assert.equal(repairedSettings.customCursors[0].width, 64)
    assert.equal(repairedSettings.customCursors[0].height, 64)
    assert.equal(repairedSettings.customCursors[0].hotspotX, 13)
    assert.equal(repairedSettings.customCursors[0].hotspotY, 8)
    assert.equal(repairedSettings.customCursors[1].assetPath, '/tmp/other-cursor.png')
    assert.equal(appLogs.some((entry) => entry.event === 'settings.cursor.asset.repaired'), true)
  } finally {
    Module._load = originalLoad
    delete require.cache[mainPath]
  }
})
