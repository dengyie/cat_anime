/**
 * IPC 注册模块 —— 集中注册所有主进程侧 IPC 处理器。
 *
 * 为什么独立存在：
 * — 13 条 IPC 通道的注册逻辑如果散落在 main.js 中，会淹没应用生命周期代码。
 * — 依赖通过参数注入而非直接 import，避免与 window/settings/screen 模块形成硬耦合。
 * — 修改或新增 IPC 通道时，只需改这一个文件 + shared/ipc-channels.js。
 */
const { ipcMain, BrowserWindow, app, dialog, screen } = require('electron')
const { IPC } = require('../shared/ipc-channels')
const { sanitizeDetails } = require('./services/app-log-service')
const {
  buildPetContextMenuItems,
  constrainPetContextMenuSize,
  layoutPetContextMenu,
  measurePetContextMenu
} = require('./pet-context-menu')
const { showPetContextMenuWindow } = require('./pet-context-menu-window')
const { createBubbleRequestId } = require('./pet-bubble-chat-window')
const { createLocalHttpToken } = require('./services/local-http-service')
const { registerAiIpc } = require('./ipc/register-ai-ipc')
const { registerCreatorIpc } = require('./ipc/register-creator-ipc')
const { registerPetRuntimeIpc } = require('./ipc/register-pet-runtime-ipc')
const { registerPluginIpc } = require('./ipc/register-plugin-ipc')
const { registerSettingsIpc } = require('./ipc/register-settings-ipc')
const { registerServiceIpc } = require('./ipc/register-service-ipc')
const { registerSystemIpc } = require('./ipc/register-system-ipc')
const { createPetChatFacade } = require('./ipc/pet-chat-facade')
const { createActionsSidecarBridge } = require('./ipc/actions-sidecar-bridge')
const {
  collectCustomCursorAssetPaths,
  createPetRendererSettings,
  mergePetSettingsViewIntoHostSettings,
  normalizeLocalHttpConfig
} = require('./ipc/pet-settings-adapter')
const {
  createAiBehaviorConfigView,
  createAiBehaviorDecisionListView,
  createAiBehaviorResultView,
  createAiConfigView,
  createAiMemoryProfileView,
  createAiPersonaDraftView,
  createAiPersonaProfileView,
  createImageGenerationApiKeyResult,
  createImageGenerationConfigView,
  createImageGenerationHealthCheckResult,
  createPetPackMutationResult,
  createPluginCommandRunResult,
  createPluginListView,
  createPluginMutationResult,
  createPluginServiceControlResult,
  createPluginServiceHealthCheckResult,
  createPluginSetupRunResult,
  createPluginViewState,
  createServiceStatusView
} = require('./control-center-adapters')
const { findSemanticAction } = require('./services/ai-action-orchestrator')

const MAX_PET_BUBBLE_CHARS = 80

/**
 * 向宠物窗口安全推送消息的薄封装。
 * 自动检查窗口是否还存在，避免向已关闭的窗口发送消息导致异常。
 */
const sendToPetWindow = (getPetWindow, channel, data) => {
  const petWindow = getPetWindow()
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(channel, data)
  }
}

const sendToControlCenterWindow = (getPetWindow, channel, data) => {
  const petWindow = getPetWindow()
  const controlCenterWindow = petWindow?.settingsWindow
  if (controlCenterWindow && !controlCenterWindow.isDestroyed?.()) {
    controlCenterWindow.webContents?.send?.(channel, data)
  }
}

const reloadAndSendAnimations = (getPetWindow, petService) => {
  const animations = petService.reloadAnimations()
  sendToPetWindow(getPetWindow, IPC.PET_ANIMATIONS_CHANGED, animations)
  return animations
}

const createActionsViewState = (petService, triggerRuleRuntimeService = null, animations = null) => ({
  ...(animations || petService.getPreviewAnimations()),
  triggerRuntimeDiagnostics: triggerRuleRuntimeService?.getDiagnostics?.() || {
    currentState: { actionId: '' },
    decisions: []
  }
})

const triggerAiSemanticAction = (petService, reply) => {
  const action = findSemanticAction(reply, petService.getAnimations()?.actions || [])
  if (!action) return null
  try {
    return { ...action, ...petService.playAction({ actionId: action.actionId, source: 'ai' }) }
  } catch (error) {
    return { ...action, error: error.message }
  }
}

const executeBehaviorDecision = (petService, decision) => {
  if (!decision?.matched) return decision
  if (decision.type === 'say') {
    return { ...decision, result: petService.say({ text: decision.text, source: 'ai:behavior', sourceSurface: 'ai-behavior' }) }
  }
  if (decision.type === 'setEvent') {
    return { ...decision, result: petService.setEvent({ event: decision.event, message: decision.message, source: 'ai:behavior' }) }
  }
  if (decision.type === 'playAction') {
    return { ...decision, ...petService.playAction({ actionId: decision.actionId, source: 'ai:behavior' }) }
  }
  return decision
}

const sanitizeDiagnosticText = (value) => String(value || '')
  .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
  .slice(0, 240)

const normalizeMessageText = (value) => String(value || '').trim().replace(/\s+/g, ' ')

const createPetBubbleText = (reply, behaviorIntent, bubbleSegments = []) => {
  const preferred = normalizeMessageText(behaviorIntent?.bubbleText)
  const segmented = Array.isArray(bubbleSegments) ? normalizeMessageText(bubbleSegments[0]) : ''
  const text = preferred || segmented || normalizeMessageText(reply)
  if (text.length <= MAX_PET_BUBBLE_CHARS) return text
  return `${text.slice(0, MAX_PET_BUBBLE_CHARS - 3)}...`
}

const resolvePetSaySourceSurface = ({ source = '', requestSource = '' } = {}) => {
  const normalizedRequestSource = normalizeMessageText(requestSource)
  if (normalizedRequestSource) return normalizedRequestSource
  return normalizeMessageText(source) || 'control-center'
}

/**
 * 注册所有 IPC 处理器。接收依赖注入对象，各 handler 只通过注入的函数访问外部能力。
 */
const registerIpcHandlers = ({ getPetWindow, petService, petPackService, aiService, aiTalkService = null, hatchPetAgentService, petUtteranceLogService = null, petBubbleChatWindowService = null, imageGenerationModelService, behaviorOrchestratorService, triggerRuleRuntimeService = null, creatorStudioDefaultFlowService = null, creatorWorkflowService = null, pluginService, pluginInstallService, pluginGithubImportService, localHttpService, actionService, actionImportService, cursorAssetService, systemCursorService, appLogService, applyWindowScale, applyPetViewport = () => {},
  clampToWorkArea, getMovementState, createSettingsWindow, petMovementPolicy, petChatWindowService = null, sidecarRuntimeCoordinator = null, browserWindowService = BrowserWindow, dialogService = dialog, ipcMainService = ipcMain, screenService = screen, appService = app, showContextMenuWindow = showPetContextMenuWindow }) => {

  const showOpenDialogForEvent = (event, options) => {
    const parentWindow = event?.sender && browserWindowService?.fromWebContents?.(event.sender)
    if (parentWindow && !parentWindow.isDestroyed?.()) {
      return dialogService.showOpenDialog(parentWindow, options)
    }
    return dialogService.showOpenDialog(options)
  }

  const recordAppLog = (entry) => {
    try {
      appLogService?.record?.(entry)
    } catch (_) {
      // Logging must never break the user action that triggered it.
    }
  }

  const refreshTriggerRuleRuntime = () => {
    triggerRuleRuntimeService?.refresh?.()
  }

  const actionsSidecarBridge = createActionsSidecarBridge({
    actionService, actionImportService, petService, getPetWindow,
    getActivePackId: () => petPackService.listPacks()?.activePackId || '',
    showOpenDialogForEvent,
    createActionsViewState: (animations = null) => createActionsViewState(petService, triggerRuleRuntimeService, animations),
    reloadAndSendAnimations, refreshTriggerRuleRuntime, recordAppLog
  })
  ipcMainService.handle(IPC.ACTIONS_INSPECT_FRAMES, (event, payload) => actionsSidecarBridge.inspect(event, payload))

  const petChatFacade = createPetChatFacade({
    getPetWindow,
    browserWindowService,
    petPackService,
    aiService,
    aiTalkService,
    petUtteranceLogService,
    petChatWindowService,
    petBubbleChatWindowService,
    recordAppLog,
    onActivePetPackChanged: (payload) => sidecarRuntimeCoordinator?.notifyBackend?.({
      type: 'pet.pack-activated',
      payload
    })
  })

  const assertPetChatReady = () => {
    const config = aiService?.getConfig?.() || {}
    if (!config.enabled) throw new Error('请先在 Control Center 启用 AI Provider')
    if (!config.hasApiKey) throw new Error('请先在 Control Center 保存 AI API Key')
  }

  const requestAppQuit = (source) => {
    recordAppLog({
      scope: 'app',
      level: 'info',
      actor: 'user',
      event: 'app.quit.requested',
      message: 'OpenPet quit requested',
      details: { source }
    })
    appService.quit()
  }

  const broadcastAiTalkStreamState = (state = {}) => {
    petBubbleChatWindowService?.applyStreamState?.(state)
    petChatWindowService?.applyStreamState?.(state)
  }

  const runAiChatRequest = async (payload, { source = 'control-center', entrypoint } = {}) => {
    const requestPayload = entrypoint && !payload?.entrypoint
      ? { ...payload, entrypoint }
      : payload
    const requestId = typeof requestPayload?.requestId === 'string' && requestPayload.requestId.trim()
      ? requestPayload.requestId.trim().slice(0, 120)
      : createBubbleRequestId()
    const sourceSurface = resolvePetSaySourceSurface({ source, requestSource: source })
    const startedAt = Date.now()
    const messageChars = typeof requestPayload?.message === 'string' ? requestPayload.message.trim().length : 0
    const requestedConversationId = typeof requestPayload?.conversationId === 'string' ? requestPayload.conversationId.slice(0, 160) : ''
    recordAppLog({
      scope: 'ai-chat',
      level: 'info',
      actor: 'user',
      event: 'ai-chat.ipc.received',
      message: 'AI chat IPC request received',
      details: {
        source,
        sourceSurface,
        requestId,
        requestedConversationId,
        messageChars,
        service: aiTalkService ? 'ai-talk' : 'ai'
      }
    })
    try {
      const result = typeof aiTalkService?.streamChat === 'function'
        ? await aiTalkService.streamChat({
            ...requestPayload,
            onState: broadcastAiTalkStreamState
          })
        : await (aiTalkService || aiService).chat(requestPayload)
      const bubbleText = createPetBubbleText(result.reply, result.behaviorIntent, result.bubbleSegments)
      const bubble = bubbleText
        ? petChatFacade.captureBubble({ text: bubbleText, source: 'ai' }, { notify: false })
        : petChatFacade.getLastBubble()
      if (bubbleText) {
        recordAppLog({
          scope: 'ai-chat',
          level: 'info',
          actor: 'system',
          event: 'ai-chat.bubble.dispatching',
          message: 'AI chat bubble dispatching to pet service',
          details: {
            source,
            sourceSurface,
            requestId,
            textChars: bubbleText.length
          }
        })
        const sayResult = petService.say({
          text: bubbleText,
          source: 'ai',
          sourceSurface,
          requestId
        })
        recordAppLog({
          scope: 'ai-chat',
          level: 'info',
          actor: 'system',
          event: 'ai-chat.bubble.dispatched',
          message: 'AI chat bubble dispatched to pet service',
          details: {
            source,
            sourceSurface,
            requestId,
            textChars: String(sayResult?.text || '').length,
            hasTtl: Number.isFinite(Number(sayResult?.ttlMs))
          }
        })
      }
      if (behaviorOrchestratorService?.getConfig?.().enabled) {
        const decision = behaviorOrchestratorService.evaluate({
          reply: result.reply,
          behaviorIntent: result.behaviorIntent,
          actions: petService.getAnimations()?.actions || []
        })
        const behavior = executeBehaviorDecision(petService, decision)
        const response = behavior?.matched && behavior.type === 'playAction'
          ? { ...result, behavior, action: behavior }
          : { ...result, behavior }
        recordAppLog({
          scope: 'ai-chat',
          level: 'info',
          actor: 'system',
          event: 'ai-chat.ipc.completed',
          message: 'AI chat IPC request completed',
          details: {
            source,
            sourceSurface,
            requestId,
            requestedConversationId,
            conversationId: result.conversationId || '',
            elapsedMs: Date.now() - startedAt,
            replyChars: String(result.reply || '').length,
            bubbleChars: bubbleText.length,
            bubbleSegmentCount: Array.isArray(result.bubbleSegments) ? result.bubbleSegments.length : 0,
            messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
            behaviorMatched: Boolean(behavior?.matched),
            actionId: behavior?.actionId || ''
          }
        })
        return petChatFacade.attachState(response, bubble)
      }
      const action = triggerAiSemanticAction(petService, result.reply)
      const response = action ? { ...result, action } : result
      recordAppLog({
        scope: 'ai-chat',
        level: 'info',
        actor: 'system',
        event: 'ai-chat.ipc.completed',
        message: 'AI chat IPC request completed',
        details: {
          source,
          sourceSurface,
          requestId,
          requestedConversationId,
          conversationId: result.conversationId || '',
          elapsedMs: Date.now() - startedAt,
          replyChars: String(result.reply || '').length,
          bubbleChars: bubbleText.length,
          bubbleSegmentCount: Array.isArray(result.bubbleSegments) ? result.bubbleSegments.length : 0,
          messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
          actionId: action?.actionId || ''
        }
      })
      return petChatFacade.attachState(response, bubble)
    } catch (error) {
      recordAppLog({
        scope: 'ai-chat',
        level: 'error',
        actor: 'system',
        event: 'ai-chat.ipc.failed',
        message: 'AI chat IPC request failed',
        details: {
          source,
          sourceSurface,
          requestId,
          requestedConversationId,
          elapsedMs: Date.now() - startedAt,
          errorName: sanitizeDiagnosticText(error?.name || 'Error'),
          errorMessage: error?.providerStatus
            ? 'AI provider returned an error response'
            : sanitizeDiagnosticText(error?.message),
          providerStatus: error?.providerStatus || 0,
          providerCode: error?.providerCode || ''
        }
      })
      throw error
    }
  }


  petService.onSay?.((payload) => {
    petChatFacade.handlePetSay(payload)
  })
  petService.onAction?.((payload) => {
    sendToPetWindow(getPetWindow, IPC.PET_PLAY_ACTION, payload)
    petChatFacade.syncBubbleChatToPetWindow()
  })
  petService.onEvent?.((payload) => {
    petChatFacade.handlePetEvent(payload)
  })

  registerPetRuntimeIpc({
    ipcMainService,
    browserWindowService,
    petService,
    appService,
    screenService,
    getPetWindow,
    applyPetViewport,
    clampToWorkArea,
    getMovementState,
    createSettingsWindow,
    petMovementPolicy,
    petChatWindowService,
    petBubbleChatWindowService,
    buildPetContextMenuItems,
    constrainPetContextMenuSize,
    layoutPetContextMenu,
    measurePetContextMenu,
    showContextMenuWindow,
    createPetRendererSettings,
    recordAppLog,
    requestAppQuit,
    sanitizeDetails,
    sendToPetWindow
  })

  registerSystemIpc({
    ipcMainService,
    getPetWindow,
    createSettingsWindow,
    requestAppQuit
  })

  ipcMainService.handle(IPC.PET_CHAT_GET_STATE, () => {
    return petChatFacade.getState()
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_GET_STATE, () => {
    return petChatFacade.getBubbleChatState()
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_OPEN, () => {
    return petChatFacade.openBubbleChat()
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_SHOW_MESSAGE, (_event, payload = {}) => {
    return petChatFacade.showLocalBubbleChatMessage(payload)
  })

  ipcMainService.on(IPC.PET_BUBBLE_CHAT_HIDE, (_event, payload = {}) => {
    petChatFacade.hideBubbleChat(payload)
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_SET_PINNED, (_event, payload) => {
    return petChatFacade.setBubbleChatPinned(payload)
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_SET_INTERACTING, (_event, payload) => {
    return petChatFacade.setBubbleChatInteracting(payload)
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_SET_HIT_TEST_MODE, (_event, payload) => {
    return petChatFacade.setBubbleChatHitTestMode(payload)
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_DRAG_TO, (_event, payload = {}) => {
    return petChatFacade.dragBubbleChatWindowTo(payload)
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_CANCEL_MESSAGE, (_event, payload = {}) => {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim().slice(0, 120) : ''
    const result = aiTalkService?.cancelRequest?.({ requestId, reason: 'user-cancel', sourceSurface: 'bubble-chat' })
    return Boolean(result?.canceled)
  })

  ipcMainService.handle(IPC.PET_BUBBLE_CHAT_SEND_MESSAGE, async (_event, payload = {}) => {
    const startedAt = Date.now()
    const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
    const requestId = createBubbleRequestId()
    recordAppLog({
      scope: 'pet-bubble-chat',
      level: 'info',
      actor: 'user',
      event: 'pet-bubble-chat.message.started',
      message: 'Pet bubble chat message started',
      details: {
        requestId,
        messageChars: message.length
      }
    })
    try {
      assertPetChatReady()
      const queued = petBubbleChatWindowService?.queueOutgoingMessage?.({ text: message, requestId })
      if (!queued) {
        petBubbleChatWindowService?.setSendingState?.({
          sending: true,
          lastUserMessage: { text: message }
        })
      }
      if (queued && queued.shouldStartRequest === false) {
        recordAppLog({
          scope: 'pet-bubble-chat',
          level: 'info',
          actor: 'system',
          event: 'pet-bubble-chat.message.queued',
          message: 'Pet bubble chat message queued behind an active reply',
          details: {
            requestId,
            elapsedMs: Date.now() - startedAt
          }
        })
        return {
          conversationId: '',
          reply: '',
          bubbleSegments: [],
          queued: true,
          state: queued.state || petBubbleChatWindowService?.getState?.()
        }
      }
      const batchMessages = Array.isArray(queued?.batchMessages) && queued.batchMessages.length
        ? queued.batchMessages
        : [message]
      const runBubbleBatch = async (batchRequestId, messagesForBatch) => {
        const batchResult = await runAiChatRequest({
          message: messagesForBatch.at(-1) || '',
          messageBatch: messagesForBatch,
          entrypoint: 'control-center',
          requestId: batchRequestId
        }, { source: 'bubble-chat' })
        petBubbleChatWindowService?.completeRequest?.({
          requestId: batchRequestId,
          conversationMessages: Array.isArray(batchResult.messages) ? batchResult.messages : []
        })
        const nextRequestId = createBubbleRequestId()
        const queuedMessages = petBubbleChatWindowService?.startQueuedRequest?.(nextRequestId) || []
        if (queuedMessages.length) {
          void runBubbleBatch(nextRequestId, queuedMessages).catch((error) => {
            const safeMessage = error?.providerStatus
              ? 'AI provider returned an error response'
              : sanitizeDiagnosticText(error?.message)
            petBubbleChatWindowService?.failRequest?.({
              requestId: nextRequestId,
              error: safeMessage || 'Pet bubble chat message failed'
            })
          })
        }
        return batchResult
      }
      const result = await runBubbleBatch(requestId, batchMessages)
      if (!queued) {
        petBubbleChatWindowService?.setSendingState?.({
          sending: false,
          lastUserMessage: { text: message },
          error: ''
        })
      }
      const state = petChatFacade.refreshBubbleChatItems({ reason: 'bubble-chat-send' }) || petBubbleChatWindowService?.getState?.()
      recordAppLog({
        scope: 'pet-bubble-chat',
        level: 'info',
        actor: 'system',
        event: 'pet-bubble-chat.message.completed',
        message: 'Pet bubble chat message completed',
        details: {
          requestId,
          elapsedMs: Date.now() - startedAt,
          providerLatencyMs: Number.isFinite(result.providerLatencyMs) ? result.providerLatencyMs : 0,
          conversationId: result.conversationId || '',
          replyChars: String(result.reply || '').length,
          messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
          actionId: result.action?.actionId || result.behavior?.actionId || ''
        }
      })
      return { ...result, state }
    } catch (error) {
      const safeMessage = error?.providerStatus
        ? 'AI provider returned an error response'
        : sanitizeDiagnosticText(error?.message)
      if (petBubbleChatWindowService?.failRequest) {
        petBubbleChatWindowService.failRequest({
          requestId,
          error: safeMessage || 'Pet bubble chat message failed'
        })
      } else {
        petBubbleChatWindowService?.setSendingState?.({
          sending: false,
          lastUserMessage: message ? { text: message } : null,
          error: safeMessage || 'Pet bubble chat message failed'
        })
      }
      recordAppLog({
        scope: 'pet-bubble-chat',
        level: 'error',
        actor: 'system',
        event: 'pet-bubble-chat.message.failed',
        message: 'Pet bubble chat message failed',
        details: {
          requestId,
          elapsedMs: Date.now() - startedAt,
          errorName: sanitizeDiagnosticText(error?.name || 'Error'),
          errorMessage: safeMessage,
          providerStatus: error?.providerStatus || 0,
          providerCode: error?.providerCode || ''
        }
      })
      throw error
    }
  })

  ipcMainService.handle(IPC.PET_CHAT_OPEN, () => {
    petChatWindowService?.open?.()
    return petChatFacade.getState()
  })

  ipcMainService.on(IPC.PET_CHAT_HIDE, () => {
    petChatWindowService?.hide?.({ source: 'pet-chat-renderer' })
  })

  ipcMainService.handle(IPC.PET_CHAT_SET_ALWAYS_ON_TOP, (_event, payload) => {
    if (!petChatWindowService?.setAlwaysOnTop) return { available: false }
    petChatWindowService.setAlwaysOnTop(Boolean(payload?.alwaysOnTop))
    return petChatFacade.getState()
  })

  ipcMainService.on(IPC.PET_CHAT_OPEN_SETTINGS, () => {
    petChatWindowService?.openSettings?.()
  })

  ipcMainService.handle(IPC.PET_CHAT_CANCEL_MESSAGE, (_event, payload = {}) => {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim().slice(0, 120) : ''
    const result = aiTalkService?.cancelRequest?.({ requestId, reason: 'user-cancel', sourceSurface: 'pet-chat' })
    return Boolean(result?.canceled)
  })

  ipcMainService.handle(IPC.PET_CHAT_SEND_MESSAGE, async (_event, payload = {}) => {
    const startedAt = Date.now()
    const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
    const source = payload?.source === 'control-center' ? 'control-center' : 'pet-chat'
    const requestId = createBubbleRequestId()
    recordAppLog({
      scope: 'pet-chat',
      level: 'info',
      actor: 'user',
      event: 'pet-chat.message.started',
      message: 'Pet chat message started',
      details: {
        source,
        requestId,
        messageChars: message.length
      }
    })
    try {
      assertPetChatReady()
      const result = await runAiChatRequest({ message, entrypoint: 'control-center', requestId }, { source })
      petChatFacade.refreshBubbleChatItems({ reason: 'pet-chat-send' })
      petChatWindowService?.clearStreamState?.(result.requestId || requestId)
      const state = petChatFacade.getState()
      recordAppLog({
        scope: 'pet-chat',
        level: 'info',
        actor: 'system',
        event: 'pet-chat.message.completed',
        message: 'Pet chat message completed',
        details: {
          source,
          requestId,
          elapsedMs: Date.now() - startedAt,
          conversationId: result.conversationId || '',
          messageCount: Array.isArray(result.messages) ? result.messages.length : 0,
          replyChars: String(result.reply || '').length,
          actionId: result.action?.actionId || result.behavior?.actionId || ''
        }
      })
      return { ...result, state }
    } catch (error) {
      recordAppLog({
        scope: 'pet-chat',
        level: 'error',
        actor: 'system',
        event: 'pet-chat.message.failed',
        message: 'Pet chat message failed',
        details: {
          source,
          requestId,
          elapsedMs: Date.now() - startedAt,
          errorName: sanitizeDiagnosticText(error?.name || 'Error'),
          errorMessage: error?.providerStatus
            ? 'AI provider returned an error response'
            : sanitizeDiagnosticText(error?.message),
          providerStatus: error?.providerStatus || 0,
          providerCode: error?.providerCode || ''
        }
      })
      throw error
    }
  })

  registerSettingsIpc({
    ipcMainService,
    petService,
    getPetWindow,
    browserWindowService,
    cursorAssetService,
    systemCursorService,
    petMovementPolicy,
    showOpenDialogForEvent,
    sendToPetWindow,
    createPetRendererSettings,
    sidecarRuntimeCoordinator,
    collectCustomCursorAssetPaths,
    mergePetSettingsViewIntoHostSettings,
    recordAppLog
  })

  ipcMainService.handle(IPC.PET_PACKS_INSPECT_DIRECTORY, async (event) => {
    const selected = await showOpenDialogForEvent(event, {
      title: '选择 Pet Pack 文件夹或 Codex Pet 包',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Pet Pack Package', extensions: ['zip'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true }
    return { canceled: false, ...(await petPackService.inspectPackSource(selected.filePaths[0])) }
  })

  const classifyPetPackError = (error, operation) => {
    if (typeof error?.code === 'string') return error
    const message = String(error?.message || error || 'Pet Pack operation failed')
    const normalized = message.toLowerCase()
    let code = 'INTERNAL'
    if (normalized.includes('cannot remove the active')) code = 'CONFLICT'
    else if (normalized.includes('pet pack is blocked') || normalized.includes('pet pack blocked')) code = 'PET_PACK_INCOMPATIBLE'
    else if (normalized.includes('not installed') || normalized.includes('not found') || normalized.includes('no longer available') || normalized.includes('expired')) code = 'NOT_FOUND'
    else if (
      normalized.includes('invalid') ||
      normalized.includes('required') ||
      normalized.includes('must ') ||
      normalized.includes('cannot ') ||
      normalized.includes('blocked') ||
      normalized.includes('does not exist') ||
      normalized.includes('inspection failed')
    ) code = 'VALIDATION_FAILED'
    else if (operation === 'list') code = 'INTERNAL'
    return Object.assign(error instanceof Error ? error : new Error(message), { code })
  }

  const handlePetPackRequest = async ({ operation, payload = {} } = {}) => {
    try {
      switch (operation) {
        case 'list':
          return petPackService.listPacks()
        case 'manifest':
          return petPackService.getPackManifest(payload.packId)
        case 'validate':
          return petPackService.inspectPackSource(payload.sourcePath)
        case 'clear-selection':
          return petPackService.clearPendingSelection(payload.selectionId)
        case 'import': {
          let selectionId = payload.selectionId
          if (!selectionId && payload.sourcePath) {
            const inspection = await petPackService.inspectPackSource(payload.sourcePath)
            if (!inspection?.valid || !inspection.selectionId) {
              throw new Error(inspection?.errors?.[0] || 'Pet pack inspection failed')
            }
            selectionId = inspection.selectionId
          }
          const previousActivePackId = petPackService.listPacks()?.activePackId || ''
          const result = petPackService.importPack(selectionId)
          const petPacks = petPackService.listPacks()
          if (result?.pack?.id && petPacks?.activePackId === result.pack.id) {
            const animations = reloadAndSendAnimations(getPetWindow, petService)
            refreshTriggerRuleRuntime()
            const mutationResult = createPetPackMutationResult(
              result,
              petPacks,
              createActionsViewState(petService, triggerRuleRuntimeService, animations)
            )
            if (previousActivePackId !== petPacks.activePackId) {
              petChatFacade.broadcastActivePetPackChanged({ source: 'pet-pack.import', payload: mutationResult })
            }
            return mutationResult
          }
          return createPetPackMutationResult(result, petPacks)
        }
        case 'export': {
          let outputDir = payload.target
          if (!outputDir) {
            const selected = await showOpenDialogForEvent(null, {
              title: '选择 Pet Pack 导出目录',
              properties: ['openDirectory', 'createDirectory']
            })
            if (selected.canceled || !selected.filePaths[0]) return { canceled: true }
            outputDir = selected.filePaths[0]
          }
          return { canceled: false, ...await petPackService.exportPack(payload.packId, outputDir) }
        }
        case 'activate': {
          const result = petPackService.setActivePack(payload.packId)
          const animations = reloadAndSendAnimations(getPetWindow, petService)
          refreshTriggerRuleRuntime()
          const mutationResult = createPetPackMutationResult(
            result,
            petPackService.listPacks(),
            createActionsViewState(petService, triggerRuleRuntimeService, animations)
          )
          petChatFacade.broadcastActivePetPackChanged({ source: 'pet-pack.activate', payload: mutationResult })
          return mutationResult
        }
        case 'remove': {
          const previousActivePackId = petPackService.listPacks()?.activePackId || ''
          const result = petPackService.removePack(payload.packId)
          const mutationResult = createPetPackMutationResult(result, petPackService.listPacks())
          if (previousActivePackId !== mutationResult.petPacks?.activePackId) {
            petChatFacade.broadcastActivePetPackChanged({ source: 'pet-pack.remove', payload: mutationResult })
          }
          return mutationResult
        }
        default:
          throw Object.assign(new Error('Unsupported Pet Pack operation'), { code: 'VALIDATION_FAILED' })
      }
    } catch (error) {
      throw classifyPetPackError(error, operation)
    }
  }
  registerAiIpc({
    ipcMainService,
    aiService,
    aiTalkService,
    hatchPetAgentService,
    imageGenerationModelService,
    behaviorOrchestratorService,
    petService,
    runAiChatRequest,
    createAiConfigView,
    createAiPersonaProfileView,
    createAiPersonaDraftView,
    createAiMemoryProfileView,
    createImageGenerationConfigView,
    createImageGenerationApiKeyResult,
    createImageGenerationHealthCheckResult,
    createAiBehaviorConfigView,
    createAiBehaviorResultView,
    createAiBehaviorDecisionListView
  })

  registerPluginIpc({
    ipcMainService,
    dialogService,
    creatorStudioDefaultFlowService,
    pluginService,
    pluginInstallService,
    pluginGithubImportService,
    createPluginListView,
    createPluginMutationResult,
    createPluginViewState,
    createPluginCommandRunResult,
    createPluginSetupRunResult,
    createPluginServiceControlResult,
    createPluginServiceHealthCheckResult
  })
  registerCreatorIpc({
    ipcMainService,
    showOpenDialogForEvent,
    creatorWorkflowService
  })

  registerServiceIpc({
    ipcMainService,
    petService,
    localHttpService,
    normalizeLocalHttpConfig,
    createLocalHttpToken,
    createServiceStatusView,
    sidecarRuntimeCoordinator
  })

  return {
    broadcastActivePetPackChanged: petChatFacade.broadcastActivePetPackChanged,
    handlePetPackRequest,
    handleActionsRequest: actionsSidecarBridge.handle
  }
}

module.exports = { createPetRendererSettings, normalizeLocalHttpConfig, reloadAndSendAnimations, registerIpcHandlers, triggerAiSemanticAction, executeBehaviorDecision }
