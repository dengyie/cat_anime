/**
 * OpenPet 应用入口 — Electron 主进程。
 *
 * 职责：
 * 1. 应用生命周期（启动、退出、单实例锁、macOS Dock 激活）
 * 2. 组装 src/main/ 各模块并注入依赖
 *
 * 不包含：窗口创建细节、IPC 处理、设置读写、屏幕计算 —— 均在 src/main/ 中。
 */
const { app, BrowserWindow, dialog, shell, screen } = require('electron')
const fs = require('fs')
const path = require('path')
const { IPC } = require('./src/shared/ipc-channels')
const { clampToWorkArea, getMovementState } = require('./src/main/screen')
const { applyPetViewport, applyWindowScale, createWindow, createSettingsWindow, loadPetWindow } = require('./src/main/window')
const { createPetChatWindowManager } = require('./src/main/pet-chat-window')
const { createPetBubbleChatWindowManager } = require('./src/main/pet-bubble-chat-window')
const { createPetRendererSettings, normalizeLocalHttpConfig, reloadAndSendAnimations, registerIpcHandlers } = require('./src/main/ipc')
const { createOpenPetRuntime } = require('./src/main/bootstrap/create-openpet-runtime')
const { configureUserDataPath } = require('./src/main/user-data-path')
const { createEventBus } = require('./src/main/services/event-bus')
const { createSettingsService } = require('./src/main/services/settings-service')
const { createActionService } = require('./src/main/services/action-service')
const { createPetPackService } = require('./src/main/services/pet-pack-service')
const { createPetService } = require('./src/main/services/pet-service')
const { createSecretService } = require('./src/main/services/secret-service')
const { createImageGenerationModelService } = require('./src/main/services/image-generation-model-service')
const { createTriggerRuleRuntimeService } = require('./src/main/services/trigger-rule-runtime-service')
const { createCreatorReferenceService } = require('./src/main/services/creator-reference-service')
const { createCreatorStudioDefaultFlowService } = require('./src/main/services/creator-studio-default-flow-service')
const { createCreatorWorkflowService } = require('./src/main/services/creator-workflow-service')
const { createHatchPetAgentService } = require('./src/main/services/hatch-pet-agent-service')
const { createPluginService } = require('./src/main/services/plugin-service')
const { createPluginInstallService } = require('./src/main/services/plugin-install-service')
const { syncBundledPlugins } = require('./src/main/services/bundled-plugin-sync-service')
const { createPluginGithubImportService } = require('./src/main/services/plugin-github-import-service')
const { createLocalHttpService } = require('./src/main/services/local-http-service')
const { createActionImportService } = require('./src/main/services/action-import-service')
const { createCursorAssetService } = require('./src/main/services/cursor-asset-service')
const { createSystemCursorService } = require('./src/main/services/system-cursor-service')
const { createAppLogService } = require('./src/main/services/app-log-service')
const { createCatalogService } = require('./src/main/services/catalog-service')
const { registerAppLifecycleLogs, safeRecordAppLog } = require('./src/main/app-lifecycle-logger')
const { createPetMovementPolicy } = require('./src/main/pet-movement-policy')
const { configureSingleInstanceLock } = require('./src/main/single-instance')
const { maybeRunPackagedRuntimeSmoke } = require('./src/main/packaged-runtime-smoke-runner')
const { maybeRunPackagedPluginCleanupEvidence } = require('./src/main/packaged-plugin-cleanup-evidence-runner')
const { maybeRunPackagedCreatorStudioEvidence } = require('./src/main/packaged-creator-studio-evidence-runner')
const { maybeRunPackagedCreatorStudioUiE2e } = require('./src/main/packaged-creator-studio-ui-e2e-runner')
const { maybeRunPackagedCreateUiSmoke } = require('./src/main/packaged-create-ui-smoke-runner')
const { createBasicBehaviorPlugin } = require('./src/main/plugins/official/basic-behavior')
const { createSidecarRuntimeCoordinator } = require('./apps/desktop/src/sidecar/runtime-coordinator')
const { createDefaultSidecarPidLedger } = require('./apps/desktop/src/sidecar/orphan-cleanup')
let petWindow = null
const getPetWindow = () => petWindow

// Keep the pre-OpenPet userData directory so upgrades retain settings,
// secrets, installed plugins, pet packs, and local service state.
// Electron's single-instance lock is scoped by app identity/user data,
// so configure this before requesting the lock.
configureUserDataPath({ app })

// ── 单实例锁：同一时间只允许一个宠物窗口 ──
const canBootstrap = configureSingleInstanceLock({ app, getPetWindow })

const bootstrapOpenPet = () => {
  const { loadSettings, saveSettings, syncLoginItemSettings } = require('./src/main/settings')
  createOpenPetRuntime({
    app,
    BrowserWindow,
    dialog,
    shell,
    screen,
    projectRoot: __dirname,
    settingsRuntime: {
      loadSettings,
      saveSettings,
      syncLoginItemSettings
    },
    getPetWindow,
    setPetWindow: (nextPetWindow) => { petWindow = nextPetWindow },
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
    factories: {
      createEventBus,
      createSettingsService,
      createActionService,
      createPetPackService,
      createPetService,
      createSecretService,
      createImageGenerationModelService,
      createTriggerRuleRuntimeService,
      createCreatorReferenceService,
      createCreatorStudioDefaultFlowService,
      createCreatorWorkflowService,
      createHatchPetAgentService,
      createPluginService,
      createPluginInstallService,
      syncBundledPlugins,
      createPluginGithubImportService,
      createLocalHttpService,
      createActionImportService,
      createCursorAssetService,
      createSystemCursorService,
      createAppLogService,
      createCatalogService,
      createPetMovementPolicy,
      createBasicBehaviorPlugin,
      createSidecarPidLedger: createDefaultSidecarPidLedger,
      createPetChatWindowManager,
      createPetBubbleChatWindowManager,
      createSidecarRuntimeCoordinator
    }
  })
}

// ── 应用就绪 ──
canBootstrap.then((canStart) => {
  if (!canStart) return null
  return app.whenReady().then(bootstrapOpenPet)
}).catch((error) => {
  console.error('Failed to bootstrap OpenPet:', error)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
