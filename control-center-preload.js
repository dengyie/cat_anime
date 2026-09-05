/**
 * OpenPet Control Center 预加载脚本。
 *
 * 暴露配置管理 UI 需要的最小主进程接口。AI、插件和本地服务后续也从这里扩展，
 * 不让管理页面直接接触 Node.js / Electron API。
 */
const { contextBridge, ipcRenderer } = require('electron')

const IPC = {
  SETTINGS_CHANGED: 'settings:changed',
  SETTINGS_IMPORT_CURSOR: 'settings:import-cursor',
  SETTINGS_PREVIEW_SCALE: 'settings:preview-scale',
  SETTINGS_CLOSE: 'settings:close',
  PET_PACKS_INSPECT_DIRECTORY: 'pet-packs:inspect-directory',
  AI_GET_CONFIG: 'ai:get-config',
  AI_SAVE_CONFIG: 'ai:save-config',
  AI_SAVE_API_KEY: 'ai:save-api-key',
  AI_SAVE_VISION_API_KEY: 'ai:save-vision-api-key',
  AI_CLEAR_VISION_API_KEY: 'ai:clear-vision-api-key',
  AI_TEST_CONNECTION: 'ai:test-connection',
  AI_DISCOVER_MODELS: 'ai:discover-models',
  AI_DISCOVER_VISION_MODELS: 'ai:discover-vision-models',
  AI_GET_PERSONA_PROFILE: 'ai:get-persona-profile',
  AI_GENERATE_PERSONA_DRAFT: 'ai:generate-persona-draft',
  AI_SAVE_PERSONA_OVERRIDE: 'ai:save-persona-override',
  AI_GET_MEMORY_PROFILE: 'ai:get-memory-profile',
  AI_DELETE_MEMORY: 'ai:delete-memory',
  AI_CLEAR_PET_PACK_MEMORIES: 'ai:clear-pet-pack-memories',
  AI_TALK_GET_TRACE_SUMMARY: 'ai-talk:get-trace-summary',
  AI_TALK_EXPORT_TRACE: 'ai-talk:export-trace',
  HATCH_PET_AGENT_GET_CONFIG: 'hatch-pet-agent:get-config',
  HATCH_PET_AGENT_SAVE_CONFIG: 'hatch-pet-agent:save-config',
  HATCH_PET_AGENT_SAVE_API_KEY: 'hatch-pet-agent:save-api-key',
  HATCH_PET_AGENT_CLEAR_API_KEY: 'hatch-pet-agent:clear-api-key',
  HATCH_PET_AGENT_CHECK_CAPABILITY: 'hatch-pet-agent:check-capability',
  HATCH_PET_AGENT_GET_RUN_STATUS: 'hatch-pet-agent:get-run-status',
  IMAGE_GENERATION_GET_CONFIG: 'image-generation:get-config',
  IMAGE_GENERATION_SAVE_CONFIG: 'image-generation:save-config',
  IMAGE_GENERATION_SAVE_API_KEY: 'image-generation:save-api-key',
  IMAGE_GENERATION_CLEAR_API_KEY: 'image-generation:clear-api-key',
  IMAGE_GENERATION_CHECK_HEALTH: 'image-generation:check-health',
  IMAGE_GENERATION_DISCOVER_MODELS: 'image-generation:discover-models',
  AI_GET_CONVERSATION: 'ai:get-conversation',
  AI_CHAT: 'ai:chat',
  AI_EXPORT_TRACE_DIAGNOSTICS: 'ai:export-trace-diagnostics',
  AI_BEHAVIOR_GET: 'ai-behavior:get',
  AI_BEHAVIOR_SAVE: 'ai-behavior:save',
  AI_BEHAVIOR_DRY_RUN: 'ai-behavior:dry-run',
  AI_BEHAVIOR_REPLAY_DECISION: 'ai-behavior:replay-decision',
  AI_BEHAVIOR_EXPORT_DIAGNOSTICS: 'ai-behavior:export-diagnostics',
  AI_BEHAVIOR_CLEAR_DECISIONS: 'ai-behavior:clear-decisions',
  PET_PLAY_ACTION: 'pet:play-action',
  PET_BUBBLE_CHAT_OPEN: 'pet-bubble-chat:open',
  PET_CHAT_OPEN: 'pet-chat:open',
  PET_CHAT_GET_STATE: 'pet-chat:get-state',
  PET_CHAT_SEND_MESSAGE: 'pet-chat:send-message',
  PLUGINS_LIST: 'plugins:list',
  PLUGINS_SET_ENABLED: 'plugins:set-enabled',
  PLUGINS_SET_NATIVE_EXECUTION_APPROVED: 'plugins:set-native-execution-approved',
  PLUGINS_SAVE_CONFIG: 'plugins:save-config',
  PLUGINS_GET_IM_GATEWAY_SECRET_STATE: 'plugins:im-gateway:get-secret-state',
  PLUGINS_SAVE_IM_GATEWAY_TELEGRAM_TOKEN: 'plugins:im-gateway:save-telegram-token',
  PLUGINS_CLEAR_IM_GATEWAY_TELEGRAM_TOKEN: 'plugins:im-gateway:clear-telegram-token',
  PLUGINS_SAVE_IM_GATEWAY_QQ_CREDENTIALS: 'plugins:im-gateway:save-qq-credentials',
  PLUGINS_CLEAR_IM_GATEWAY_QQ_CREDENTIALS: 'plugins:im-gateway:clear-qq-credentials',
  PLUGINS_SAVE_IM_GATEWAY_WECOM_CREDENTIALS: 'plugins:im-gateway:save-wecom-credentials',
  PLUGINS_CLEAR_IM_GATEWAY_WECOM_CREDENTIALS: 'plugins:im-gateway:clear-wecom-credentials',
  PLUGINS_RUN_CREATOR_STUDIO_DEFAULT_FLOW: 'plugins:run-creator-studio-default-flow',
  PLUGINS_RUN_COMMAND: 'plugins:run-command',
  PLUGINS_RUN_SETUP: 'plugins:run-setup',
  PLUGINS_OPEN_DASHBOARD: 'plugins:open-dashboard',
  PLUGINS_START_SERVICE: 'plugins:start-service',
  PLUGINS_STOP_SERVICE: 'plugins:stop-service',
  PLUGINS_CHECK_SERVICE_HEALTH: 'plugins:check-service-health',
  PLUGINS_SAVE_SERVICE_HEALTH_POLICY: 'plugins:save-service-health-policy',
  PLUGINS_INSPECT_PACKAGE: 'plugins:inspect-package',
  PLUGINS_INSPECT_GITHUB_REPOSITORY: 'plugins:inspect-github-repository',
  PLUGINS_CLEAR_SELECTION: 'plugins:clear-selection',
  PLUGINS_INSTALL: 'plugins:install',
  PLUGINS_UPDATE: 'plugins:update',
  PLUGINS_UNINSTALL: 'plugins:uninstall',
  PLUGINS_GET_LOGS: 'plugins:get-logs',
  PLUGINS_EXPORT_LOGS: 'plugins:export-logs',
  PLUGINS_CLEAR_LOGS: 'plugins:clear-logs',
  PLUGINS_CLEAR_STORAGE: 'plugins:clear-storage',
  CREATOR_GET_STATE: 'creator:get-state',
  CREATOR_PICK_REFERENCE_IMAGE: 'creator:pick-reference-image',
  CREATOR_BIND_REFERENCE: 'creator:bind-reference',
  CREATOR_GENERATE_NEW_CHARACTER: 'creator:generate-new-character',
  CREATOR_GENERATE_EXISTING_ACTION: 'creator:generate-existing-action',
  CREATOR_RETRY_ACTION: 'creator:retry-action',
  CREATOR_RETRY_IDENTITY: 'creator:retry-identity',
  CREATOR_ACCEPT_IDENTITY: 'creator:accept-identity',
  CREATOR_ACCEPT_ACTION_CANDIDATE: 'creator:accept-action-candidate',
  CREATOR_EXPORT_RECOVERY_BUNDLE: 'creator:export-recovery-bundle',
  CREATOR_GET_LAST_RUN: 'creator:get-last-run',
  CREATOR_IMPORT_AVAILABLE_ACTIONS: 'creator:import-available-actions',
  CREATOR_GET_ASSET_PREVIEW: 'creator:get-asset-preview',
  SERVICE_GET_STATUS: 'service:get-status',
  SERVICE_SAVE_CONFIG: 'service:save-config',
  SERVICE_GET_LOGS: 'service:get-logs',
  SERVICE_EXPORT_LOGS: 'service:export-logs',
  SERVICE_CLEAR_LOGS: 'service:clear-logs',
  SERVICE_ROTATE_TOKEN: 'service:rotate-token',
  SERVICE_REVOKE_MCP_SESSIONS: 'service:revoke-mcp-sessions',
}

contextBridge.exposeInMainWorld('controlCenterAPI', {
  importCursor: () => ipcRenderer.invoke(IPC.SETTINGS_IMPORT_CURSOR),
  previewScale: (scale) => ipcRenderer.send(IPC.SETTINGS_PREVIEW_SCALE, scale),
  inspectPetPackDirectory: () => ipcRenderer.invoke(IPC.PET_PACKS_INSPECT_DIRECTORY),
  getAiConfig: () => ipcRenderer.invoke(IPC.AI_GET_CONFIG),
  saveAiConfig: (config) => ipcRenderer.invoke(IPC.AI_SAVE_CONFIG, config),
  saveAiApiKey: (apiKey) => ipcRenderer.invoke(IPC.AI_SAVE_API_KEY, apiKey),
  saveAiVisionApiKey: (apiKey) => ipcRenderer.invoke(IPC.AI_SAVE_VISION_API_KEY, apiKey),
  clearAiVisionApiKey: () => ipcRenderer.invoke(IPC.AI_CLEAR_VISION_API_KEY),
  testAiConnection: () => ipcRenderer.invoke(IPC.AI_TEST_CONNECTION),
  discoverAiModels: () => ipcRenderer.invoke(IPC.AI_DISCOVER_MODELS),
  discoverAiVisionModels: () => ipcRenderer.invoke(IPC.AI_DISCOVER_VISION_MODELS),
  getAiPersonaProfile: () => ipcRenderer.invoke(IPC.AI_GET_PERSONA_PROFILE),
  generateAiPersonaDraft: (request) => ipcRenderer.invoke(IPC.AI_GENERATE_PERSONA_DRAFT, request),
  saveAiPersonaOverride: (override) => ipcRenderer.invoke(IPC.AI_SAVE_PERSONA_OVERRIDE, override),
  getAiMemoryProfile: () => ipcRenderer.invoke(IPC.AI_GET_MEMORY_PROFILE),
  deleteAiMemory: (memoryId) => ipcRenderer.invoke(IPC.AI_DELETE_MEMORY, { memoryId }),
  clearAiPetPackMemories: () => ipcRenderer.invoke(IPC.AI_CLEAR_PET_PACK_MEMORIES),
  getAiTalkTraceSummary: (payload) => ipcRenderer.invoke(IPC.AI_TALK_GET_TRACE_SUMMARY, payload || {}),
  exportAiTalkTrace: (payload) => ipcRenderer.invoke(IPC.AI_TALK_EXPORT_TRACE, payload || {}),
  getHatchPetAgentConfig: () => ipcRenderer.invoke(IPC.HATCH_PET_AGENT_GET_CONFIG),
  saveHatchPetAgentConfig: (config) => ipcRenderer.invoke(IPC.HATCH_PET_AGENT_SAVE_CONFIG, config),
  saveHatchPetAgentApiKey: (apiKey) => ipcRenderer.invoke(IPC.HATCH_PET_AGENT_SAVE_API_KEY, apiKey),
  clearHatchPetAgentApiKey: () => ipcRenderer.invoke(IPC.HATCH_PET_AGENT_CLEAR_API_KEY),
  checkHatchPetAgentCapability: () => ipcRenderer.invoke(IPC.HATCH_PET_AGENT_CHECK_CAPABILITY),
  getHatchPetAgentRunStatus: (runId) => ipcRenderer.invoke(IPC.HATCH_PET_AGENT_GET_RUN_STATUS, { runId }),
  getImageGenerationConfig: () => ipcRenderer.invoke(IPC.IMAGE_GENERATION_GET_CONFIG),
  saveImageGenerationConfig: (config) => ipcRenderer.invoke(IPC.IMAGE_GENERATION_SAVE_CONFIG, config),
  saveImageGenerationApiKey: (apiKey) => ipcRenderer.invoke(IPC.IMAGE_GENERATION_SAVE_API_KEY, apiKey),
  clearImageGenerationApiKey: () => ipcRenderer.invoke(IPC.IMAGE_GENERATION_CLEAR_API_KEY),
  checkImageGenerationHealth: (payload) => ipcRenderer.invoke(IPC.IMAGE_GENERATION_CHECK_HEALTH, payload),
  discoverImageGenerationModels: () => ipcRenderer.invoke(IPC.IMAGE_GENERATION_DISCOVER_MODELS),
  getAiConversation: (conversationId) => ipcRenderer.invoke(IPC.AI_GET_CONVERSATION, { conversationId }),
  chat: (payload) => ipcRenderer.invoke(IPC.AI_CHAT, payload),
  exportAiTalkTraceDiagnostics: (filters) => ipcRenderer.invoke(IPC.AI_EXPORT_TRACE_DIAGNOSTICS, filters || {}),
  getPetChatState: () => ipcRenderer.invoke(IPC.PET_CHAT_GET_STATE),
  openPetBubbleChat: () => ipcRenderer.invoke(IPC.PET_BUBBLE_CHAT_OPEN),
  openPetChatWindow: () => ipcRenderer.invoke(IPC.PET_CHAT_OPEN),
  sendPetChatMessage: (payload) => ipcRenderer.invoke(IPC.PET_CHAT_SEND_MESSAGE, { ...(payload || {}), source: 'control-center' }),
  getAiBehavior: () => ipcRenderer.invoke(IPC.AI_BEHAVIOR_GET),
  saveAiBehavior: (config) => ipcRenderer.invoke(IPC.AI_BEHAVIOR_SAVE, config),
  dryRunAiBehavior: (payload) => ipcRenderer.invoke(IPC.AI_BEHAVIOR_DRY_RUN, payload),
  replayAiBehaviorDecision: (decisionId) => ipcRenderer.invoke(IPC.AI_BEHAVIOR_REPLAY_DECISION, { decisionId }),
  exportAiBehaviorDiagnostics: () => ipcRenderer.invoke(IPC.AI_BEHAVIOR_EXPORT_DIAGNOSTICS),
  clearAiBehaviorDecisions: () => ipcRenderer.invoke(IPC.AI_BEHAVIOR_CLEAR_DECISIONS),
  getPlugins: () => ipcRenderer.invoke(IPC.PLUGINS_LIST),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke(IPC.PLUGINS_SET_ENABLED, { pluginId, enabled }),
  setPluginNativeExecutionApproved: (pluginId, approved) => ipcRenderer.invoke(IPC.PLUGINS_SET_NATIVE_EXECUTION_APPROVED, { pluginId, approved }),
  savePluginConfig: (pluginId, config) => ipcRenderer.invoke(IPC.PLUGINS_SAVE_CONFIG, { pluginId, config }),
  getImGatewaySecretState: () => ipcRenderer.invoke(IPC.PLUGINS_GET_IM_GATEWAY_SECRET_STATE),
  saveImGatewayTelegramBotToken: (token) => ipcRenderer.invoke(IPC.PLUGINS_SAVE_IM_GATEWAY_TELEGRAM_TOKEN, { token }),
  clearImGatewayTelegramBotToken: () => ipcRenderer.invoke(IPC.PLUGINS_CLEAR_IM_GATEWAY_TELEGRAM_TOKEN),
  saveImGatewayQqOfficialCredentials: (credentials) => ipcRenderer.invoke(IPC.PLUGINS_SAVE_IM_GATEWAY_QQ_CREDENTIALS, credentials),
  clearImGatewayQqOfficialCredentials: () => ipcRenderer.invoke(IPC.PLUGINS_CLEAR_IM_GATEWAY_QQ_CREDENTIALS),
  saveImGatewayWecomCredentials: (credentials) => ipcRenderer.invoke(IPC.PLUGINS_SAVE_IM_GATEWAY_WECOM_CREDENTIALS, credentials),
  clearImGatewayWecomCredentials: () => ipcRenderer.invoke(IPC.PLUGINS_CLEAR_IM_GATEWAY_WECOM_CREDENTIALS),
  getCreatorState: () => ipcRenderer.invoke(IPC.CREATOR_GET_STATE),
  pickCreatorReferenceImage: () => ipcRenderer.invoke(IPC.CREATOR_PICK_REFERENCE_IMAGE),
  bindCreatorReference: (payload) => ipcRenderer.invoke(IPC.CREATOR_BIND_REFERENCE, payload),
  generateCreatorNewCharacter: (payload) => ipcRenderer.invoke(IPC.CREATOR_GENERATE_NEW_CHARACTER, payload),
  generateCreatorExistingAction: (payload) => ipcRenderer.invoke(IPC.CREATOR_GENERATE_EXISTING_ACTION, payload),
  retryCreatorAction: (payload) => ipcRenderer.invoke(IPC.CREATOR_RETRY_ACTION, payload),
  retryCreatorIdentity: (payload) => ipcRenderer.invoke(IPC.CREATOR_RETRY_IDENTITY, payload),
  acceptCreatorIdentity: (payload) => ipcRenderer.invoke(IPC.CREATOR_ACCEPT_IDENTITY, payload),
  acceptCreatorActionCandidate: (payload) => ipcRenderer.invoke(IPC.CREATOR_ACCEPT_ACTION_CANDIDATE, payload),
  exportCreatorRecoveryBundle: (payload) => ipcRenderer.invoke(IPC.CREATOR_EXPORT_RECOVERY_BUNDLE, payload),
  importCreatorAvailableActions: (payload) => ipcRenderer.invoke(IPC.CREATOR_IMPORT_AVAILABLE_ACTIONS, payload),
  getCreatorLastRun: () => ipcRenderer.invoke(IPC.CREATOR_GET_LAST_RUN),
  getCreatorAssetPreview: (payload) => ipcRenderer.invoke(IPC.CREATOR_GET_ASSET_PREVIEW, payload),
  playPetAction: (actionId) => ipcRenderer.invoke(IPC.PET_PLAY_ACTION, { actionId }),
  runCreatorStudioDefaultFlow: (prompt) => ipcRenderer.invoke(IPC.PLUGINS_RUN_CREATOR_STUDIO_DEFAULT_FLOW, { prompt }),
  runPluginCommand: (pluginId, commandId, payload) => ipcRenderer.invoke(IPC.PLUGINS_RUN_COMMAND, { pluginId, commandId, payload }),
  runPluginSetup: (pluginId, setupId) => ipcRenderer.invoke(IPC.PLUGINS_RUN_SETUP, { pluginId, setupId }),
  openPluginDashboard: (pluginId, dashboardId, options) => ipcRenderer.invoke(IPC.PLUGINS_OPEN_DASHBOARD, { pluginId, dashboardId, ...(options ? { options } : {}) }),
  startPluginService: (pluginId, serviceId) => ipcRenderer.invoke(IPC.PLUGINS_START_SERVICE, { pluginId, serviceId }),
  stopPluginService: (pluginId, serviceId) => ipcRenderer.invoke(IPC.PLUGINS_STOP_SERVICE, { pluginId, serviceId }),
  checkPluginServiceHealth: (pluginId, serviceId) => ipcRenderer.invoke(IPC.PLUGINS_CHECK_SERVICE_HEALTH, { pluginId, serviceId }),
  savePluginServiceHealthPolicy: (pluginId, serviceId, policy) => ipcRenderer.invoke(IPC.PLUGINS_SAVE_SERVICE_HEALTH_POLICY, { pluginId, serviceId, policy }),
  inspectPluginPackage: () => ipcRenderer.invoke(IPC.PLUGINS_INSPECT_PACKAGE),
  inspectPluginGithubRepository: (repositoryUrl) => ipcRenderer.invoke(IPC.PLUGINS_INSPECT_GITHUB_REPOSITORY, { repositoryUrl }),
  clearPluginSelection: (selectionId) => ipcRenderer.invoke(IPC.PLUGINS_CLEAR_SELECTION, { selectionId }),
  installPlugin: (selectionId) => ipcRenderer.invoke(IPC.PLUGINS_INSTALL, { selectionId }),
  updatePlugin: (selectionId) => ipcRenderer.invoke(IPC.PLUGINS_UPDATE, { selectionId }),
  uninstallPlugin: (pluginId, options) => ipcRenderer.invoke(IPC.PLUGINS_UNINSTALL, { pluginId, ...options }),
  getPluginLogs: (filters) => ipcRenderer.invoke(IPC.PLUGINS_GET_LOGS, filters),
  exportPluginLogs: (filters) => ipcRenderer.invoke(IPC.PLUGINS_EXPORT_LOGS, filters),
  clearPluginLogs: () => ipcRenderer.invoke(IPC.PLUGINS_CLEAR_LOGS),
  clearPluginStorage: (pluginId) => ipcRenderer.invoke(IPC.PLUGINS_CLEAR_STORAGE, { pluginId }),
  getServiceStatus: () => ipcRenderer.invoke(IPC.SERVICE_GET_STATUS),
  saveServiceConfig: (config) => ipcRenderer.invoke(IPC.SERVICE_SAVE_CONFIG, config),
  getServiceLogs: (filters) => ipcRenderer.invoke(IPC.SERVICE_GET_LOGS, filters),
  exportServiceLogs: (filters) => ipcRenderer.invoke(IPC.SERVICE_EXPORT_LOGS, filters),
  clearServiceLogs: () => ipcRenderer.invoke(IPC.SERVICE_CLEAR_LOGS),
  rotateServiceToken: () => ipcRenderer.invoke(IPC.SERVICE_ROTATE_TOKEN),
  revokeMcpSessions: () => ipcRenderer.invoke(IPC.SERVICE_REVOKE_MCP_SESSIONS),
  close: () => ipcRenderer.send(IPC.SETTINGS_CLOSE)
})

let currentBackend = null
let currentRuntimeStatus = { supported: false, platform: 'unknown', active: false, helperPid: 0 }
let currentSecretStorageSecurity = null
const backendListeners = new Set(), runtimeListeners = new Set(), secretStorageSecurityListeners = new Set()
const notifyRuntimeStatus = (status) => {
  if (!status || typeof status !== 'object') return
  currentRuntimeStatus = {
    supported: Boolean(status.supported),
    platform: typeof status.platform === 'string' ? status.platform : 'unknown',
    active: Boolean(status.active),
    helperPid: Number.isFinite(Number(status.helperPid)) ? Number(status.helperPid) : 0
  }
  runtimeListeners.forEach((listener) => listener(currentRuntimeStatus))
}
const notifyBackend = (backend, runtimeStatus) => {
  currentBackend = backend || null
  notifyRuntimeStatus(runtimeStatus)
  backendListeners.forEach((listener) => listener(currentBackend))
}
const notifySecretStorageSecurity = (state) => {
  if (!state || typeof state !== 'object') {
    currentSecretStorageSecurity = null
  } else {
    currentSecretStorageSecurity = {
      encryptionAvailable: Boolean(state.encryptionAvailable),
      storage: typeof state.storage === 'string' ? state.storage : '',
      warning: typeof state.warning === 'string' ? state.warning : ''
    }
  }
  secretStorageSecurityListeners.forEach((listener) => listener(currentSecretStorageSecurity))
}
const addListener = (listeners, listener) => {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}
contextBridge.exposeInMainWorld('openpetBackend', {
  getBackend: () => currentBackend,
  onChanged: (listener) => addListener(backendListeners, listener),
  getRuntimeStatus: () => currentRuntimeStatus,
  onRuntimeStatusChanged: (listener) => addListener(runtimeListeners, listener),
  getSecretStorageSecurity: () => currentSecretStorageSecurity,
  onSecretStorageSecurityChanged: (listener) => addListener(secretStorageSecurityListeners, listener)
})
const isBackendPayload = (payload) => Boolean(
  payload && typeof payload === 'object' && Object.hasOwn(payload, '__openpetBackend')
)
ipcRenderer.on(IPC.SETTINGS_CHANGED, (_event, payload) => {
  if (isBackendPayload(payload)) notifyBackend(payload.__openpetBackend, payload.__openpetRuntimeStatus)
  else if (payload?.systemCursorStatus) notifyRuntimeStatus(payload.systemCursorStatus)
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, '__openpetSecretStorageSecurity')) {
    notifySecretStorageSecurity(payload.__openpetSecretStorageSecurity)
  }
})
