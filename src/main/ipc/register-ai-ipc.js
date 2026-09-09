const { IPC } = require('../../shared/ipc-channels')

const registerAiIpc = ({
  ipcMainService,
  hatchPetAgentService,
  imageGenerationModelService,
  createImageGenerationConfigView,
  createImageGenerationApiKeyResult,
  createImageGenerationHealthCheckResult
}) => {
  ipcMainService.handle(IPC.HATCH_PET_AGENT_CHECK_CAPABILITY, () => hatchPetAgentService.checkCapability())
  ipcMainService.handle(IPC.HATCH_PET_AGENT_GET_RUN_STATUS, (_event, payload) => (
    hatchPetAgentService.getRunStatus(payload?.runId || payload)
  ))

  ipcMainService.handle(IPC.IMAGE_GENERATION_GET_CONFIG, () => createImageGenerationConfigView(imageGenerationModelService.getConfig()))
  ipcMainService.handle(IPC.IMAGE_GENERATION_SAVE_CONFIG, (_event, config) => createImageGenerationConfigView(imageGenerationModelService.saveConfig(config)))
  ipcMainService.handle(IPC.IMAGE_GENERATION_SAVE_API_KEY, (_event, apiKey) => createImageGenerationApiKeyResult(imageGenerationModelService.saveProviderApiKey(apiKey)))
  ipcMainService.handle(IPC.IMAGE_GENERATION_CLEAR_API_KEY, () => createImageGenerationApiKeyResult(imageGenerationModelService.clearProviderApiKey()))
  ipcMainService.handle(IPC.IMAGE_GENERATION_CHECK_HEALTH, async (_event, payload) => (
    createImageGenerationHealthCheckResult(await imageGenerationModelService.checkHealth(payload || {}))
  ))
  ipcMainService.handle(IPC.IMAGE_GENERATION_DISCOVER_MODELS, (_event, payload) => (
    imageGenerationModelService.discoverModels(payload || {})
  ))
}

module.exports = { registerAiIpc }
