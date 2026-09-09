import { useEffect, useRef, useState } from 'react'
import { controlCenterAPI as api } from '../api/control-center-api'
import { aiHttpApi } from '../features/ai/api.ts'
import { nextPetPackActivationEventId } from '../features/pet-packs/api.ts'
import { useSse } from './useSse.ts'
import {
  cloneAiBehavior,
  cloneAiConfig,
  cloneAiMemoryProfile,
  cloneAiPersonaProfile,
  cloneAiTalkTraceSummary,
  cloneChatMessages,
  cloneImageGenerationConfig,
  clonePetChatState,
  defaultAiConfig,
  defaultAiMemoryProfile,
  defaultAiPersonaProfile,
  defaultImageGenerationConfig,
  defaultPetChatState
} from '../lib/defaults'
import { downloadTextFile } from '../lib/download'
import { messageFromError } from '../lib/errors'
import {
  buildProviderConfigSavePayload,
  buildImageGenerationConfigSavePayload,
  getProviderConfigChanges,
  getImageGenerationConfigChanges,
  hasImageGenerationConfigChanges,
  hasProviderConfigChanges,
  normalizeProviderBaseUrl,
  validateImageProviderConfig,
  validateProviderConfig
} from '../lib/ai-provider-config'
import {
  applySavedAiConfigState,
  applySavedImageGenerationConfigState
} from '../lib/provider-config-state'
import { formatProviderModelCatalogMeta } from '../lib/provider-model-catalog'
import { mergeSavedFields, shouldApplySaveResponse } from '../lib/async-save-state.mjs'
import type {
  AiBehaviorConfig,
  AiBehaviorResult,
  AiBehaviorRule,
  AiConfigViewState,
  AiConnectionTestResult,
  AiTalkTraceDiagnosticsFilters,
  AiMemoryProfileViewState,
  AiPersonaDraftViewState,
  AiPersonaOverride,
  AiPersonaProfileViewState,
  AiTalkTraceSummaryViewState,
  ChatMessage,
  HatchPetAgentCapabilityResult,
  HatchPetAgentConfigSaveRequest,
  HatchPetAgentConfigView,
  ImageGenerationHealthCheckResult,
  ImageGenerationConfigViewState,
  ProviderModelDiscoveryResult,
  PetChatStateViewState,
  VisionConfigViewState
} from '../../../shared/openpet-contracts'
import type { AiPaneProps } from '../panes/AiPane'

const getMainConversationId = (petPackId: string) => (
  petPackId ? `control-center:${petPackId}:main` : undefined
)

const parseBehaviorRules = (rulesText: string): AiBehaviorRule[] => {
  const parsed: unknown = JSON.parse(rulesText || '[]')
  if (!Array.isArray(parsed)) throw new Error('Behavior rules must be a JSON array')
  return parsed as AiBehaviorRule[]
}

const personaFields = ['name', 'identity', 'tone', 'speakingStyle', 'relationshipToUser', 'actionStyle'] as const
const personaListFields = ['coreTraits', 'boundaries'] as const

const personaToDraft = (override: AiPersonaOverride) => ({
  name: override.name || '',
  identity: override.identity || '',
  tone: override.tone || '',
  speakingStyle: override.speakingStyle || '',
  relationshipToUser: override.relationshipToUser || '',
  actionStyle: override.actionStyle || '',
  coreTraitsText: Array.isArray(override.coreTraits) ? override.coreTraits.join('\n') : '',
  boundariesText: Array.isArray(override.boundaries) ? override.boundaries.join('\n') : ''
})

const normalizePersonaListText = (value: string) => (
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
)

const buildPersonaOverrideFromDraft = (draft: ReturnType<typeof personaToDraft>): AiPersonaOverride => {
  const override: AiPersonaOverride = {}
  for (const field of personaFields) {
    const value = draft[field].trim()
    if (value) override[field] = value
  }
  const coreTraits = normalizePersonaListText(draft.coreTraitsText)
  const boundaries = normalizePersonaListText(draft.boundariesText)
  if (coreTraits.length) override.coreTraits = coreTraits
  if (boundaries.length) override.boundaries = boundaries
  return override
}

const rebindTraceDiagnosticsFilters = ({
  currentFilters,
  petPackId,
  conversationId
}: {
  currentFilters: AiTalkTraceDiagnosticsFilters
  petPackId: string
  conversationId: string
}): AiTalkTraceDiagnosticsFilters => {
  if (String(currentFilters.conversationId || '').trim()) {
    return {
      petPackId,
      conversationId
    }
  }
  if (String(currentFilters.petPackId || '').trim()) {
    return {
      petPackId,
      conversationId: ''
    }
  }
  return {
    petPackId: '',
    conversationId: ''
  }
}

const formatConnectionStatus = ({
  result,
  hasUnsavedConfigChanges,
  hasUnsavedApiKeyDraft
}: {
  result: AiConnectionTestResult
  hasUnsavedConfigChanges: boolean
  hasUnsavedApiKeyDraft: boolean
}) => {
  const context = `${result.provider} · ${result.baseUrl} · ${result.model} · ${result.elapsedMs}ms`
  const notice = (hasUnsavedConfigChanges || hasUnsavedApiKeyDraft)
    ? '当前存在未保存修改；本次测试使用已保存配置。'
    : ''
  const localizedMessage = String(result.message || '')
    .replace(/^AI API key is not configured$/, '聊天 API Key 未配置')
    .replace(/^AI provider rejected the API key$/, '聊天 Provider 拒绝了当前 API Key')
    .replace(/^AI provider endpoint or model was not found$/, '聊天 Provider 的接口或模型不存在')
    .replace(/^AI provider rate limit exceeded$/, '聊天 Provider 已触发限流')
    .replace(/^AI provider is temporarily unavailable$/, '聊天 Provider 暂时不可用')
    .replace(/^AI provider returned an error response$/, '聊天 Provider 返回了错误响应')
    .replace(/^AI provider connection test succeeded$/, '聊天 Provider 连接测试通过')
  if (result.ok && result.modelsProbe === 'ok' && result.currentModelDiscovered === false) {
    const mismatch = `聊天 Provider 可达，但当前保存的聊天 Model 未出现在 /models 返回列表中；请手动确认模型名称或网关映射。`
    return notice ? `${notice} ${mismatch}` : mismatch
  }
  if (result.ok && result.modelsProbe === 'unavailable') {
    const unavailable = '聊天 Provider 可达，但模型列表探测不可用；请手动确认模型名称。'
    return notice ? `${notice} ${unavailable}` : unavailable
  }
  if (result.ok && result.modelsProbe === 'timed_out') {
    const timedOut = '聊天 Provider 可达，但模型列表探测超时。'
    return notice ? `${notice} ${timedOut}` : timedOut
  }
  if (result.ok && result.modelsProbe === 'failed') {
    const failed = '聊天 Provider 可达，但模型列表探测失败。'
    return notice ? `${notice} ${failed}` : failed
  }
  const details = result.ok
    ? `连接正常：${context}${result.reply ? ` · ${result.reply}` : ''}`
    : `连接失败：${localizedMessage || result.code || 'Unknown error'} · ${context}`
  return notice ? `${notice} ${details}` : details
}

const formatImageGenerationHealthStatus = (result: ImageGenerationHealthCheckResult) => {
  const label = '图片 Provider'
  const message = String(result.message || result.code || '')
    .replace(/^Cloud image generation API key is missing$/, 'Image generation API key is missing')
    .replace(/^Image generation API key is missing$/, '图片 API Key 未配置')
    .replace(/^Cloud provider is reachable, but the optional \/models probe is unavailable$/, 'provider 可达，但模型列表探测不可用')
    .replace(/^Image Provider is reachable, but the optional \/models probe is unavailable$/, 'provider 可达，但模型列表探测不可用')
  if (result.ok && result.modelsProbe === 'ok' && result.currentModelDiscovered === false) {
    return `${label} 可达，但当前保存的图片 Model 未出现在 /models 返回列表中；请手动确认模型名称或网关映射。`
  }
  if (result.ok) {
    if (result.code === 'provider_reachable_models_unavailable') {
      return `${label} 可达，但模型列表探测不可用；可继续尝试生成。`
    }
    return `${label} 健康检查通过：${message}`
  }
  return `${label} 健康检查失败：${message}`
}

const formatModelDiscoveryStatus = (label: string, result: ProviderModelDiscoveryResult) => {
  const code = String(result.code || '').trim().toLowerCase()
  if (result.ok) {
    if (result.code === 'provider_reachable_models_unavailable') {
      return `${label} 可达，但模型列表探测不可用；请手动填写模型名。`
    }
    if (result.models.length) {
      return `${label} 已发现 ${result.models.length} 个模型。`
    }
    return `${label} 探测完成，但 provider 没有返回可用模型。`
  }
  if (code.includes('timeout')) {
    return `${label} 模型探测超时：${result.message || result.code || 'unknown error'}`
  }
  return `${label} 模型探测失败：${result.message || result.code || 'unknown error'}`
}

const createChatModelDiscoveryFromConnectionTest = (result: AiConnectionTestResult): ProviderModelDiscoveryResult => ({
  ok: result.modelsProbe === 'ok' || result.modelsProbe === 'unavailable',
  provider: String(result.provider || '').trim(),
  baseUrl: String(result.baseUrl || '').trim(),
  model: String(result.model || '').trim(),
  hasApiKey: Boolean(result.hasApiKey),
  models: Array.isArray(result.availableModels) ? result.availableModels : [],
  code: result.modelsProbe === 'unavailable'
    ? 'provider_reachable_models_unavailable'
    : result.modelsProbe === 'timed_out'
      ? 'timeout'
      : result.modelsProbe === 'failed'
        ? 'probe_failed'
        : (String(result.code || '').trim() || (result.ok ? 'ok' : 'unknown_error')),
  message: result.modelsProbe === 'timed_out'
    ? 'AI provider model discovery timed out'
    : result.modelsProbe === 'failed'
      ? 'AI provider model discovery failed'
      : String(result.message || '').trim()
})

const createImageModelDiscoveryFromHealth = (
  result: ImageGenerationHealthCheckResult,
  activeConfig: ImageGenerationConfigViewState
): ProviderModelDiscoveryResult => ({
  ok: result.modelsProbe === 'ok' || result.modelsProbe === 'unavailable',
  provider: String(activeConfig.provider || '').trim(),
  baseUrl: String(activeConfig.baseUrl || '').trim(),
  model: String(activeConfig.model || '').trim(),
  hasApiKey: Boolean(activeConfig.hasApiKey),
  models: Array.isArray(result.availableModels) ? result.availableModels : [],
  code: result.modelsProbe === 'unavailable'
    ? 'provider_reachable_models_unavailable'
    : result.modelsProbe === 'timed_out'
      ? 'timeout'
      : result.modelsProbe === 'failed'
        ? 'probe_failed'
        : (String(result.code || '').trim() || (result.ok ? 'ok' : 'unknown_error')),
  message: result.modelsProbe === 'timed_out'
    ? 'Image Provider model discovery timed out after 25000ms'
    : result.modelsProbe === 'failed'
      ? 'Image Provider model discovery failed'
      : String(result.message || '').trim()
})

const getImageTransparencyCompatibilityHint = (model: string) => {
  const normalizedModel = String(model || '').trim()
  const normalizedModelId = normalizedModel.toLowerCase()
  if (!normalizedModel) return '请输入图片模型后再确认透明背景兼容策略。'
  if (normalizedModelId === 'gpt-image-2') {
    return 'gpt-image-2 使用不透明纯色背景合同：OpenPet host 不额外传 background 参数，生成后由本地去背流程产出透明素材。'
  }
  if (normalizedModelId === 'gpt-image-1' || normalizedModelId === 'gpt-image-1.5') {
    return `${normalizedModel} 已注册直接透明输出能力：OpenPet host 会发送 background=transparent，并请求 b64_json 输出。`
  }
  return `${normalizedModel} 未注册直接透明输出能力：OpenPet host 会发送 background=white，要求不透明纯色背景，并在生成后执行本地去背。`
}

const defaultHatchPetAgentConfig: HatchPetAgentConfigView = {
  enabled: false,
  executionMode: 'shadow',
  configMode: 'follow-chat',
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKeyRef: 'ai.hatch-pet',
  systemPromptVersion: 1,
  requireIdentityReviewBeforeActions: false,
  budgets: {
    maxIdentityRegenerations: 1,
    maxActionAttemptsPerAction: 3,
    maxEvaluationAttemptsPerArtifact: 2,
    maxProviderCalls: 64,
    maxElapsedMs: 3600000,
    maxEstimatedCost: null
  },
  hasApiKey: false,
  configSource: 'chat-fallback',
  effectiveProvider: 'openai-compatible',
  effectiveBaseUrl: 'https://api.openai.com/v1',
  effectiveModel: 'gpt-4o-mini'
}

const cloneHatchPetAgentConfig = (config: HatchPetAgentConfigView): HatchPetAgentConfigView => ({
  ...config,
  budgets: { ...config.budgets }
})

const buildHatchPetAgentConfigSaveRequest = (config: HatchPetAgentConfigView): HatchPetAgentConfigSaveRequest => ({
  enabled: config.enabled,
  configMode: config.configMode,
  provider: config.provider,
  baseUrl: config.baseUrl,
  model: config.model,
  requireIdentityReviewBeforeActions: config.requireIdentityReviewBeforeActions,
  budgets: { ...config.budgets }
})

export function useAiPane(activeTab = 'ai') {
  const petPackEvents = useSse(['pet'])
  const lastHandledPetPackEventIdRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSavingState] = useState(false)
  const savingOperationCountRef = useRef(0)
  const setSaving = (nextSaving: boolean) => {
    savingOperationCountRef.current = Math.max(0, savingOperationCountRef.current + (nextSaving ? 1 : -1))
    setSavingState(savingOperationCountRef.current > 0)
  }
  const [config, setConfig] = useState<AiConfigViewState>(defaultAiConfig)
  const [activeConfig, setActiveConfig] = useState<AiConfigViewState>(defaultAiConfig)
  const [personaProfile, setPersonaProfile] = useState<AiPersonaProfileViewState>(defaultAiPersonaProfile)
  const [memoryProfile, setMemoryProfile] = useState<AiMemoryProfileViewState>(defaultAiMemoryProfile)
  const [personaDraft, setPersonaDraft] = useState(() => personaToDraft(defaultAiPersonaProfile.overridePersona))
  const [personaGenerationInstruction, setPersonaGenerationInstruction] = useState('')
  const [generatedPersonaDraft, setGeneratedPersonaDraft] = useState<AiPersonaDraftViewState | null>(null)
  const [imageGenerationConfig, setImageGenerationConfig] = useState<ImageGenerationConfigViewState>(defaultImageGenerationConfig)
  const [activeImageGenerationConfig, setActiveImageGenerationConfig] = useState<ImageGenerationConfigViewState>(defaultImageGenerationConfig)
  const [hatchPetAgentConfig, setHatchPetAgentConfig] = useState<HatchPetAgentConfigView>(defaultHatchPetAgentConfig)
  const [activeHatchPetAgentConfig, setActiveHatchPetAgentConfig] = useState<HatchPetAgentConfigView>(defaultHatchPetAgentConfig)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [visionApiKeyDraft, setVisionApiKeyDraft] = useState('')
  const [imageApiKeyDraft, setImageApiKeyDraft] = useState('')
  const [hatchPetAgentApiKeyDraft, setHatchPetAgentApiKeyDraft] = useState('')
  const [status, setStatus] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('')
  const [visionStatus, setVisionStatus] = useState('')
  const [connectionTestResult, setConnectionTestResult] = useState<AiConnectionTestResult | null>(null)
  const [imageStatus, setImageStatus] = useState('')
  const [imageHealthStatus, setImageHealthStatus] = useState('')
  const [imageHealthResult, setImageHealthResult] = useState<ImageGenerationHealthCheckResult | null>(null)
  const [hatchPetAgentStatus, setHatchPetAgentStatus] = useState('')
  const [hatchPetAgentCapabilityResult, setHatchPetAgentCapabilityResult] = useState<HatchPetAgentCapabilityResult | null>(null)
  const [chatStatus, setChatStatus] = useState('')
  const [chatModelDiscovery, setChatModelDiscovery] = useState<ProviderModelDiscoveryResult | null>(null)
  const [chatModelDiscoveryStatus, setChatModelDiscoveryStatus] = useState('')
  const [visionModelDiscovery, setVisionModelDiscovery] = useState<ProviderModelDiscoveryResult | null>(null)
  const [visionModelDiscoveryStatus, setVisionModelDiscoveryStatus] = useState('')
  const [imageModelDiscovery, setImageModelDiscovery] = useState<ProviderModelDiscoveryResult | null>(null)
  const [imageModelDiscoveryStatus, setImageModelDiscoveryStatus] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [petChatState, setPetChatState] = useState<PetChatStateViewState>(defaultPetChatState)
  const [traceDiagnosticsFilters, setTraceDiagnosticsFilters] = useState<AiTalkTraceDiagnosticsFilters>({})
  const [traceSummary, setTraceSummary] = useState<AiTalkTraceSummaryViewState | null>(null)
  const [chatting, setChatting] = useState(false)
  const [behavior, setBehavior] = useState<AiBehaviorConfig>(defaultAiConfig.behavior)
  const [behaviorRulesText, setBehaviorRulesText] = useState('[]')
  const [dryRunText, setDryRunText] = useState('')
  const [dryRunResult, setDryRunResult] = useState<AiBehaviorResult | null>(null)
  const [replayDraft, setReplayDraft] = useState('')
  const [replayResult, setReplayResult] = useState<AiBehaviorResult | null>(null)
  const [behaviorStatus, setBehaviorStatus] = useState('')
  const saveRevisionRef = useRef({ provider: 0, image: 0, behavior: 0 })
  const appliedSaveRevisionRef = useRef({ provider: 0, image: 0, behavior: 0 })

  const loadPersonaProfile = async () => {
    const profile = cloneAiPersonaProfile(await aiHttpApi.getAiPersonaProfile())
    setPersonaProfile(profile)
    setPersonaDraft(personaToDraft(profile.overridePersona))
    setGeneratedPersonaDraft((current) => (current?.petPackId === profile.petPackId ? current : null))
    return profile
  }

  const loadMemoryProfile = async () => {
    const profile = cloneAiMemoryProfile(await aiHttpApi.getAiMemoryProfile())
    setMemoryProfile(profile)
    return profile
  }

  const applyPetChatState = (state: PetChatStateViewState) => {
    const nextState = clonePetChatState(state)
    setPetChatState(nextState)
    setChatMessages(nextState.messages)
    return nextState
  }

  const loadPetChatState = async () => applyPetChatState(await api.getPetChatState())

  const loadAiConfig = async ({ preserveDraft = false } = {}) => {
    const nextConfig = cloneAiConfig(await aiHttpApi.getAiConfig())
    setConfig((current) => applySavedAiConfigState({
      draftConfig: current,
      savedConfig: nextConfig,
      preserveDraft
    }).config)
    setActiveConfig(nextConfig)
    return nextConfig
  }

  const loadHatchPetAgentConfig = async ({ preserveDraft = false } = {}) => {
    const nextConfig = cloneHatchPetAgentConfig(await aiHttpApi.getHatchPetAgentConfig())
    setHatchPetAgentConfig((current) => preserveDraft ? current : nextConfig)
    setActiveHatchPetAgentConfig(nextConfig)
    return nextConfig
  }

  const loadImageGenerationConfig = async ({ preserveDraft = false } = {}) => {
    const nextConfig = cloneImageGenerationConfig(await api.getImageGenerationConfig())
    setImageGenerationConfig((current) => applySavedImageGenerationConfigState({
      draftConfig: current,
      savedConfig: nextConfig,
      preserveDraft
    }).imageGenerationConfig)
    setActiveImageGenerationConfig(nextConfig)
    return nextConfig
  }

  const loadAiTalkTraceSummary = async (conversationId?: string) => {
    try {
      const summary = cloneAiTalkTraceSummary(await aiHttpApi.getAiTalkTraceSummary(
        conversationId ? { conversationId } : undefined
      ))
      setTraceSummary(summary)
      return summary
    } catch (_) {
      setTraceSummary(null)
      return null
    }
  }

  const refreshBubbleChatState = async () => {
    const nextState = await api.getPetChatState()
    setPetChatState((current) => clonePetChatState({
      ...current,
      bubbleChat: nextState.bubbleChat
    }))
    return nextState
  }

  const loadBehavior = async () => {
    const nextBehavior = cloneAiBehavior(await aiHttpApi.getAiBehavior())
    setBehavior(nextBehavior)
    setBehaviorRulesText(JSON.stringify(nextBehavior.rules || [], null, 2))
    setConfig((current) => ({ ...current, behavior: nextBehavior }))
    return nextBehavior
  }

  const refreshActivePetPackAiContext = async (reason = 'refresh') => {
    const [profile, memory, state, nextBehavior] = await Promise.all([
      aiHttpApi.getAiPersonaProfile(),
      aiHttpApi.getAiMemoryProfile(),
      api.getPetChatState(),
      aiHttpApi.getAiBehavior()
    ])
    const nextPersonaProfile = cloneAiPersonaProfile(profile)
    setPersonaProfile(nextPersonaProfile)
    setPersonaDraft(personaToDraft(nextPersonaProfile.overridePersona))
    setGeneratedPersonaDraft((current) => (current?.petPackId === nextPersonaProfile.petPackId ? current : null))
    setMemoryProfile(cloneAiMemoryProfile(memory))
    const nextPetChatState = applyPetChatState(state)
    setTraceDiagnosticsFilters((current) => {
      const activePetPackId = String(nextPetChatState.petPack.id || nextPersonaProfile.petPackId || '').trim()
      const activeConversationId = String(nextPetChatState.conversationId || `control-center:${activePetPackId}:main`).trim()
      return rebindTraceDiagnosticsFilters({
        currentFilters: current,
        petPackId: activePetPackId,
        conversationId: activeConversationId
      })
    })
    const behaviorConfig = cloneAiBehavior(nextBehavior)
    setBehavior(behaviorConfig)
    setBehaviorRulesText(JSON.stringify(behaviorConfig.rules || [], null, 2))
    setConfig((current) => ({ ...current, behavior: behaviorConfig }))
    await loadAiTalkTraceSummary(getMainConversationId(nextPetChatState.petPack.id))
    if (reason === 'active-pet-pack-changed') {
      setStatus(`已切换到 ${nextPersonaProfile.petPackDisplayName || nextPersonaProfile.petPackId} 的 AI 上下文`)
    }
  }

  const refreshActivePetPackState = async () => {
    const [, , nextPetChatState] = await Promise.all([
      loadPersonaProfile(),
      loadMemoryProfile(),
      loadPetChatState()
    ])
    await loadAiTalkTraceSummary(getMainConversationId(nextPetChatState.petPack.id))
  }

  useEffect(() => {
    let mounted = true
    Promise.all([
      aiHttpApi.getAiConfig(),
      aiHttpApi.getAiPersonaProfile(),
      aiHttpApi.getAiMemoryProfile(),
      api.getImageGenerationConfig(),
      aiHttpApi.getHatchPetAgentConfig(),
      api.getPetChatState(),
      aiHttpApi.getAiBehavior()
    ]).then(([loadedConfig, loadedPersonaProfile, loadedMemoryProfile, loadedImageGenerationConfig, loadedHatchPetAgentConfig, loadedPetChatState, loadedBehavior]) => {
      if (!mounted) return
      const nextConfig = cloneAiConfig(loadedConfig)
      setConfig(nextConfig)
      setActiveConfig(nextConfig)
      const nextPersonaProfile = cloneAiPersonaProfile(loadedPersonaProfile)
      setPersonaProfile(nextPersonaProfile)
      setPersonaDraft(personaToDraft(nextPersonaProfile.overridePersona))
      setMemoryProfile(cloneAiMemoryProfile(loadedMemoryProfile))
      const nextImageGenerationConfig = cloneImageGenerationConfig(loadedImageGenerationConfig)
      setImageGenerationConfig(nextImageGenerationConfig)
      setActiveImageGenerationConfig(nextImageGenerationConfig)
      const nextHatchPetAgentConfig = cloneHatchPetAgentConfig(loadedHatchPetAgentConfig)
      setHatchPetAgentConfig(nextHatchPetAgentConfig)
      setActiveHatchPetAgentConfig(nextHatchPetAgentConfig)
      const nextPetChatState = applyPetChatState(loadedPetChatState)
      const nextBehavior = cloneAiBehavior(loadedBehavior || loadedConfig?.behavior)
      setBehavior(nextBehavior)
      setBehaviorRulesText(JSON.stringify(nextBehavior.rules || [], null, 2))
      setLoading(false)
      void loadAiTalkTraceSummary(getMainConversationId(nextPetChatState.petPack.id))
    }).catch((error) => {
      if (!mounted) return
      setStatus(messageFromError(error, 'AI 配置加载失败'))
      setLoading(false)
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (activeTab !== 'ai') return
    void refreshActivePetPackAiContext('tab-active').catch(() => {})
  }, [activeTab])

  useEffect(() => {
    const eventId = nextPetPackActivationEventId(petPackEvents, lastHandledPetPackEventIdRef.current)
    if (!eventId) return
    lastHandledPetPackEventIdRef.current = eventId
    const eventPayload = petPackEvents.lastEventData
    if (eventPayload && typeof eventPayload === 'object' && 'petChatState' in eventPayload) {
      applyPetChatState((eventPayload as { petChatState: PetChatStateViewState }).petChatState)
    }
    setGeneratedPersonaDraft(null)
    setPersonaGenerationInstruction('')
    void refreshActivePetPackAiContext('active-pet-pack-changed').catch((error) => {
      setStatus(messageFromError(error, '刷新当前宠物 AI 上下文失败'))
    })
  }, [petPackEvents.lastEventId, petPackEvents.lastEventName])

  useEffect(() => {
    if (activeTab !== 'ai' || typeof window === 'undefined' || typeof document === 'undefined') return
    const handleWindowFocus = () => { void refreshBubbleChatState().catch(() => {}) }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshBubbleChatState().catch(() => {})
      }
    }
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activeTab])

  const saveProviderConfigDraft = async () => {
    const submittedConfig = cloneAiConfig(config)
    const submittedActiveConfig = cloneAiConfig(activeConfig)
    const revision = ++saveRevisionRef.current.provider
    const validationError = validateProviderConfig(submittedConfig)
    if (validationError) throw new Error(validationError)
    const changedFields = getProviderConfigChanges(submittedConfig, submittedActiveConfig)
    const savedConfig = cloneAiConfig(await aiHttpApi.saveAiConfig(buildProviderConfigSavePayload(submittedConfig, submittedActiveConfig)))
    if (!shouldApplySaveResponse(revision, appliedSaveRevisionRef.current.provider)) {
      return { savedConfig, changedFields, applied: false }
    }
    appliedSaveRevisionRef.current.provider = revision
    setConfig((current) => cloneAiConfig(mergeSavedFields({
      current,
      submitted: submittedConfig,
      saved: savedConfig,
      fields: ['provider', 'baseUrl', 'model', 'systemPrompt', 'vision']
    })))
    setActiveConfig(savedConfig)
    return { savedConfig, changedFields, applied: true }
  }

  const saveApiKeyDraft = async () => {
    const key = apiKeyDraft.trim()
    if (!key) {
      if (apiKeyDraft) throw new Error('API Key 不能为空')
      return null
    }
    const result = await aiHttpApi.saveAiApiKey(key)
    setConfig((current) => ({ ...current, apiKeyRef: result.apiKeyRef, hasApiKey: result.hasApiKey }))
    setActiveConfig((current) => ({ ...current, apiKeyRef: result.apiKeyRef, hasApiKey: result.hasApiKey }))
    setApiKeyDraft('')
    return result
  }

  const hasUnsavedConfigChanges = hasProviderConfigChanges(config, activeConfig)
  const hasUnsavedApiKeyDraft = Boolean(apiKeyDraft.trim())
  const hasUnsavedVisionApiKeyDraft = Boolean(visionApiKeyDraft.trim())
  const hasUnsavedImageGenerationChanges = hasImageGenerationConfigChanges(imageGenerationConfig, activeImageGenerationConfig)
  const hasUnsavedImageApiKeyDraft = Boolean(imageApiKeyDraft.trim())
  const hatchPetAgentConfigDirty = JSON.stringify(buildHatchPetAgentConfigSaveRequest(hatchPetAgentConfig)) !==
    JSON.stringify(buildHatchPetAgentConfigSaveRequest(activeHatchPetAgentConfig))

  const onSave = async () => {
    setSaving(true)
    setStatus('')
    setConnectionStatus('保存聊天 Provider 中')
    try {
      const { changedFields, applied } = await saveProviderConfigDraft()
      if (!applied) return
      await loadPetChatState()
      setConnectionTestResult(null)
      setChatModelDiscovery(null)
      setChatModelDiscoveryStatus('')
      setVisionModelDiscovery(null)
      setVisionModelDiscoveryStatus('')
      setConnectionStatus(changedFields.length ? `AI 配置已保存：${changedFields.join(' / ')}` : 'AI 配置已保存')
    } catch (error) {
      setConnectionStatus(messageFromError(error, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSaveHatchPetAgentConfig = async () => {
    setSaving(true)
    setHatchPetAgentStatus('保存 Hatch Pet Agent 配置中')
    try {
      if (hatchPetAgentConfig.configMode === 'override') {
        if (!hatchPetAgentConfig.provider.trim()) throw new Error('Hatch Pet Agent Provider 不能为空')
        if (!hatchPetAgentConfig.model.trim()) throw new Error('Hatch Pet Agent Model 不能为空')
        const parsedBaseUrl = new URL(hatchPetAgentConfig.baseUrl)
        if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
          throw new Error('Hatch Pet Agent Base URL 必须使用 HTTP 或 HTTPS')
        }
      }
      const saved = cloneHatchPetAgentConfig(await aiHttpApi.saveHatchPetAgentConfig(
        buildHatchPetAgentConfigSaveRequest(hatchPetAgentConfig)
      ))
      setHatchPetAgentConfig(saved)
      setActiveHatchPetAgentConfig(saved)
      setHatchPetAgentCapabilityResult(null)
      setHatchPetAgentStatus('Hatch Pet Agent 配置已保存')
    } catch (error) {
      setHatchPetAgentStatus(messageFromError(error, 'Hatch Pet Agent 配置保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSaveHatchPetAgentApiKey = async () => {
    const apiKey = hatchPetAgentApiKeyDraft.trim()
    if (!apiKey) {
      setHatchPetAgentStatus('Hatch Pet Agent API Key 不能为空')
      return
    }
    setSaving(true)
    setHatchPetAgentStatus('保存 Hatch Pet Agent API Key 中')
    try {
      const result = await aiHttpApi.saveHatchPetAgentApiKey(apiKey)
      setHatchPetAgentApiKeyDraft('')
      await loadHatchPetAgentConfig({ preserveDraft: true })
      setHatchPetAgentConfig((current) => current.configMode === 'override'
        ? cloneHatchPetAgentConfig({ ...current, hasApiKey: result.hasApiKey })
        : current)
      setHatchPetAgentCapabilityResult(null)
      setHatchPetAgentStatus('Hatch Pet Agent API Key 已保存')
    } catch (error) {
      setHatchPetAgentStatus(messageFromError(error, 'Hatch Pet Agent API Key 保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onClearHatchPetAgentApiKey = async () => {
    setSaving(true)
    setHatchPetAgentStatus('清除 Hatch Pet Agent API Key 中')
    try {
      const result = await aiHttpApi.clearHatchPetAgentApiKey()
      setHatchPetAgentApiKeyDraft('')
      await loadHatchPetAgentConfig({ preserveDraft: true })
      setHatchPetAgentConfig((current) => current.configMode === 'override'
        ? cloneHatchPetAgentConfig({ ...current, hasApiKey: result.hasApiKey })
        : current)
      setHatchPetAgentCapabilityResult(null)
      setHatchPetAgentStatus('Hatch Pet Agent API Key 已清除')
    } catch (error) {
      setHatchPetAgentStatus(messageFromError(error, 'Hatch Pet Agent API Key 清除失败'))
    } finally {
      setSaving(false)
    }
  }

  const onCheckHatchPetAgentCapability = async () => {
    if (hatchPetAgentConfigDirty || hatchPetAgentApiKeyDraft.trim()) {
      setHatchPetAgentCapabilityResult(null)
      setHatchPetAgentStatus('请先保存 Hatch Pet Agent 配置和密钥草稿，再检查 capability。')
      return
    }
    setSaving(true)
    setHatchPetAgentStatus('检查 Hatch Pet Agent capability 中')
    setHatchPetAgentCapabilityResult(null)
    try {
      const result = await api.checkHatchPetAgentCapability()
      setHatchPetAgentCapabilityResult(result)
      setHatchPetAgentStatus(result.message || (result.ok ? 'Capability supported' : 'Capability unsupported'))
    } catch (error) {
      setHatchPetAgentStatus(messageFromError(error, 'Hatch Pet Agent capability 检查失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSaveImageGeneration = async () => {
    setSaving(true)
    setImageStatus('')
    setImageHealthStatus('')
    setImageHealthResult(null)
    try {
      const submittedConfig = cloneImageGenerationConfig(imageGenerationConfig)
      const submittedActiveConfig = cloneImageGenerationConfig(activeImageGenerationConfig)
      const revision = ++saveRevisionRef.current.image
      const validationError = validateImageProviderConfig(submittedConfig)
      if (validationError) throw new Error(validationError)
      const changedFields = getImageGenerationConfigChanges(submittedConfig, submittedActiveConfig)
      const savedConfig = cloneImageGenerationConfig(await api.saveImageGenerationConfig(
        buildImageGenerationConfigSavePayload(submittedConfig, submittedActiveConfig)
      ))
      if (!shouldApplySaveResponse(revision, appliedSaveRevisionRef.current.image)) return
      appliedSaveRevisionRef.current.image = revision
      setImageGenerationConfig((current) => cloneImageGenerationConfig(mergeSavedFields({
        current,
        submitted: submittedConfig,
        saved: savedConfig
      })))
      setActiveImageGenerationConfig(savedConfig)
      setImageModelDiscovery(null)
      setImageModelDiscoveryStatus('')
      setImageStatus(changedFields.length ? `图片 Provider 配置已保存：${changedFields.join(' / ')}` : '图片 Provider 配置已保存')
    } catch (error) {
      setImageStatus(messageFromError(error, '图片 Provider 配置保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSaveBehavior = async () => {
    setSaving(true)
    setBehaviorStatus('')
    try {
      const submittedRulesText = behaviorRulesText
      const parsedRules = parseBehaviorRules(submittedRulesText)
      const submittedBehavior = cloneAiBehavior({ ...behavior, rules: parsedRules })
      const revision = ++saveRevisionRef.current.behavior
      const savedBehavior = cloneAiBehavior(await aiHttpApi.saveAiBehavior(submittedBehavior))
      if (!shouldApplySaveResponse(revision, appliedSaveRevisionRef.current.behavior)) return
      appliedSaveRevisionRef.current.behavior = revision
      setBehavior((current) => cloneAiBehavior(mergeSavedFields({ current, submitted: submittedBehavior, saved: savedBehavior })))
      setBehaviorRulesText((current) => current === submittedRulesText ? JSON.stringify(savedBehavior.rules || [], null, 2) : current)
      setConfig((current) => ({
        ...current,
        behavior: cloneAiBehavior(mergeSavedFields({
          current: current.behavior,
          submitted: submittedBehavior,
          saved: savedBehavior
        }))
      }))
      setBehaviorStatus('Behavior 配置已保存')
    } catch (error) {
      setBehaviorStatus(messageFromError(error, 'Behavior 配置保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onDryRunBehavior = async () => {
    const reply = dryRunText.trim()
    if (!reply) return
    setBehaviorStatus('')
    try {
      const parsedRules = parseBehaviorRules(behaviorRulesText)
      const result = await aiHttpApi.dryRunAiBehavior({ reply, behavior: { ...behavior, rules: parsedRules } })
      setDryRunResult(result)
      setBehaviorStatus(result.matched ? `Dry run 命中：${result.reason}` : `Dry run 未命中：${result.reason}`)
    } catch (error) {
      setDryRunResult(null)
      setBehaviorStatus(messageFromError(error, 'Dry run 失败'))
    }
  }

  const onReplayBehaviorDecision = async () => {
    const decisionId = Number(replayDraft.trim())
    if (!Number.isFinite(decisionId) || decisionId <= 0) {
      setBehaviorStatus('请输入有效的决策 ID')
      return
    }
    setBehaviorStatus('')
    try {
      const result = await aiHttpApi.replayAiBehaviorDecision(decisionId)
      setReplayResult(result)
      setBehaviorStatus(result.matched ? `Replay 命中：${result.reason}` : `Replay 未命中：${result.reason}`)
    } catch (error) {
      setReplayResult(null)
      setBehaviorStatus(messageFromError(error, 'Replay 失败'))
    }
  }

  const onExportBehaviorDiagnostics = async () => {
    setBehaviorStatus('')
    try {
      const content = await aiHttpApi.exportAiBehaviorDiagnostics()
      downloadTextFile('openpet-ai-behavior-diagnostics.json', content, 'application/json;charset=utf-8')
      setBehaviorStatus('Behavior 诊断已导出')
    } catch (error) {
      setBehaviorStatus(messageFromError(error, 'Behavior 诊断导出失败'))
    }
  }

  const onClearBehaviorDecisions = async () => {
    if (!window.confirm('清空 AI 行为决策记录？')) return
    setBehaviorStatus('')
    try {
      await aiHttpApi.clearAiBehaviorDecisions()
      await loadBehavior()
      setReplayResult(null)
      setDryRunResult(null)
      setBehaviorStatus('Behavior 决策已清空')
    } catch (error) {
      setBehaviorStatus(messageFromError(error, '清空失败'))
    }
  }

  const onSaveApiKey = async () => {
    setSaving(true)
    setStatus('')
    setConnectionStatus('保存 API Key 中')
    try {
      const result = await saveApiKeyDraft()
      if (!result) {
        setConnectionStatus('API Key 未修改')
      } else {
        await loadPetChatState()
        setConnectionTestResult(null)
        setChatModelDiscovery(null)
        setChatModelDiscoveryStatus('')
        setVisionModelDiscovery(null)
        setVisionModelDiscoveryStatus('')
        setConnectionStatus(result.updatedAt ? `API Key 已保存 · ${new Date(result.updatedAt).toLocaleString()}` : 'API Key 已保存')
      }
    } catch (error) {
      setConnectionStatus(messageFromError(error, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSaveImageGenerationApiKey = async () => {
    setSaving(true)
    setImageStatus('')
    setImageHealthStatus('')
    setImageHealthResult(null)
    try {
      const key = imageApiKeyDraft.trim()
      if (!key) throw new Error('图片 API Key 不能为空')
      const result = await api.saveImageGenerationApiKey(key)
      const applyKeyResult = (current: ImageGenerationConfigViewState) => cloneImageGenerationConfig({
        ...current,
        hasApiKey: result.hasApiKey,
        apiKeyPreview: result.apiKeyPreview
      })
      setImageGenerationConfig(applyKeyResult)
      setActiveImageGenerationConfig(applyKeyResult)
      setImageApiKeyDraft('')
      setImageModelDiscovery(null)
      setImageModelDiscoveryStatus('')
      setImageStatus('图片 API Key 已保存')
    } catch (error) {
      setImageStatus(messageFromError(error, '图片 API Key 保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSaveVisionApiKey = async () => {
    setSaving(true)
    setVisionStatus('保存 Vision API Key 中')
    try {
      const key = visionApiKeyDraft.trim()
      if (!key) throw new Error('Vision API Key 不能为空')
      const result = await aiHttpApi.saveAiVisionApiKey(key)
      const applyResult = (current: AiConfigViewState) => cloneAiConfig({
        ...current,
        vision: {
          ...current.vision,
          apiKeyRef: result.apiKeyRef,
          hasApiKey: result.hasApiKey,
          effectiveHasApiKey: current.vision.mode === 'override' ? result.hasApiKey : current.vision.effectiveHasApiKey
        }
      })
      setConfig(applyResult)
      setActiveConfig(applyResult)
      setVisionApiKeyDraft('')
      setVisionModelDiscovery(null)
      setVisionModelDiscoveryStatus('')
      setVisionStatus(result.updatedAt ? `Vision API Key 已保存 · ${new Date(result.updatedAt).toLocaleString()}` : 'Vision API Key 已保存')
    } catch (error) {
      setVisionStatus(messageFromError(error, 'Vision API Key 保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onClearVisionApiKey = async () => {
    setSaving(true)
    setVisionStatus('清除 Vision API Key 中')
    try {
      const result = await aiHttpApi.clearAiVisionApiKey()
      const applyResult = (current: AiConfigViewState) => cloneAiConfig({
        ...current,
        vision: {
          ...current.vision,
          apiKeyRef: result.apiKeyRef,
          hasApiKey: result.hasApiKey,
          effectiveHasApiKey: current.vision.mode === 'override' ? result.hasApiKey : current.vision.effectiveHasApiKey
        }
      })
      setConfig(applyResult)
      setActiveConfig(applyResult)
      setVisionApiKeyDraft('')
      setVisionModelDiscovery(null)
      setVisionModelDiscoveryStatus('')
      setVisionStatus('Vision API Key 已清除')
    } catch (error) {
      setVisionStatus(messageFromError(error, 'Vision API Key 清除失败'))
    } finally {
      setSaving(false)
    }
  }

  const onClearImageGenerationApiKey = async () => {
    setSaving(true)
    setImageStatus('')
    setImageHealthStatus('')
    setImageHealthResult(null)
    try {
      const result = await api.clearImageGenerationApiKey()
      const applyKeyResult = (current: ImageGenerationConfigViewState) => cloneImageGenerationConfig({
        ...current,
        hasApiKey: result.hasApiKey,
        apiKeyPreview: result.apiKeyPreview
      })
      setImageGenerationConfig(applyKeyResult)
      setActiveImageGenerationConfig(applyKeyResult)
      setImageApiKeyDraft('')
      setImageModelDiscovery(null)
      setImageModelDiscoveryStatus('')
      setImageStatus('图片 API Key 已清除')
    } catch (error) {
      setImageStatus(messageFromError(error, '图片 API Key 清除失败'))
    } finally {
      setSaving(false)
    }
  }

  const onCheckImageGenerationHealth = async () => {
    if (hasUnsavedImageGenerationChanges) {
      setImageHealthStatus('当前图片 Provider 配置有未保存修改；请先保存图片配置后再检查健康。')
      setImageHealthResult(null)
      return
    }
    if (hasUnsavedImageApiKeyDraft) {
      setImageHealthStatus('当前图片 API Key 草稿未保存；请先保存图片密钥后再检查健康。')
      setImageHealthResult(null)
      return
    }
    setSaving(true)
    setImageHealthStatus('图片 Provider 健康检查中')
    setImageHealthResult(null)
    try {
      const result = await api.checkImageGenerationHealth({})
      const nextActiveImageConfig = result.modelsProbe === 'ok'
        ? await loadImageGenerationConfig({ preserveDraft: true })
        : activeImageGenerationConfig
      setImageHealthResult(result)
      const discovery = createImageModelDiscoveryFromHealth(result, nextActiveImageConfig)
      setImageModelDiscovery(discovery)
      setImageModelDiscoveryStatus(`${formatModelDiscoveryStatus('图片 Provider', discovery)} ${formatProviderModelCatalogMeta(nextActiveImageConfig.modelCatalog)}`.trim())
      setImageHealthStatus(formatImageGenerationHealthStatus(result))
    } catch (error) {
      setImageHealthResult(null)
      setImageModelDiscovery(null)
      setImageModelDiscoveryStatus('')
      setImageHealthStatus(messageFromError(error, '图片模型健康检查失败'))
    } finally {
      setSaving(false)
    }
  }

  const onDiscoverAiModels = async () => {
    if (hasUnsavedConfigChanges || hasUnsavedApiKeyDraft) {
      setChatModelDiscoveryStatus('当前聊天 Provider 配置有未保存修改；请先保存聊天配置和密钥后再刷新模型。')
      return
    }
    setSaving(true)
    setChatModelDiscoveryStatus('聊天模型探测中')
    try {
      const result = await aiHttpApi.discoverAiModels()
      const nextActiveConfig = result.ok && result.code === 'ok'
        ? await loadAiConfig({ preserveDraft: true })
        : activeConfig
      setChatModelDiscovery(result)
      setChatModelDiscoveryStatus(`${formatModelDiscoveryStatus('聊天 Provider', result)} ${formatProviderModelCatalogMeta(nextActiveConfig.modelCatalog)}`.trim())
    } catch (error) {
      setChatModelDiscovery(null)
      setChatModelDiscoveryStatus(messageFromError(error, '聊天模型探测失败'))
    } finally {
      setSaving(false)
    }
  }

  const onDiscoverVisionModels = async () => {
    if (config.vision.mode !== 'override') {
      setVisionModelDiscoveryStatus('当前 Vision 跟随聊天模型；无需单独刷新模型列表。')
      return
    }
    if (hasUnsavedConfigChanges || hasUnsavedVisionApiKeyDraft) {
      setVisionModelDiscoveryStatus('当前 Vision Provider 配置有未保存修改；请先保存聊天 Provider 和 Vision 密钥后再刷新模型。')
      return
    }
    setSaving(true)
    setVisionModelDiscoveryStatus('Vision 模型探测中')
    try {
      const result = await aiHttpApi.discoverAiVisionModels()
      const nextActiveConfig = result.ok && result.code === 'ok'
        ? await loadAiConfig({ preserveDraft: true })
        : activeConfig
      setVisionModelDiscovery(result)
      setVisionModelDiscoveryStatus(`${formatModelDiscoveryStatus('Vision Provider', result)} ${formatProviderModelCatalogMeta(nextActiveConfig.vision.modelCatalog)}`.trim())
    } catch (error) {
      setVisionModelDiscovery(null)
      setVisionModelDiscoveryStatus(messageFromError(error, 'Vision 模型探测失败'))
    } finally {
      setSaving(false)
    }
  }

  const onDiscoverImageGenerationModels = async () => {
    if (hasUnsavedImageGenerationChanges || imageApiKeyDraft.trim()) {
      setImageModelDiscoveryStatus('当前图片 Provider 配置有未保存修改；请先保存图片配置和密钥后再刷新模型。')
      return
    }
    setSaving(true)
    setImageModelDiscoveryStatus('图片模型探测中')
    try {
      const result = await api.discoverImageGenerationModels()
      const nextActiveImageConfig = result.ok && result.code === 'ok'
        ? await loadImageGenerationConfig({ preserveDraft: true })
        : activeImageGenerationConfig
      setImageModelDiscovery(result)
      setImageModelDiscoveryStatus(`${formatModelDiscoveryStatus('图片 Provider', result)} ${formatProviderModelCatalogMeta(nextActiveImageConfig.modelCatalog)}`.trim())
    } catch (error) {
      setImageModelDiscovery(null)
      setImageModelDiscoveryStatus(messageFromError(error, '图片模型探测失败'))
    } finally {
      setSaving(false)
    }
  }

  const onTest = async () => {
    setSaving(true)
    setConnectionStatus('测试中')
    setConnectionTestResult(null)
    try {
      const result = await aiHttpApi.testAiConnection()
      const nextActiveConfig = result.modelsProbe === 'ok'
        ? await loadAiConfig({ preserveDraft: true })
        : activeConfig
      setConnectionTestResult(result)
      const discovery = createChatModelDiscoveryFromConnectionTest(result)
      setChatModelDiscovery(discovery)
      setChatModelDiscoveryStatus(`${formatModelDiscoveryStatus('聊天 Provider', discovery)} ${formatProviderModelCatalogMeta(nextActiveConfig.modelCatalog)}`.trim())
      setConnectionStatus(formatConnectionStatus({
        result,
        hasUnsavedConfigChanges,
        hasUnsavedApiKeyDraft
      }))
    } catch (error) {
      setConnectionTestResult(null)
      setConnectionStatus(messageFromError(error, '连接失败'))
    } finally {
      setSaving(false)
    }
  }

  const onChangePersonaDraft = (partial: Partial<typeof personaDraft>) => {
    setPersonaDraft((current) => ({ ...current, ...partial }))
  }

  const onResetPersonaOverride = async () => {
    setSaving(true)
    setStatus('')
    try {
      const profile = cloneAiPersonaProfile(await aiHttpApi.saveAiPersonaOverride({}))
      setPersonaProfile(profile)
      setPersonaDraft(personaToDraft(profile.overridePersona))
      setGeneratedPersonaDraft(null)
      setStatus('宠物人格 override 已清空')
    } catch (error) {
      setStatus(messageFromError(error, '宠物人格重置失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSavePersonaOverride = async () => {
    setSaving(true)
    setStatus('')
    try {
      const profile = cloneAiPersonaProfile(await aiHttpApi.saveAiPersonaOverride(buildPersonaOverrideFromDraft(personaDraft)))
      setPersonaProfile(profile)
      setPersonaDraft(personaToDraft(profile.overridePersona))
      setGeneratedPersonaDraft(null)
      setStatus('宠物人格 override 已保存')
    } catch (error) {
      setStatus(messageFromError(error, '宠物人格保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const onGeneratePersonaDraft = async () => {
    setSaving(true)
    setStatus('')
    try {
      const draft = await aiHttpApi.generateAiPersonaDraft({ instruction: personaGenerationInstruction })
      setGeneratedPersonaDraft(draft)
      setStatus('宠物人格草稿已生成，确认后才会写入本地 override')
    } catch (error) {
      setGeneratedPersonaDraft(null)
      setStatus(messageFromError(error, '宠物人格生成失败'))
    } finally {
      setSaving(false)
    }
  }

  const onApplyGeneratedPersonaDraft = async () => {
    if (!generatedPersonaDraft) return
    if (generatedPersonaDraft.petPackId !== personaProfile.petPackId) {
      setGeneratedPersonaDraft(null)
      setStatus('人格草稿已过期，请为当前宠物包重新生成')
      return
    }
    setSaving(true)
    setStatus('')
    try {
      const profile = cloneAiPersonaProfile(await aiHttpApi.saveAiPersonaOverride(generatedPersonaDraft.draftPersona))
      setPersonaProfile(profile)
      setPersonaDraft(personaToDraft(profile.overridePersona))
      setGeneratedPersonaDraft(null)
      setStatus('宠物人格草稿已应用')
    } catch (error) {
      setStatus(messageFromError(error, '应用人格草稿失败'))
    } finally {
      setSaving(false)
    }
  }

  const onRefreshMemoryProfile = async () => {
    setStatus('长期记忆刷新中')
    try {
      await loadMemoryProfile()
      setStatus('长期记忆已刷新')
    } catch (error) {
      setStatus(messageFromError(error, '长期记忆刷新失败'))
    }
  }

  const onDeleteMemory = async (memoryId: string) => {
    if (!memoryId) return
    setSaving(true)
    setStatus('删除长期记忆中')
    try {
      const profile = cloneAiMemoryProfile(await aiHttpApi.deleteAiMemory(memoryId))
      setMemoryProfile(profile)
      setStatus('长期记忆已删除')
    } catch (error) {
      setStatus(messageFromError(error, '长期记忆删除失败'))
    } finally {
      setSaving(false)
    }
  }

  const onClearPetPackMemories = async () => {
    if (!window.confirm(`清空 ${memoryProfile.petPackDisplayName} 的宠物关系记忆？全局用户记忆不会被清空。`)) return
    setSaving(true)
    setStatus('清空当前宠物关系记忆中')
    try {
      const profile = cloneAiMemoryProfile(await aiHttpApi.clearAiPetPackMemories())
      setMemoryProfile(profile)
      setStatus('当前宠物关系记忆已清空')
    } catch (error) {
      setStatus(messageFromError(error, '清空宠物关系记忆失败'))
    } finally {
      setSaving(false)
    }
  }

  const onSendChat = async () => {
    const message = chatDraft.trim()
    if (!message || chatting) return
    if (!petChatState.ai.ready) {
      setChatStatus(petChatState.ai.reason || '请先配置 AI Provider')
      return
    }
    const nextMessages: ChatMessage[] = [...chatMessages, { role: 'user', content: message }]
    setChatMessages(nextMessages)
    setPetChatState((current) => clonePetChatState({ ...current, messages: nextMessages }))
    setChatDraft('')
    setChatting(true)
    setChatStatus('')
    try {
      const result = await aiHttpApi.sendPetChatMessage({ message, entrypoint: 'control-center' })
      const fallbackMessages: ChatMessage[] = Array.isArray(result.messages)
        ? cloneChatMessages(result.messages)
        : [...nextMessages, { role: 'assistant', content: result.reply }]
      const nextState = result.state
        ? clonePetChatState(result.state)
        : clonePetChatState({ ...petChatState, messages: fallbackMessages, bubble: result.bubble })
      setPetChatState(nextState)
      setChatMessages(nextState.messages.length
        ? nextState.messages
        : fallbackMessages)
      if (result.action?.actionId) {
        setChatStatus(result.action.error
          ? `动作触发失败：${result.action.error}`
          : `已触发动作：${result.action.label || result.action.actionId}`)
      }
      await loadBehavior()
      void loadMemoryProfile().catch(() => {})
      void loadAiTalkTraceSummary(
        result.conversationId || getMainConversationId(nextState.petPack.id)
      ).catch(() => {})
    } catch (error) {
      setChatStatus(messageFromError(error, '发送失败'))
    } finally {
      setChatting(false)
    }
  }

  const onOpenDesktopChat = async () => {
    try {
      const nextState = clonePetChatState(await api.openPetChatWindow())
      setPetChatState(nextState)
      setChatStatus('已打开扩展聊天面板')
    } catch (error) {
      setChatStatus(messageFromError(error, '打开扩展聊天面板失败'))
    }
  }

  const onOpenBubbleChat = async () => {
    try {
      const bubbleChatState = await api.openPetBubbleChat()
      setPetChatState((current) => clonePetChatState({
        ...current,
        bubbleChat: {
          ...current.bubbleChat,
          ...bubbleChatState
        }
      }))
      setChatStatus('已打开默认气泡聊天')
    } catch (error) {
      setChatStatus(messageFromError(error, '打开默认气泡聊天失败'))
    }
  }

  const onExportAiTalkTraceDiagnostics = async () => {
    setStatus('')
    try {
      const content = await aiHttpApi.exportAiTalkTraceDiagnostics({
        petPackId: String(traceDiagnosticsFilters.petPackId || '').trim(),
        conversationId: String(traceDiagnosticsFilters.conversationId || '').trim()
      })
      downloadTextFile('openpet-ai-talk-trace-diagnostics.json', content, 'application/json;charset=utf-8')
      setStatus('AI Talk Trace 已导出')
    } catch (error) {
      setStatus(messageFromError(error, 'AI Talk Trace 导出失败'))
    }
  }

  const paneProps = {
    config,
    activeConfig,
    imageGenerationConfig,
    activeImageGenerationConfig,
    hatchPetAgentConfig,
    activeHatchPetAgentConfig,
    hatchPetAgentConfigDirty,
    hatchPetAgentApiKeyDraft,
    hatchPetAgentStatus,
    hatchPetAgentCapabilityResult,
    personaProfile,
    memoryProfile,
    personaDraft,
    providerConfigDirty: hasProviderConfigChanges(config, activeConfig),
    providerConfigChanges: getProviderConfigChanges(config, activeConfig),
    providerConfigValidationError: validateProviderConfig(config),
    connectionTestResult,
    chatModelDiscovery,
    chatModelDiscoveryStatus,
    visionModelDiscovery,
    visionModelDiscoveryStatus,
    imageProviderValidationError: validateImageProviderConfig(imageGenerationConfig),
    imageModelDiscovery,
    imageModelDiscoveryStatus,
    imageTransparencyCompatibilityHint: getImageTransparencyCompatibilityHint(imageGenerationConfig.model),
    saving,
    status,
    connectionStatus,
    visionStatus,
    imageStatus,
    imageHealthStatus,
    imageHealthResult,
    chatStatus,
    hasUnsavedConfigChanges,
    hasUnsavedApiKeyDraft,
    hasUnsavedVisionApiKeyDraft,
    hasUnsavedImageGenerationChanges,
    hasUnsavedImageApiKeyDraft,
    apiKeyDraft,
    setApiKeyDraft,
    visionApiKeyDraft,
    setVisionApiKeyDraft,
    imageApiKeyDraft,
    setImageApiKeyDraft,
    setHatchPetAgentApiKeyDraft,
    onChangePersonaDraft,
    personaGenerationInstruction,
    setPersonaGenerationInstruction,
    generatedPersonaDraft,
    chatDraft,
    setChatDraft,
    chatMessages,
    petChatState,
    traceSummary: traceSummary ? cloneAiTalkTraceSummary(traceSummary) : null,
    chatting,
    behavior,
    behaviorRulesText,
    dryRunText,
    dryRunResult,
    replayDraft,
    replayResult,
    behaviorStatus,
    traceDiagnosticsFilters,
    setDryRunText,
    setReplayDraft,
    setBehaviorRulesText,
    onChangeBehavior: (partial: Partial<AiBehaviorConfig>) => setBehavior((current) => ({ ...current, ...partial })),
    onChange: (partial: Partial<AiConfigViewState>) => setConfig((current) => ({ ...current, ...partial })),
    onChangeVision: (partial: Partial<VisionConfigViewState>) => setConfig((current) => {
      const shouldHydrateFromChat = partial.mode === 'override' && current.vision.mode !== 'override'
      const baseVision = shouldHydrateFromChat
        ? {
            ...current.vision,
            provider: current.provider,
            baseUrl: current.baseUrl,
            model: current.model
          }
        : current.vision
      return cloneAiConfig({
        ...current,
        vision: {
          ...baseVision,
          ...partial
        }
      })
    }),
    onChangeImageGeneration: (partial: Partial<ImageGenerationConfigViewState>) => setImageGenerationConfig((current) => cloneImageGenerationConfig({
      ...current,
      ...partial
    })),
    onChangeHatchPetAgent: (partial: Partial<HatchPetAgentConfigView>) => setHatchPetAgentConfig((current) => cloneHatchPetAgentConfig({
      ...current,
      ...partial,
      ...(partial.configMode === 'override' && current.configMode !== 'override'
        ? { hasApiKey: activeHatchPetAgentConfig.configMode === 'override' && activeHatchPetAgentConfig.hasApiKey }
        : {}),
      budgets: {
        ...current.budgets,
        ...(partial.budgets || {})
      }
    })),
    onSave,
    onSaveHatchPetAgentConfig,
    onSaveHatchPetAgentApiKey,
    onClearHatchPetAgentApiKey,
    onCheckHatchPetAgentCapability,
    onSaveImageGeneration,
    onSavePersonaOverride,
    onResetPersonaOverride,
    onGeneratePersonaDraft,
    onApplyGeneratedPersonaDraft,
    onDismissGeneratedPersonaDraft: () => setGeneratedPersonaDraft(null),
    onSaveBehavior,
    onSaveApiKey,
    onSaveVisionApiKey,
    onClearVisionApiKey,
    onSaveImageGenerationApiKey,
    onClearImageGenerationApiKey,
    onCheckImageGenerationHealth,
    onDiscoverAiModels,
    onDiscoverVisionModels,
    onDiscoverImageGenerationModels,
    onTest,
    onDryRunBehavior,
    onReplayBehaviorDecision,
    onChangeTraceDiagnosticsFilters: (partial: AiTalkTraceDiagnosticsFilters) => setTraceDiagnosticsFilters({
      petPackId: String(partial.petPackId || '').trim(),
      conversationId: String(partial.conversationId || '').trim()
    }),
    onExportBehaviorDiagnostics,
    onExportAiTalkTraceDiagnostics,
    onClearBehaviorDecisions,
    onRefreshMemoryProfile,
    onDeleteMemory,
    onClearPetPackMemories,
    onSendChat,
    onOpenBubbleChat,
    onOpenDesktopChat
  } satisfies AiPaneProps

  return { loading, paneProps }
}
