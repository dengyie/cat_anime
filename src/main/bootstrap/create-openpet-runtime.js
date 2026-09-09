const { createCoreServices } = require('./create-core-services')
const { createPluginServices } = require('./create-plugin-services')
const { createWindowServices } = require('./create-window-services')
const { registerDisplayLifecycle, registerPetWindowLifecycle, registerRuntimeAppLifecycle } = require('./runtime-lifecycle')
const { registerCursorRepair, runPostPluginStartupSideEffects } = require('./startup-side-effects')
const { IPC } = require('../../shared/ipc-channels')
const { createDefaultSidecarPidLedger } = require('../../../apps/desktop/src/sidecar/orphan-cleanup')
const { createSettingsSidecarBridge } = require('../settings-sidecar-bridge')
const { createSettingsHostEffect } = require('../settings-host-effects')
const { createCatalogSidecarBridge } = require('../catalog-sidecar-bridge')

const createSidecarLogger = ({ appLogService, safeRecordAppLog }) => Object.fromEntries(
  ['info', 'warn', 'error'].map((level) => [level, (message, details) => {
    safeRecordAppLog(appLogService, {
      scope: 'sidecar',
      level,
      actor: 'system',
      event: `sidecar.runtime.${level}`,
      message,
      details
    })
  }])
)

const createOpenPetRuntime = ({
  app,
  BrowserWindow,
  dialog,
  shell,
  screen,
  projectRoot,
  settingsRuntime,
  getPetWindow,
  createSettingsWindow,
  createWindow,
  loadPetWindow,
  registerAppLifecycleLogs,
  safeRecordAppLog,
  registerIpcHandlers,
  createPetRendererSettings,
  normalizeLocalHttpConfig,
  reloadAndSendAnimations,
  applyWindowScale,
  applyPetViewport,
  clampToWorkArea,
  getMovementState,
  maybeRunPackagedRuntimeSmoke,
  maybeRunPackagedPluginCleanupEvidence,
  maybeRunPackagedCreatorStudioEvidence,
  maybeRunPackagedCreatorStudioUiE2e,
  maybeRunPackagedCreateUiSmoke,
  factories,
  setPetWindow,
  fetchImpl
}) => {
  let handleSystemCursorUnexpectedExit = async () => {}
  const core = createCoreServices({
    app,
    projectRoot,
    settingsRuntime,
    factories,
    screen,
    getBackend: () => sidecarRuntimeCoordinator.getBackend(),
    fetchImpl,
    onAiSnapshot: () => ipcRuntimeHelpers.refreshAiState?.(),
    onSystemCursorUnexpectedExit: (event) => handleSystemCursorUnexpectedExit(event)
  })
  const {
    services: {
      actionImportService,
      actionService,
      aiService,
      aiTalkService,
      aiSidecar,
      appLogService,
      behaviorOrchestratorService,
      cursorAssetService,
      systemCursorService,
      creatorReferenceService,
      imageGenerationModelService,
      localHttpService,
      petMovementPolicy,
      petPackService,
      petService,
      petUtteranceLogService,
      secretService,
      triggerRuleRuntimeService,
      settingsService
    },
    syncLoginItemSettings,
    setCatalogService
  } = core
  const sidecarLogger = createSidecarLogger({ appLogService, safeRecordAppLog })
  let settingsSidecarBridge = null
  let catalogSidecarBridge = null
  // Startup repairs can finish before the sidecar has completed its handshake.
  // Keep those authority writes in memory and replay them after hydration so a
  // slow sidecar cannot cause the repaired/fallback value to be lost.
  const deferredSettingsPersistence = []

  const flushDeferredSettingsPersistence = async () => {
    while (deferredSettingsPersistence.length > 0) {
      const input = deferredSettingsPersistence.shift()
      try {
        const backend = sidecarRuntimeCoordinator.getBackend?.()
        if (!backend || !settingsSidecarBridge) {
          deferredSettingsPersistence.unshift(input)
          return
        }
        const current = petService.getSettings?.() || {}
        const settings = settingsSidecarBridge.mergeCanonicalSettings(current, input.settings, input.paths)
        applyCanonicalSettings(settings)
        const snapshot = await settingsSidecarBridge.fetchSnapshot(backend)
        await settingsSidecarBridge.persistCanonicalSettings({ ...input, settings, ifVersion: snapshot.version })
      } catch (error) {
        deferredSettingsPersistence.unshift(input)
        safeRecordAppLog(appLogService, {
          scope: 'settings', level: 'error', actor: 'system', event: 'settings.deferred-persist.failed',
          message: error?.message || 'Deferred settings persistence failed'
        })
        return
      }
    }
  }

  const persistSettingsWhenBackendReady = (input) => {
    const backend = sidecarRuntimeCoordinator.getBackend?.()
    if (!backend || !settingsSidecarBridge) {
      deferredSettingsPersistence.push({ ...input, settings: structuredClone(input.settings), paths: [...(input.paths || [])] })
      if (sidecarRuntimeCoordinator.getBackend?.()) void flushDeferredSettingsPersistence()
      return null
    }
    return settingsSidecarBridge.fetchSnapshot(backend)
      .then((snapshot) => settingsSidecarBridge.persistCanonicalSettings({ ...input, ifVersion: snapshot.version }))
  }

  const applyCanonicalSettings = (settings) => {
    if (typeof petService.applySettings === 'function') return petService.applySettings(settings)
    return petService.saveSettings?.(settings)
  }

  let ipcRuntimeHelpers = {
    broadcastActivePetPackChanged: () => {},
    handlePetPackRequest: async () => {
      throw Object.assign(new Error('Shell Pet Pack authority is not ready'), { code: 'BACKEND_UNAVAILABLE' })
    },
    handleActionsRequest: async () => {
      throw Object.assign(new Error('Shell Actions authority is not ready'), { code: 'BACKEND_UNAVAILABLE' })
    }
  }

  const sidecarRuntimeCoordinator = factories.createSidecarRuntimeCoordinator({
    app,
    dialog,
    petService,
    secretService,
    getSettings: () => {
      const settings = settingsService.get()
      const localHttp = settings?.localHttp
      if (!localHttp?.enabled || localHttp.token) return settings
      const normalized = normalizeLocalHttpConfig(localHttp, localHttp)
      return settingsService.save({ ...settings, localHttp: normalized })
    },
    logger: sidecarLogger,
    onSettingsChanged: (message) => settingsSidecarBridge?.handle(message),
    onSettingsApplyRequest: (message) => settingsSidecarBridge?.handle(message),
    onCatalogRequest: (request) => {
      if (!catalogSidecarBridge) throw new Error('Shell Catalog service unavailable')
      return catalogSidecarBridge.handle(request)
    },
    onPetPackRequest: (request) => ipcRuntimeHelpers.handlePetPackRequest(request),
    onActionsRequest: (request) => ipcRuntimeHelpers.handleActionsRequest(request),
    onAiState: (snapshot) => aiSidecar.receive(snapshot),
    onAiHostRequest: ({ operation, payload }) => {
      if (operation === 'context') return {
        pack: petPackService.getActivePetPack(),
        actions: petService.getAnimations()?.actions || []
      }
      if (operation === 'present') return ipcRuntimeHelpers.presentAiChatResult(payload.result, payload.context)
      throw new Error('Unsupported AI host operation')
    },
    onReady: async () => {
      try {
        await settingsSidecarBridge?.hydrate()
      } catch (error) {
        safeRecordAppLog(appLogService, {
          scope: 'settings', level: 'error', actor: 'system', event: 'settings.hydrate.failed',
          message: error?.message || 'Backend settings hydration failed'
        })
      }
      await flushDeferredSettingsPersistence()
      await aiSidecar.hydrate()
    },
    productionService: async (request) => {
      const pluginId = String(request?.pluginId || '').trim()
      const serviceId = String(request?.serviceId || '').trim()
      switch (request?.operation) {
        case 'setup': return pluginService.runSetup(pluginId, String(request.setupId || '').trim())
        case 'service.start': return pluginService.startService(pluginId, serviceId)
        case 'service.stop': return pluginService.stopService(pluginId, serviceId)
        case 'service.health': return pluginService.checkServiceHealth(pluginId, serviceId)
        case 'service.health-policy': return pluginService.saveServiceHealthPolicy(pluginId, serviceId, request.policy || {})
        case 'storage.clear': return pluginService.clearStorage(pluginId)
        case 'secret.state': return pluginService.getImGatewaySecretState()
        case 'secret.save': return pluginService.saveImGatewayTelegramBotToken(request.token)
        case 'secret.clear': return pluginService.clearImGatewayTelegramBotToken()
        case 'secret.qq.save': return pluginService.saveImGatewayQqOfficialCredentials(request.credentials || {})
        case 'secret.qq.clear': return pluginService.clearImGatewayQqOfficialCredentials()
        case 'creator.default-flow': return creatorStudioDefaultFlowService.runDefaultFlow({ prompt: request.prompt })
        default: throw new Error('Unsupported plugin production operation')
      }
    },
    pidLedger: factories.createSidecarPidLedger
      ? factories.createSidecarPidLedger({ app, logger: sidecarLogger })
      : createDefaultSidecarPidLedger({ app, logger: sidecarLogger })
  })

  const createControlCenterWindow = () => {
    const settingsWindow = createSettingsWindow(getPetWindow())
    const backend = sidecarRuntimeCoordinator.getBackend()
    if (settingsWindow && !settingsWindow.isDestroyed?.()) {
      const bootstrap = () => settingsWindow.webContents?.send?.(IPC.SETTINGS_CHANGED, {
        __openpetBackend: backend,
        __openpetRuntimeStatus: systemCursorService?.getStatus?.(),
        __openpetSecretStorageSecurity: secretService?.getSecurityState?.() ?? null
      })
      if (settingsWindow.webContents?.isLoading?.() === false) bootstrap()
      else if (typeof settingsWindow.webContents?.once === 'function') settingsWindow.webContents.once('did-finish-load', bootstrap)
      else bootstrap()
    }
    return settingsWindow
  }

  const broadcastCursorSettings = (settings) => {
    const payload = createPetRendererSettings(settings, systemCursorService?.getStatus?.())
    const activePetWindow = getPetWindow()
    if (activePetWindow && !activePetWindow.isDestroyed?.()) {
      activePetWindow.webContents?.send?.(IPC.SETTINGS_CHANGED, payload)
      const settingsWindow = activePetWindow.settingsWindow
      if (settingsWindow && !settingsWindow.isDestroyed?.()) {
        settingsWindow.webContents?.send?.(IPC.SETTINGS_CHANGED, payload)
      }
    }
    return payload
  }

  const applySettingsHostEffect = createSettingsHostEffect({
    getPetWindow,
    petService,
    systemCursorService,
    cursorAssetService,
    petMovementPolicy,
    applyWindowScale,
    persistNormalization: (input) => settingsSidecarBridge?.persistNormalization?.(input),
    onNormalizationError: (error) => sidecarLogger.error('异步设置归一化持久化失败', { error: String(error) })
  })
  settingsSidecarBridge = createSettingsSidecarBridge({
    getBackend: () => sidecarRuntimeCoordinator.getBackend(),
    requestBackend: (body) => sidecarRuntimeCoordinator.requestBackend?.(body),
    fetchImpl,
    petService,
    applyHostSettings: applySettingsHostEffect,
    sendToPetRenderer: (settings) => broadcastCursorSettings(settings),
    logger: sidecarLogger
  })

  sidecarRuntimeCoordinator.onChanged?.((backend) => {
    aiSidecar.reset()
    const settingsWindow = getPetWindow()?.settingsWindow
    if (settingsWindow && !settingsWindow.isDestroyed?.()) {
      settingsWindow.webContents?.send?.(IPC.SETTINGS_CHANGED, {
        __openpetBackend: backend,
        __openpetRuntimeStatus: systemCursorService?.getStatus?.(),
        __openpetSecretStorageSecurity: secretService?.getSecurityState?.() ?? null
      })
    }
  })

  handleSystemCursorUnexpectedExit = async () => {
    const currentSettings = petService.getSettings()
    if (currentSettings.customCursorScope !== 'system') return currentSettings
    const fallbackSettings = applyCanonicalSettings({ ...currentSettings, customCursorScope: 'openpet' })
    broadcastCursorSettings(fallbackSettings)
    await persistSettingsWhenBackendReady({ settings: fallbackSettings, paths: ['customCursorScope'] })
    return fallbackSettings
  }

  const { petChatWindowService, petBubbleChatWindowService } = createWindowServices({
    BrowserWindow,
    app,
    screen,
    getPetWindow,
    createSettingsWindow: createControlCenterWindow,
    createPetChatWindowManager: factories.createPetChatWindowManager,
    createPetBubbleChatWindowManager: factories.createPetBubbleChatWindowManager,
    petMovementPolicy,
    settingsService,
    appLogService
  })

  try {
    console.log(`OpenPet app log: ${appLogService.logPath}`)
  } catch (error) {
    console.warn(`OpenPet app log unavailable: ${error.message}`)
  }

  let pluginService = null
  registerRuntimeAppLifecycle({
    app,
    appLogService,
    registerAppLifecycleLogs,
    safeRecordAppLog,
    triggerRuleRuntimeService,
    aiTalkService,
    systemCursorService,
    sidecarRuntimeCoordinator,
    getPluginService: () => pluginService
  })

  void Promise.resolve()
    .then(() => sidecarRuntimeCoordinator.start())
    .catch((error) => {
      safeRecordAppLog(appLogService, {
        scope: 'sidecar',
        level: 'error',
        actor: 'system',
        event: 'sidecar.startup.failed',
        message: error?.message || 'Sidecar startup failed'
      })
    })

  const cursorRepairPromise = registerCursorRepair({
    cursorAssetService,
    petService,
      appLogService,
    persistCanonicalSettings: (input) => {
      return persistSettingsWhenBackendReady(input)
    }
  })

  const pluginServices = createPluginServices({
    app,
    projectRoot,
    shell,
    dialog,
    getPetWindow,
    petService,
    actionService,
    actionImportService,
    petPackService,
    aiService,
    aiTalkService,
    imageGenerationModelService,
    secretService,
    triggerRuleRuntimeService,
    settingsService,
    appLogService,
    createBasicBehaviorPlugin: factories.createBasicBehaviorPlugin,
    syncBundledPlugins: factories.syncBundledPlugins,
    createPluginInstallService: factories.createPluginInstallService,
    createPluginGithubImportService: factories.createPluginGithubImportService,
    createPluginService: factories.createPluginService,
    createCatalogService: factories.createCatalogService,
    reloadAndSendAnimations,
    onActivePetPackChanged: () => ipcRuntimeHelpers.broadcastActivePetPackChanged({ source: 'plugin-service:onPetPackActivated' })
  })
  pluginService = pluginServices.pluginService
  setCatalogService(pluginServices.catalogService)
  catalogSidecarBridge = createCatalogSidecarBridge({
    catalogService: pluginServices.catalogService,
    getPetWindow,
    petService,
    reloadAndSendAnimations,
    refreshTriggerRuleRuntime: () => triggerRuleRuntimeService?.refresh?.(),
    getActionsViewState: () => ({
      ...petService.getPreviewAnimations(),
      triggerRuntimeDiagnostics: triggerRuleRuntimeService?.getDiagnostics?.() || {
        currentState: { actionId: '' },
        decisions: []
      }
    })
  })
  const hatchPetAgentService = factories.createHatchPetAgentService({
    aiService: aiSidecar.hatchAiService,
    configuration: aiSidecar.hatchConfiguration,
    pluginService,
    appLogService
  })
  pluginService.setHatchPetAgentService?.(hatchPetAgentService)
  const creatorStudioDefaultFlowService = factories.createCreatorStudioDefaultFlowService({
    pluginService,
    imageGenerationModelService
  })
  const creatorWorkflowService = factories.createCreatorWorkflowService({
    pluginService,
    imageGenerationModelService,
    actionService,
    creatorReferenceService,
    petPackService,
    hatchPetAgentService,
    appLogService
  })

  void runPostPluginStartupSideEffects({
    petService,
    localHttpService,
    normalizeLocalHttpConfig,
    syncLoginItemSettings,
    triggerRuleRuntimeService,
    cursorRepairPromise,
    systemCursorService,
    appLogService,
    onSystemCursorFallback: broadcastCursorSettings,
    persistSystemCursorFallback: async (settings) => {
      const backend = sidecarRuntimeCoordinator.getBackend?.()
      if (!backend) {
        applyCanonicalSettings(settings)
        await persistSettingsWhenBackendReady({ settings, paths: ['customCursorScope'] })
        return settings
      }
      const snapshot = await settingsSidecarBridge.fetchSnapshot(backend)
      await settingsSidecarBridge.persistCanonicalSettings({ settings, paths: ['customCursorScope'], ifVersion: snapshot.version })
      applyCanonicalSettings(settings)
      return settings
    }
  })

  ipcRuntimeHelpers = registerIpcHandlers({
    getPetWindow,
    petService,
    petPackService,
    aiService,
    aiTalkService,
    petUtteranceLogService,
    petBubbleChatWindowService,
    imageGenerationModelService,
    behaviorOrchestratorService,
    triggerRuleRuntimeService,
    creatorStudioDefaultFlowService,
    creatorWorkflowService,
    hatchPetAgentService,
    pluginService,
    pluginInstallService: pluginServices.pluginInstallService,
    pluginGithubImportService: pluginServices.pluginGithubImportService,
    localHttpService,
    actionService,
    actionImportService,
    cursorAssetService,
    systemCursorService,
    appLogService,
    applyWindowScale: (targetWindow, scale) => applyWindowScale(targetWindow, scale),
    applyPetViewport,
    clampToWorkArea,
    getMovementState,
    createSettingsWindow: createControlCenterWindow,
    petMovementPolicy,
    petChatWindowService,
    sidecarRuntimeCoordinator
  }) || ipcRuntimeHelpers

  let petWindow = createWindow({ load: false })
  setPetWindow(petWindow)

  registerDisplayLifecycle({
    screen,
    getPetWindow,
    petService,
    systemCursorService,
    petMovementPolicy,
    createPetRendererSettings,
    persistNormalization: async (input) => {
      return persistSettingsWhenBackendReady(input)
    }
  })
  registerPetWindowLifecycle({
    app,
    BrowserWindow,
    petWindow,
    getPetWindow,
    setPetWindow,
    createWindow,
    loadPetWindow,
    createSettingsWindow,
    petService,
    petPackService,
    petBubbleChatWindowService,
    pluginInstallService: pluginServices.pluginInstallService,
    pluginService,
    systemCursorService,
    applyWindowScale,
    createPetRendererSettings,
    maybeRunPackagedRuntimeSmoke,
    maybeRunPackagedPluginCleanupEvidence,
    maybeRunPackagedCreatorStudioEvidence,
    maybeRunPackagedCreatorStudioUiE2e,
    maybeRunPackagedCreateUiSmoke
  })

  return {
    appLogService,
    pluginService,
    sidecarRuntimeCoordinator
  }
}

module.exports = {
  createOpenPetRuntime
}
