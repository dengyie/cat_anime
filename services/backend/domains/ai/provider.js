import { createRequire } from "node:module"
const require = createRequire(import.meta.url)

const crypto = require('crypto')
const { sanitizeLogText } = require('../../../../src/main/services/log-safety.js')
const { readBoundedResponseBuffer } = require('../../../../src/main/services/bounded-response-body.js')
const { normalizeProviderResponseLimits } = require('../../../../src/main/services/provider-response-limits.js')
const {
  createSavedProviderModelCatalog,
  getScopedProviderModelCatalog,
  uniqueModelIds
} = require('../../../../src/main/services/provider-model-catalog.js')
const {
  assertProviderConfigPayload,
  createProviderOperationDetails,
  findOwnerFieldOverrides,
  getCapabilitySecretRef,
  sanitizeProviderBaseUrlForDisplay: sanitizeBaseUrlForDisplay,
  validateProviderConfigInput
} = require('../../../../src/main/services/provider-owner-policy.js')
const {
  DEFAULT_HATCH_PET_AGENT_CONFIG,
  createHatchPetAgentPublicConfig,
  normalizeHatchPetAgentConfig
} = require('../../../../src/main/services/hatch-pet-agent-contracts.js')

const DEFAULT_AI_CONFIG = {
  enabled: false,
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKeyRef: getCapabilitySecretRef('chat'),
  systemPrompt: 'You are a friendly desktop pet companion.',
  memory: {
    enabled: false
  },
  behavior: {
    enabled: false,
    useTools: true,
    cooldownMs: 1500,
    rules: [],
    decisions: []
  },
  vision: {
    mode: 'follow-chat',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyRef: getCapabilitySecretRef('vision')
  },
  hatchPet: DEFAULT_HATCH_PET_AGENT_CONFIG
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000
const DEFAULT_MAX_HISTORY_MESSAGES = 20
const DEFAULT_MAX_CONVERSATIONS = 20
const MAX_CONVERSATION_ID_CHARS = 160
const MAX_STORED_MESSAGE_CHARS = 8000
const MAX_USER_MESSAGE_CHARS = 4000
const BEHAVIOR_TOOL_NAME = 'openpet_behavior'
const LEGACY_BEHAVIOR_TOOL_NAME = 'ibot_behavior'
const DISPLAY_MODES = Object.freeze(['none', 'bubble', 'action', 'event'])

const HISTORY_ROLES = new Set(['user', 'assistant'])

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

const normalizeActionCandidates = (actions = []) => (
  (Array.isArray(actions) ? actions : [])
    .map((action) => {
      const id = typeof action?.id === 'string' ? action.id.trim() : ''
      if (!id) return null
      return {
        id,
        label: typeof action.label === 'string' && action.label.trim() ? action.label.trim() : id,
        kind: typeof action.kind === 'string' && action.kind.trim() ? action.kind.trim() : 'custom'
      }
    })
    .filter(Boolean)
    .slice(0, 80)
)

const normalizeBehaviorConfig = (behavior = {}) => ({
  ...DEFAULT_AI_CONFIG.behavior,
  ...(isPlainObject(behavior) ? behavior : {}),
  enabled: Boolean(behavior?.enabled),
  useTools: behavior?.useTools !== false,
  cooldownMs: Math.max(0, Number(behavior?.cooldownMs ?? DEFAULT_AI_CONFIG.behavior.cooldownMs) || 0),
  rules: Array.isArray(behavior?.rules) ? behavior.rules : [],
  decisions: Array.isArray(behavior?.decisions) ? behavior.decisions : []
})

const normalizeMemoryConfig = (memory = {}) => ({
  ...DEFAULT_AI_CONFIG.memory,
  ...(isPlainObject(memory) ? memory : {}),
  enabled: Boolean(memory?.enabled)
})

const normalizeVisionMode = (value) => (value === 'override' ? 'override' : 'follow-chat')

const normalizeVisionConfig = (vision = {}) => ({
  mode: normalizeVisionMode(vision?.mode),
  provider: vision?.provider || DEFAULT_AI_CONFIG.vision.provider,
  baseUrl: String(vision?.baseUrl || DEFAULT_AI_CONFIG.vision.baseUrl).replace(/\/+$/, ''),
  model: vision?.model || DEFAULT_AI_CONFIG.vision.model,
  apiKeyRef: getCapabilitySecretRef('vision')
})

const normalizeConfig = (config = {}) => ({
  provider: config.provider || DEFAULT_AI_CONFIG.provider,
  baseUrl: String(config.baseUrl || DEFAULT_AI_CONFIG.baseUrl).replace(/\/+$/, ''),
  model: config.model || DEFAULT_AI_CONFIG.model,
  apiKeyRef: getCapabilitySecretRef('chat'),
  systemPrompt: config.systemPrompt ?? DEFAULT_AI_CONFIG.systemPrompt,
  enabled: Boolean(config.enabled),
  memory: normalizeMemoryConfig(config.memory),
  behavior: normalizeBehaviorConfig(config.behavior),
  vision: normalizeVisionConfig(config.vision),
  hatchPet: normalizeHatchPetAgentConfig(config.hatchPet)
})

const normalizeCompletionConfig = (config = {}) => ({
  provider: config.provider || DEFAULT_AI_CONFIG.provider,
  baseUrl: String(config.baseUrl || DEFAULT_AI_CONFIG.baseUrl).replace(/\/+$/, ''),
  model: config.model || DEFAULT_AI_CONFIG.model,
  apiKeyRef: config.apiKeyRef || getCapabilitySecretRef('chat')
})

const parseBehaviorToolArguments = (value) => {
  if (!value || typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    if (!isPlainObject(parsed)) return null
    const intent = {
      intent: typeof parsed.intent === 'string' ? parsed.intent : '',
      actionId: typeof parsed.actionId === 'string' ? parsed.actionId : '',
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
      bubbleText: typeof parsed.bubbleText === 'string' ? parsed.bubbleText : ''
    }
    if (typeof parsed.reason === 'string') intent.reason = parsed.reason
    if (DISPLAY_MODES.includes(parsed.displayMode)) intent.displayMode = parsed.displayMode
    return intent
  } catch (_) {
    return null
  }
}

const parseBehaviorIntent = (message = {}) => {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const toolCall of toolCalls) {
    if (![BEHAVIOR_TOOL_NAME, LEGACY_BEHAVIOR_TOOL_NAME].includes(toolCall?.function?.name)) continue
    const intent = parseBehaviorToolArguments(toolCall.function.arguments)
    if (intent) return intent
  }
  return null
}

const parseChatResult = (data) => {
  const message = data?.choices?.[0]?.message || {}
  const behaviorIntent = parseBehaviorIntent(message)
  const reply = typeof message.content === 'string' ? message.content.trim() : ''
  const fallbackReply = behaviorIntent?.bubbleText?.trim() || ''
  if (!reply && !fallbackReply) {
    throw new Error('AI provider returned an empty response')
  }
  return {
    reply: reply || fallbackReply,
    behaviorIntent
  }
}

const parseNamedToolCall = (data, toolName) => {
  const message = data?.choices?.[0]?.message || {}
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const match = calls.find((call) => call?.function?.name === toolName)
  if (!match) throw new Error(`AI provider did not return required tool call: ${toolName}`)
  try {
    const parsed = JSON.parse(String(match.function.arguments || ''))
    if (!isPlainObject(parsed)) throw new Error('arguments must be an object')
    return parsed
  } catch (_) {
    throw new Error(`AI provider returned invalid tool arguments for ${toolName}`)
  }
}

const getBehaviorToolDefinition = ({ actions = [] } = {}) => {
  const candidates = normalizeActionCandidates(actions)
  const actionDescription = candidates.length
    ? `Optional action id. Choose only from the current pet actions: ${candidates.map((action) => `${action.id}: ${action.label} (${action.kind})`).join('; ')}. Leave empty when no action fits.`
    : 'Optional action id. Leave empty unless the current pet has a matching action.'
  return {
    type: 'function',
    function: {
      name: BEHAVIOR_TOOL_NAME,
      description: 'Choose a safe OpenPet behavior for this assistant reply.',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'Short behavior intent, such as greet, celebrate, rest, or focus.' },
          actionId: {
            type: 'string',
            description: actionDescription,
            ...(candidates.length ? { enum: candidates.map((action) => action.id) } : {})
          },
          confidence: { type: 'number', description: 'Confidence from 0 to 1 that this behavior fits the reply.' },
          bubbleText: { type: 'string', description: 'Short pet bubble line. Keep it concise and user-facing.' },
          reason: { type: 'string', description: 'Short non-secret reason for the selected behavior.' },
          displayMode: {
            type: 'string',
            enum: DISPLAY_MODES,
            description: 'How OpenPet should present the behavior: none, bubble, action, or event.'
          }
        },
        required: ['intent', 'confidence']
      }
    }
  }
}

const trimHistory = (messages, maxHistoryMessages) => {
  if (messages.length <= maxHistoryMessages) return messages
  return messages.slice(messages.length - maxHistoryMessages)
}

const normalizeConversationId = (conversationId) => {
  if (typeof conversationId !== 'string') return ''
  return conversationId.trim()
}

const assertValidConversationId = (conversationId) => {
  if (conversationId.length > MAX_CONVERSATION_ID_CHARS) {
    throw new Error('AI conversation id is too long')
  }
  return conversationId
}

const normalizeStoredConversationId = (conversationId) => {
  const normalizedId = normalizeConversationId(conversationId)
  return normalizedId.length <= MAX_CONVERSATION_ID_CHARS ? normalizedId : ''
}

const normalizeHistoryMessage = (message) => {
  if (!isPlainObject(message) || !HISTORY_ROLES.has(message.role)) return null
  if (typeof message.content !== 'string') return null
  const content = message.content.trim().slice(0, MAX_STORED_MESSAGE_CHARS)
  if (!content) return null
  return { role: message.role, content }
}

const normalizeHistory = (messages, maxHistoryMessages) => {
  if (!Array.isArray(messages)) return []
  return trimHistory(messages.map(normalizeHistoryMessage).filter(Boolean), maxHistoryMessages)
}

const cloneHistory = (messages, maxHistoryMessages) => normalizeHistory(messages, maxHistoryMessages)

const normalizeConversationStore = (store, maxHistoryMessages) => {
  if (!isPlainObject(store)) return {}
  return Object.fromEntries(
    Object.entries(store)
      .map(([conversationId, messages]) => [normalizeStoredConversationId(conversationId), normalizeHistory(messages, maxHistoryMessages)])
      .filter(([conversationId, messages]) => conversationId && messages.length)
  )
}

const createTimeoutController = (timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  }
}

const createTimeoutError = () => {
  const error = new Error('AI provider request timed out')
  error.name = 'TimeoutError'
  return error
}

const mergeHatchPetConfigWithoutDisplayDowngrade = (currentConfig = {}, partialConfig = {}) => {
  const current = isPlainObject(currentConfig) ? currentConfig : {}
  const partial = isPlainObject(partialConfig) ? partialConfig : {}
  const next = { ...current, ...partial }
  const currentBaseUrl = typeof current.baseUrl === 'string' ? current.baseUrl : ''
  const nextBaseUrl = typeof partial.baseUrl === 'string' ? partial.baseUrl : ''
  if (
    currentBaseUrl &&
    nextBaseUrl &&
    sanitizeBaseUrlForDisplay(currentBaseUrl) === nextBaseUrl &&
    currentBaseUrl !== nextBaseUrl
  ) {
    next.baseUrl = currentBaseUrl
  }
  return next
}

const normalizeEndpointForLog = (baseUrl) => {
  try {
    const url = new URL(String(baseUrl || ''))
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/chat/completions`
  } catch (_) {
    return 'invalid-ai-base-url'
  }
}

const sanitizeDiagnosticText = (value) => sanitizeLogText(value, { maxChars: 240 })

const resolveRuntimeProviderConfig = (config, label = 'AI') => {
  const normalized = normalizeCompletionConfig(config)
  return {
    ...normalized,
    ...validateProviderConfigInput({
      provider: normalized.provider,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      label
    })
  }
}

const buildEffectiveVisionConfig = ({ config, secretService, storedState }) => {
  const normalizedVision = normalizeVisionConfig(config?.vision)
  if (normalizedVision.mode !== 'override') {
    const chatApiKey = secretService.getSecretValue(config.apiKeyRef)
    return {
      ...normalizedVision,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyRef: config.apiKeyRef,
      hasApiKey: Boolean(chatApiKey),
      modelCatalog: getScopedProviderModelCatalog({
        capability: 'chat',
        provider: config.provider,
        baseUrl: config.baseUrl,
        catalog: storedState?.modelCatalog,
        secrets: [chatApiKey]
      }),
      effectiveProvider: config.provider,
      effectiveBaseUrl: sanitizeBaseUrlForDisplay(config.baseUrl),
      effectiveModel: config.model,
      effectiveHasApiKey: Boolean(chatApiKey)
    }
  }
  const visionApiKey = secretService.getSecretValue(normalizedVision.apiKeyRef)
  return {
    ...normalizedVision,
    hasApiKey: Boolean(visionApiKey),
    modelCatalog: getScopedProviderModelCatalog({
      capability: 'vision',
      provider: normalizedVision.provider,
      baseUrl: normalizedVision.baseUrl,
      catalog: storedState?.visionModelCatalog,
      secrets: [visionApiKey]
    }),
    effectiveProvider: normalizedVision.provider,
    effectiveBaseUrl: sanitizeBaseUrlForDisplay(normalizedVision.baseUrl),
    effectiveModel: normalizedVision.model,
    effectiveHasApiKey: Boolean(visionApiKey)
  }
}

const getSafeProviderErrorMessage = (status, code) => {
  const normalizedStatus = Number(status) || 0
  if (normalizedStatus === 401 || normalizedStatus === 403) return 'AI provider authentication failed'
  if (normalizedStatus === 404) return 'AI provider endpoint or model was not found'
  if (normalizedStatus === 429) return 'AI provider rate limit exceeded'
  if (normalizedStatus >= 500) return 'AI provider is temporarily unavailable'
  if (normalizedStatus >= 400) return 'AI provider returned an error response'
  if (code) return `AI provider request failed: ${String(code).slice(0, 64)}`
  return 'AI provider request failed'
}

const createProviderError = ({ status, code }) => {
  const safeCode = sanitizeDiagnosticText(code)
  const error = new Error(getSafeProviderErrorMessage(status, safeCode))
  error.providerStatus = status
  error.providerCode = safeCode
  return error
}

const isStreamingUnsupportedProviderResponse = ({ code, message } = {}) => {
  const details = `${String(code || '')} ${String(message || '')}`.toLowerCase()
  const unsupported = '(?:unsupported|not[_\\s-]?supported|does\\s+not\\s+support)'
  return new RegExp(`(?:stream.{0,32}${unsupported}|${unsupported}.{0,32}stream)`).test(details)
}

const getProviderResponseContentType = (response) => (
  String(response?.headers?.get?.('content-type') || '').trim().toLowerCase()
)

const PROVIDER_RESPONSE_SNIFF_CHAR_LIMIT = 8192

const hasReadableStreamBody = (body) => Boolean(
  body && (
    typeof body.getReader === 'function' ||
    typeof body[Symbol.asyncIterator] === 'function'
  )
)

const classifyProviderResponse = (response) => {
  const contentType = getProviderResponseContentType(response)
  if (contentType.includes('text/event-stream')) return 'sse'
  if (contentType || !hasReadableStreamBody(response?.body)) return 'json'
  return 'sse'
}

const createLinkedAbortSignal = (externalSignal, timeoutMs) => {
  const timeout = createTimeoutController(timeoutMs)
  const controller = new AbortController()
  let abortReason = ''
  const abortFromExternal = () => {
    if (!abortReason) abortReason = 'external'
    controller.abort()
  }
  const abortFromTimeout = () => {
    if (!abortReason) abortReason = 'timeout'
    controller.abort()
  }
  if (externalSignal?.aborted) abortFromExternal()
  else if (timeout.signal.aborted) abortFromTimeout()
  externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true })
  timeout.signal.addEventListener?.('abort', abortFromTimeout, { once: true })
  return {
    signal: controller.signal,
    isTimeout: () => abortReason === 'timeout',
    abort: (reason) => {
      if (!abortReason) abortReason = 'internal'
      controller.abort(reason)
    },
    clear: () => {
      externalSignal?.removeEventListener?.('abort', abortFromExternal)
      timeout.signal.removeEventListener?.('abort', abortFromTimeout)
      timeout.clear()
    }
  }
}

const createAbortError = (linkedSignal) => {
  if (linkedSignal?.isTimeout?.()) return createTimeoutError()
  if (linkedSignal?.signal?.reason?.code === 'RESPONSE_BODY_TOO_LARGE') return createProviderResponseTooLargeError()
  if (linkedSignal?.signal?.reason?.name === 'ProviderResponseTooLargeError') return linkedSignal.signal.reason
  const error = new Error('AI provider request aborted')
  error.name = 'AbortError'
  return error
}

const raceWithLinkedAbort = async (operation, linkedSignal) => {
  const pendingOperation = Promise.resolve(operation)
  if (!linkedSignal?.signal) return await pendingOperation
  if (linkedSignal.signal.aborted) {
    pendingOperation.catch(() => {})
    throw createAbortError(linkedSignal)
  }
  let abortHandler
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(createAbortError(linkedSignal))
    linkedSignal.signal.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([pendingOperation, aborted])
  } finally {
    linkedSignal.signal.removeEventListener('abort', abortHandler)
  }
}

const createProviderResponseTooLargeError = () => {
  const error = new Error('AI provider response exceeded the configured byte limit')
  error.name = 'ProviderResponseTooLargeError'
  error.providerCode = 'response_too_large'
  return error
}

const assertProviderByteLimit = (currentBytes, maxBytes, linkedSignal) => {
  if (currentBytes <= maxBytes) return
  const error = createProviderResponseTooLargeError()
  linkedSignal?.abort?.(error)
  throw error
}

const readStreamTextChunks = async function * (body, linkedSignal = null, maxBytes = Infinity) {
  if (!body) return
  let totalBytes = 0
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let reachedEnd = false
    try {
      while (true) {
        const { done, value } = await raceWithLinkedAbort(reader.read(), linkedSignal)
        if (done) {
          reachedEnd = true
          break
        }
        totalBytes += value?.byteLength || 0
        assertProviderByteLimit(totalBytes, maxBytes, linkedSignal)
        yield decoder.decode(value, { stream: true })
      }
      const tail = decoder.decode()
      if (tail) yield tail
    } finally {
      if (!reachedEnd) {
        try {
          Promise.resolve(reader.cancel()).catch(() => {})
        } catch (_) {
          // Preserve the original stream result or failure when cleanup is already complete.
        }
      }
      reader.releaseLock?.()
    }
    return
  }
  const iterator = body[Symbol.asyncIterator]?.()
  if (!iterator) return
  let reachedEnd = false
  try {
    while (true) {
      const { done, value: chunk } = await raceWithLinkedAbort(iterator.next(), linkedSignal)
      if (done) {
        reachedEnd = true
        break
      }
      if (Buffer.isBuffer(chunk)) {
        totalBytes += chunk.byteLength
        assertProviderByteLimit(totalBytes, maxBytes, linkedSignal)
        yield chunk.toString('utf8')
      } else if (chunk instanceof Uint8Array) {
        totalBytes += chunk.byteLength
        assertProviderByteLimit(totalBytes, maxBytes, linkedSignal)
        yield new TextDecoder().decode(chunk)
      } else {
        const text = String(chunk || '')
        totalBytes += Buffer.byteLength(text, 'utf8')
        assertProviderByteLimit(totalBytes, maxBytes, linkedSignal)
        yield text
      }
    }
  } finally {
    if (!reachedEnd) {
      try {
        Promise.resolve(iterator.return?.()).catch(() => {})
      } catch (_) {
        // Preserve the original stream result or failure when cleanup is already complete.
      }
    }
  }
}

const parseOpenAiStreamLine = (line) => {
  const trimmed = String(line || '').trim()
  if (!trimmed || !trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === '[DONE]') return { done: true }
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch (_) {
    // A malformed data frame means the streamed reply is incomplete. Treating
    // it as an ignorable line would let later frames finalize a reply with
    // silently missing content.
    throw createProviderResponseParseError()
  }
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null
  return {
    delta: typeof choice?.delta?.content === 'string' ? choice.delta.content : '',
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : ''
  }
}

const isOptionalModelsProbeStatus = (status) => [404, 405, 501].includes(Number(status))

const extractDiscoveredModelIds = (body, { secrets = [], sort = true } = {}) => {
  const entries = Array.isArray(body?.data) ? body.data : []
  return uniqueModelIds(
    entries.map((entry) => (typeof entry?.id === 'string' ? entry.id : '')),
    { secrets, sort }
  )
}

const readJsonBody = async (response, linkedSignal = null, maxBytes = Infinity) => {
  if (!response) {
    return { ok: false, body: {} }
  }
  try {
    const buffer = await raceWithLinkedAbort(readBoundedResponseBuffer(response, {
      maxBytes,
      sizeErrorMessage: 'AI provider response exceeded the configured byte limit',
      controller: linkedSignal
    }), linkedSignal)
    return { ok: true, body: JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')) }
  } catch (error) {
    if (
      error?.code === 'RESPONSE_BODY_TOO_LARGE' ||
      error?.providerCode === 'response_too_large' ||
      error?.name === 'ProviderResponseTooLargeError'
    ) {
      throw createProviderResponseTooLargeError()
    }
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
    return { ok: false, body: {} }
  }
}

const createProviderResponseParseError = () => {
  const error = new Error('AI provider response body could not be parsed')
  error.name = 'ProviderResponseParseError'
  error.providerCode = 'response_parse_failed'
  return error
}

const sniffProviderResponseBody = async (body, linkedSignal, fallbackMode, maxBytes) => {
  const iterator = readStreamTextChunks(body, linkedSignal, maxBytes)[Symbol.asyncIterator]()
  const prefetchedChunks = []
  let prefix = ''
  let reachedEnd = false

  while (prefix.length < PROVIDER_RESPONSE_SNIFF_CHAR_LIMIT) {
    const next = await iterator.next()
    if (next.done) {
      reachedEnd = true
      break
    }
    const chunk = String(next.value || '')
    prefetchedChunks.push(chunk)
    prefix += chunk
    const firstContent = prefix.replace(/^\uFEFF/, '').trimStart()
    if (firstContent) {
      let mode = fallbackMode
      if (firstContent.startsWith('{') || firstContent.startsWith('[')) mode = 'json'
      else if (/^(?::|(?:data|event|id|retry)\s*:)/i.test(firstContent)) mode = 'sse'
      return {
        mode,
        prefetchedChunks,
        iterator,
        reachedEnd
      }
    }
  }

  return { mode: fallbackMode, prefetchedChunks, iterator, reachedEnd }
}

const readSniffedJsonBody = async ({ prefetchedChunks, iterator, reachedEnd }, linkedSignal) => {
  let text = prefetchedChunks.join('')
  try {
    while (!reachedEnd) {
      const next = await raceWithLinkedAbort(iterator.next(), linkedSignal)
      if (next.done) {
        reachedEnd = true
        break
      }
      text += String(next.value || '')
    }
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error?.name === 'ProviderResponseTooLargeError') throw error
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
    throw createProviderResponseParseError()
  }
}

const replayPrefetchedTextChunks = async function * ({ prefetchedChunks, iterator, reachedEnd }) {
  let exhausted = reachedEnd
  try {
    for (const chunk of prefetchedChunks) yield chunk
    while (!exhausted) {
      const next = await iterator.next()
      if (next.done) {
        exhausted = true
        break
      }
      yield next.value
    }
  } finally {
    if (!exhausted) {
      try {
        await iterator.return?.()
      } catch (_) {
        // Preserve the original stream result or failure during cleanup.
      }
    }
  }
}

const classifyConnectionError = (error) => {
  if (error?.message === 'AI API key is not configured') {
    return { code: 'missing_api_key', message: 'AI API key is not configured' }
  }
  if (/^Unsupported AI provider:/.test(error?.message || '')) {
    return { code: 'unsupported_provider', message: 'Unsupported AI provider' }
  }
  if (error?.message === 'fetch is not available') {
    return { code: 'fetch_unavailable', message: 'Fetch is not available' }
  }
  if (error?.providerCode === 'response_too_large') {
    return { code: 'response_too_large', message: 'AI provider response exceeded the configured byte limit' }
  }
  if (error?.name === 'AbortError' || error?.message === 'AI provider request timed out') {
    return { code: 'timeout', message: 'AI provider request timed out' }
  }
  if (error?.providerStatus) {
    const status = Number(error.providerStatus) || 0
    if (status === 401 || status === 403) return { code: 'auth_failed', message: 'AI provider rejected the API key' }
    if (status === 404) return { code: 'model_or_endpoint_not_found', message: 'AI provider endpoint or model was not found' }
    return { code: 'provider_http_error', message: `AI provider request failed with status ${status}` }
  }
  if (error?.message === 'AI provider returned an empty response') {
    return { code: 'empty_response', message: 'AI provider returned an empty response' }
  }
  return { code: 'network_error', message: 'AI provider request failed' }
}

const probeAvailableModels = async ({ config, fetchImpl, apiKey, requestTimeoutMs, responseLimits }) => {
  if (config.provider !== 'openai-compatible') {
    return {
      modelsProbe: 'failed',
      availableModels: [],
      currentModelDiscovered: false
    }
  }
  if (typeof fetchImpl !== 'function') {
    return {
      modelsProbe: 'failed',
      availableModels: [],
      currentModelDiscovered: false
    }
  }

  let response
  const linkedSignal = createLinkedAbortSignal(null, requestTimeoutMs)
  try {
    response = await raceWithLinkedAbort(fetchImpl(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: linkedSignal.signal
    }), linkedSignal)
    if (!response || typeof response.ok !== 'boolean') {
      return {
        modelsProbe: 'failed',
        availableModels: [],
        currentModelDiscovered: false
      }
    }

    if (!response.ok) {
      if ([401, 403, 404, 405, 501].includes(Number(response.status) || 0)) {
        return {
          modelsProbe: 'unavailable',
          availableModels: [],
          currentModelDiscovered: false
        }
      }
      return {
        modelsProbe: 'failed',
        availableModels: [],
        currentModelDiscovered: false
      }
    }

    const parsed = await readJsonBody(response, linkedSignal, responseLimits.jsonBytes)
    if (!parsed.ok) {
      return {
        modelsProbe: 'failed',
        availableModels: [],
        currentModelDiscovered: false
      }
    }
    const availableModels = extractDiscoveredModelIds(parsed.body, { secrets: [apiKey], sort: false })

    return {
      modelsProbe: 'ok',
      availableModels,
      currentModelDiscovered: availableModels.includes(String(config.model || '').trim())
    }
  } catch (error) {
    return {
      modelsProbe: error?.name === 'TimeoutError' || linkedSignal.isTimeout()
        ? 'timed_out'
        : 'failed',
      availableModels: [],
      currentModelDiscovered: false
    }
  } finally {
    linkedSignal.clear()
  }
}

const createAiService = ({
  settingsService,
  secretService,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
  maxConversations = DEFAULT_MAX_CONVERSATIONS,
  providerResponseLimits = {},
  conversationStore = null,
  appLogService,
  idFactory = () => crypto.randomUUID()
}) => {
  if (!settingsService) throw new Error('settingsService is required')
  if (!secretService) throw new Error('secretService is required')

  const historyLimit = Math.max(0, Number(maxHistoryMessages) || 0)
  const conversationLimit = Math.max(0, Number(maxConversations) || 0)
  const responseLimits = normalizeProviderResponseLimits(providerResponseLimits)
  const conversationQueues = new Map()
  const createRequestId = (value = '') => {
    const requested = String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 120)
    if (requested) return requested
    const generated = String(idFactory?.() || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 120)
    return generated || `ai-${Date.now().toString(36)}`
  }

  const getRawConfig = () => normalizeConfig(settingsService.get().ai)
  const getStoredAiState = () => (isPlainObject(settingsService.get().ai) ? settingsService.get().ai : {})
  const getModelCatalog = (config = getRawConfig(), storedState = getStoredAiState()) => (
    getScopedProviderModelCatalog({
      capability: 'chat',
      provider: config.provider,
      baseUrl: config.baseUrl,
      catalog: storedState.modelCatalog,
      secrets: [secretService.getSecretValue(config.apiKeyRef)]
    })
  )

  const getConfigLogDetails = (config) => ({
    provider: config.provider,
    model: config.model,
    endpoint: normalizeEndpointForLog(config.baseUrl),
    enabled: config.enabled === true,
    memoryEnabled: config.memory?.enabled === true,
    behaviorEnabled: config.behavior?.enabled === true,
    hatchPetEnabled: config.hatchPet?.enabled === true,
    hatchPetExecutionMode: config.hatchPet?.executionMode || 'shadow',
    hatchPetConfigMode: config.hatchPet?.configMode || 'follow-chat',
    hasSystemPrompt: Boolean(String(config.systemPrompt || '').trim())
  })

  const recordLog = (entry) => {
    try {
      appLogService?.record?.({
        actor: 'system',
        scope: 'ai-provider',
        ...entry
      })
    } catch (_) {
      // Diagnostics must never break AI chat.
    }
  }

  const enqueueConversation = (conversationId, task) => {
    if (!conversationId) return task()
    const previous = conversationQueues.get(conversationId) || Promise.resolve()
    const queued = previous.catch(() => {}).then(task)
    const marker = queued.catch(() => {}).finally(() => {
      if (conversationQueues.get(conversationId) === marker) conversationQueues.delete(conversationId)
    })
    conversationQueues.set(conversationId, marker)
    return queued
  }

  const getStoredConversations = () => normalizeConversationStore(conversationStore ? conversationStore.load() : settingsService.get().ai?.conversations, historyLimit)

  const persistConversations = (conversations) => {
    if (conversationStore) return conversationStore.save(conversations)
    // Atomic update: read the freshest settings at write-time so a concurrent
    // writer to a different ai.* field (e.g. behavior decisions) is not clobbered
    // by a stale snapshot captured before an await.
    settingsService.update((settings) => {
      const currentAi = isPlainObject(settings.ai) ? settings.ai : {}
      return {
        ...settings,
        ai: {
          ...normalizeConfig(currentAi),
          conversations,
          modelCatalog: currentAi.modelCatalog,
          visionModelCatalog: currentAi.visionModelCatalog
        }
      }
    })
  }

  const persistModelCatalog = (config, models) => {
    const nextCatalog = createSavedProviderModelCatalog({
      capability: 'chat',
      provider: config.provider,
      baseUrl: config.baseUrl,
      models,
      fetchedAt: new Date().toISOString(),
      secrets: [secretService.getSecretValue(config.apiKeyRef)]
    })
    settingsService.update((settings) => {
      const currentAi = isPlainObject(settings.ai) ? settings.ai : {}
      return {
        ...settings,
        ai: {
          ...normalizeConfig(currentAi),
          conversations: normalizeConversationStore(currentAi.conversations, historyLimit),
          modelCatalog: nextCatalog,
          visionModelCatalog: currentAi.visionModelCatalog
        }
      }
    })
    return nextCatalog
  }

  const persistVisionModelCatalog = (visionConfig, models) => {
    const nextCatalog = createSavedProviderModelCatalog({
      capability: 'vision',
      provider: visionConfig.provider,
      baseUrl: visionConfig.baseUrl,
      models,
      fetchedAt: new Date().toISOString(),
      secrets: [secretService.getSecretValue(visionConfig.apiKeyRef)]
    })
    settingsService.update((settings) => {
      const currentAi = isPlainObject(settings.ai) ? settings.ai : {}
      return {
        ...settings,
        ai: {
          ...normalizeConfig(currentAi),
          conversations: normalizeConversationStore(currentAi.conversations, historyLimit),
          modelCatalog: currentAi.modelCatalog,
          visionModelCatalog: nextCatalog
        }
      }
    })
    return nextCatalog
  }

  const getConfig = () => {
    const config = getRawConfig()
    const storedState = getStoredAiState()
    const hatchPetKeyRef = config.hatchPet.configMode === 'follow-chat'
      ? config.apiKeyRef
      : config.hatchPet.apiKeyRef
    return {
      ...config,
      baseUrl: sanitizeBaseUrlForDisplay(config.baseUrl),
      hasApiKey: Boolean(secretService.getSecretValue(config.apiKeyRef)),
      vision: buildEffectiveVisionConfig({ config, secretService, storedState }),
      hatchPet: createHatchPetAgentPublicConfig(
        config.hatchPet,
        Boolean(secretService.getSecretValue(hatchPetKeyRef))
      ),
      modelCatalog: getModelCatalog(config, storedState)
    }
  }

  const saveConfig = (partialConfig) => {
    assertProviderConfigPayload(partialConfig, 'AI Provider')
    const requestId = createRequestId()
    const ownerFieldOverrides = findOwnerFieldOverrides(partialConfig, {
      topLevel: ['apiKeyRef'],
      nested: { vision: ['apiKeyRef'], hatchPet: ['apiKeyRef'] }
    })
    if (ownerFieldOverrides.length) {
      recordLog({
        scope: 'ai-settings',
        level: 'warn',
        event: 'ai.settings.owner-fields.rejected',
        message: 'AI Provider owner-controlled fields were rejected',
        details: {
          ...createProviderOperationDetails({
            capability: 'chat',
            operation: 'save-config',
            config: getRawConfig(),
            configSource: 'chat',
            requestId,
            outcome: 'rejected'
          }),
          fields: ownerFieldOverrides
        }
      })
      throw new Error(`AI Provider owner-controlled fields cannot be changed: ${ownerFieldOverrides.join(', ')}`)
    }

    const settings = settingsService.get()
    const currentAi = getStoredAiState()
    const editableConfig = {}
    for (const field of ['enabled', 'provider', 'baseUrl', 'model', 'systemPrompt', 'memory']) {
      if (Object.hasOwn(partialConfig, field)) editableConfig[field] = partialConfig[field]
    }
    const merged = {
      ...currentAi,
      ...editableConfig,
      behavior: currentAi.behavior,
      baseUrl: Object.hasOwn(editableConfig, 'baseUrl')
        ? editableConfig.baseUrl
        : sanitizeBaseUrlForDisplay(currentAi.baseUrl)
    }
    const submittedVision = isPlainObject(partialConfig.vision) ? partialConfig.vision : {}
    const editableVision = {}
    for (const field of ['mode', 'provider', 'baseUrl', 'model']) {
      if (Object.hasOwn(submittedVision, field)) editableVision[field] = submittedVision[field]
    }
    const nextVision = normalizeVisionConfig({
      ...(isPlainObject(currentAi.vision) ? currentAi.vision : {}),
      ...editableVision,
      baseUrl: Object.hasOwn(editableVision, 'baseUrl')
        ? editableVision.baseUrl
        : sanitizeBaseUrlForDisplay(currentAi.vision?.baseUrl)
    })
    const nextHatchPet = normalizeHatchPetAgentConfig({
      ...mergeHatchPetConfigWithoutDisplayDowngrade(
        currentAi.hatchPet,
        partialConfig?.hatchPet
      )
    })
    let nextAi = {
      ...normalizeConfig({
        ...merged,
        vision: nextVision,
        hatchPet: nextHatchPet
      }),
      conversations: conversationStore ? settings.ai?.conversations : getStoredConversations(),
      modelCatalog: currentAi.modelCatalog,
      visionModelCatalog: currentAi.visionModelCatalog
    }
    const validated = validateProviderConfigInput({
      provider: nextAi.provider,
      baseUrl: nextAi.baseUrl,
      model: nextAi.model,
      label: 'AI'
    })
    nextAi = { ...nextAi, ...validated }
    if (nextVision.mode === 'override') {
      const validatedVision = validateProviderConfigInput({
        provider: nextVision.provider,
        baseUrl: nextVision.baseUrl,
        model: nextVision.model,
        label: 'Vision'
      })
      nextAi.vision = {
        ...nextAi.vision,
        ...validatedVision,
        apiKeyRef: getCapabilitySecretRef('vision')
      }
    }
    settingsService.save({ ...settings, ai: nextAi })
    recordLog({
      scope: 'ai-settings',
      level: 'info',
      event: 'ai.settings.saved',
      message: 'AI provider settings saved',
      details: {
        ...createProviderOperationDetails({
          capability: 'chat',
          operation: 'save-config',
          config: nextAi,
          configSource: 'chat',
          requestId,
          outcome: 'completed'
        }),
        ...getConfigLogDetails(nextAi)
      }
    })
    return getConfig()
  }

  const saveApiKey = (value) => {
    const apiKey = String(value || '').trim()
    if (!apiKey) throw new Error('API Key 不能为空')
    const config = getRawConfig()
    const requestId = createRequestId()
    const updatedAt = new Date().toISOString()
    secretService.setSecret({ id: config.apiKeyRef, value: apiKey, label: 'AI API Key' })
    recordLog({
      scope: 'ai-settings',
      level: 'info',
      event: 'ai.settings.api-key.saved',
      message: 'AI provider API key saved',
      details: {
        ...createProviderOperationDetails({
          capability: 'chat',
          operation: 'save-secret',
          config,
          configSource: 'chat',
          requestId,
          outcome: 'completed'
        }),
        ...getConfigLogDetails(config),
        apiKeyRef: config.apiKeyRef,
        updatedAt
      }
    })
    return {
      apiKeyRef: config.apiKeyRef,
      hasApiKey: true,
      updatedAt
    }
  }

  const saveVisionApiKey = (value) => {
    const apiKey = String(value || '').trim()
    if (!apiKey) throw new Error('Vision API Key 不能为空')
    const config = getRawConfig()
    const visionConfig = normalizeVisionConfig(config.vision)
    const requestId = createRequestId()
    const updatedAt = new Date().toISOString()
    secretService.setSecret({ id: visionConfig.apiKeyRef, value: apiKey, label: 'Vision API Key' })
    recordLog({
      scope: 'ai-settings',
      level: 'info',
      event: 'ai.settings.vision-api-key.saved',
      message: 'Vision provider API key saved',
      details: {
        ...createProviderOperationDetails({
          capability: 'vision',
          operation: 'save-secret',
          config: visionConfig,
          configSource: 'vision-override',
          requestId,
          outcome: 'completed'
        }),
        provider: visionConfig.provider,
        model: visionConfig.model,
        endpoint: normalizeEndpointForLog(visionConfig.baseUrl),
        apiKeyRef: visionConfig.apiKeyRef,
        updatedAt
      }
    })
    return {
      apiKeyRef: visionConfig.apiKeyRef,
      hasApiKey: true,
      updatedAt
    }
  }

  const clearVisionApiKey = () => {
    const config = getRawConfig()
    const visionConfig = normalizeVisionConfig(config.vision)
    const requestId = createRequestId()
    secretService.deleteSecret?.(visionConfig.apiKeyRef)
    recordLog({
      scope: 'ai-settings',
      level: 'info',
      event: 'ai.settings.vision-api-key.cleared',
      message: 'Vision provider API key cleared',
      details: {
        ...createProviderOperationDetails({
          capability: 'vision',
          operation: 'clear-secret',
          config: visionConfig,
          configSource: 'vision-override',
          requestId,
          outcome: 'completed'
        }),
        provider: visionConfig.provider,
        model: visionConfig.model,
        endpoint: normalizeEndpointForLog(visionConfig.baseUrl),
        apiKeyRef: visionConfig.apiKeyRef
      }
    })
    return {
      apiKeyRef: visionConfig.apiKeyRef,
      hasApiKey: false
    }
  }

  const getEffectiveVisionConfig = () => {
    const config = getRawConfig()
    const storedState = getStoredAiState()
    return buildEffectiveVisionConfig({ config, secretService, storedState })
  }

  const rememberConversation = (conversationId, messages) => {
    if (!conversationId || conversationLimit <= 0) return []
    const conversations = getStoredConversations()
    const nextConversations = { ...conversations }
    const history = normalizeHistory(messages, historyLimit)
    if (Object.hasOwn(nextConversations, conversationId)) delete nextConversations[conversationId]
    if (!history.length) {
      persistConversations(nextConversations)
      return []
    }
    while (Object.keys(nextConversations).length >= conversationLimit) {
      delete nextConversations[Object.keys(nextConversations)[0]]
    }
    nextConversations[conversationId] = history
    persistConversations(nextConversations)
    return cloneHistory(history, historyLimit)
  }

  const getConversation = (conversationId) => {
    const normalizedId = assertValidConversationId(normalizeConversationId(conversationId))
    if (!normalizedId) return []
    return cloneHistory(getStoredConversations()[normalizedId], historyLimit)
  }

  const clearConversation = (conversationId) => {
    const normalizedId = assertValidConversationId(normalizeConversationId(conversationId))
    if (!normalizedId) return []
    const conversations = getStoredConversations()
    if (Object.hasOwn(conversations, normalizedId)) {
      delete conversations[normalizedId]
      persistConversations(conversations)
    }
    return []
  }

  const completeWithConfig = async ({
    messages,
    tools = [],
    resolvedConfig,
    capability,
    configSource,
    requestId,
    signal = null
  } = {}) => {
    const config = normalizeCompletionConfig(resolvedConfig)
    const apiKey = secretService.getSecretValue(config.apiKeyRef)
    const startedAt = Date.now()
    const baseDetails = {
      ...createProviderOperationDetails({
        capability,
        operation: 'complete',
        config,
        configSource,
        requestId
      }),
      endpoint: normalizeEndpointForLog(config.baseUrl),
      messagesCount: Array.isArray(messages) ? messages.length : 0,
      toolsCount: Array.isArray(tools) ? tools.length : 0,
      timeoutMs: requestTimeoutMs,
      hasApiKey: Boolean(apiKey)
    }
    recordLog({
      level: 'info',
      event: 'ai.provider.request.started',
      message: 'AI provider request started',
      details: { ...baseDetails, outcome: 'started' }
    })
    let response
    let linkedSignal = null
    try {
      const runtimeConfig = resolveRuntimeProviderConfig(config, capability === 'vision' ? 'Vision' : 'AI')
      if (!apiKey) throw new Error('AI API key is not configured')
      if (typeof fetchImpl !== 'function') throw new Error('fetch is not available')

      linkedSignal = createLinkedAbortSignal(signal, requestTimeoutMs)
      const body = {
        model: runtimeConfig.model,
        messages
      }
      if (tools.length) body.tools = tools

      try {
        response = await raceWithLinkedAbort(fetchImpl(`${runtimeConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          signal: linkedSignal.signal,
          body: JSON.stringify(body)
        }), linkedSignal)
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
        const safeError = new Error('AI provider request failed')
        Object.defineProperty(safeError, 'diagnosticMessage', {
          value: sanitizeDiagnosticText(error?.message || error),
          enumerable: false
        })
        throw safeError
      }

      const { body: data } = await readJsonBody(response, linkedSignal, responseLimits.jsonBytes)
      if (!response.ok) {
        throw createProviderError({
          status: response.status,
          code: data?.error?.code
        })
      }
      const result = parseChatResult(data)
      assertProviderByteLimit(Buffer.byteLength(result.reply, 'utf8'), responseLimits.replyBytes, linkedSignal)
      recordLog({
        level: 'info',
        event: 'ai.provider.request.completed',
        message: 'AI provider request completed',
        details: {
          ...baseDetails,
          outcome: 'completed',
          status: response.status,
          durationMs: Date.now() - startedAt,
          elapsedMs: Date.now() - startedAt,
          replyChars: String(result.reply || '').length,
          hasBehaviorIntent: Boolean(result.behaviorIntent)
        }
      })
      return {
        ...result,
        elapsedMs: Date.now() - startedAt
      }
    } catch (error) {
      recordLog({
        level: 'error',
        event: 'ai.provider.request.failed',
        message: 'AI provider request failed',
        details: {
          ...baseDetails,
          outcome: 'failed',
          status: error?.providerStatus || response?.status || 0,
          providerCode: error?.providerCode || '',
          durationMs: Date.now() - startedAt,
          elapsedMs: Date.now() - startedAt,
          errorName: sanitizeDiagnosticText(error?.name || 'Error'),
          errorMessage: error?.providerStatus
            ? 'AI provider returned an error response'
            : sanitizeDiagnosticText(error?.diagnosticMessage || error?.message)
        }
      })
      throw error
    } finally {
      linkedSignal?.clear()
    }
  }

  const complete = async (request = {}) => {
    const requestId = createRequestId(request?.requestId)
    if (Object.hasOwn(request, 'configOverride')) {
      recordLog({
        level: 'warn',
        event: 'ai.provider.owner-fields.rejected',
        message: 'AI Provider owner-controlled completion config was rejected',
        details: {
          ...createProviderOperationDetails({
            capability: 'chat',
            operation: 'complete',
            config: getRawConfig(),
            configSource: 'chat',
            requestId,
            outcome: 'rejected'
          }),
          fields: ['configOverride']
        }
      })
      throw new Error('AI Provider owner-controlled configOverride cannot be supplied by consumers')
    }
    return completeWithConfig({
      messages: request.messages,
      tools: request.tools,
      signal: request.signal,
      resolvedConfig: getRawConfig(),
      capability: 'chat',
      configSource: 'chat',
      requestId
    })
  }

  const completeVision = async ({ messages, tools = [], requestId = '', signal = null } = {}) => {
    const visionConfig = getEffectiveVisionConfig()
    return completeWithConfig({
      messages,
      tools,
      signal,
      resolvedConfig: visionConfig,
      capability: 'vision',
      configSource: visionConfig.mode === 'override' ? 'vision-override' : 'vision-follow-chat',
      requestId: createRequestId(requestId)
    })
  }

  const streamComplete = async (request = {}) => {
    const safeRequestId = createRequestId(request?.requestId)
    if (Object.hasOwn(request, 'configOverride')) {
      recordLog({
        level: 'warn',
        event: 'ai.provider.owner-fields.rejected',
        message: 'AI Provider owner-controlled stream config was rejected',
        details: {
          ...createProviderOperationDetails({
            capability: 'chat',
            operation: 'stream',
            config: getRawConfig(),
            configSource: 'chat',
            requestId: safeRequestId,
            outcome: 'rejected'
          }),
          fields: ['configOverride']
        }
      })
      throw new Error('AI Provider owner-controlled configOverride cannot be supplied by consumers')
    }
    const {
      messages,
      tools = [],
      signal = null,
      onDelta = null
    } = request
    if (Array.isArray(tools) && tools.length) {
      const result = await complete({ messages, tools, requestId: safeRequestId, signal })
      return {
        ...result,
        streaming: false,
        fallback: true,
        fallbackReason: 'tools-not-supported',
        chunkCount: 0,
        finishReason: ''
      }
    }

    const config = normalizeCompletionConfig(getRawConfig())
    const apiKey = secretService.getSecretValue(config.apiKeyRef)
    const startedAt = Date.now()
    const capability = 'chat'
    const configSource = 'chat'
    const baseDetails = {
      ...createProviderOperationDetails({
        capability,
        operation: 'stream',
        config,
        configSource,
        requestId: safeRequestId
      }),
      endpoint: normalizeEndpointForLog(config.baseUrl),
      messagesCount: Array.isArray(messages) ? messages.length : 0,
      toolsCount: Array.isArray(tools) ? tools.length : 0,
      timeoutMs: requestTimeoutMs,
      hasApiKey: Boolean(apiKey)
    }
    recordLog({
      level: 'info',
      event: 'ai.provider.stream.started',
      message: 'AI provider stream started',
      details: { ...baseDetails, outcome: 'started' }
    })

    let response
    let linkedSignal = null
    let reply = ''
    let chunkCount = 0
    let finishReason = ''
    try {
      const runtimeConfig = resolveRuntimeProviderConfig(config, 'AI')
      if (!apiKey) throw new Error('AI API key is not configured')
      if (typeof fetchImpl !== 'function') throw new Error('fetch is not available')

      linkedSignal = createLinkedAbortSignal(signal, requestTimeoutMs)
      try {
        response = await raceWithLinkedAbort(fetchImpl(`${runtimeConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          signal: linkedSignal.signal,
          body: JSON.stringify({
            model: runtimeConfig.model,
            messages,
            stream: true
          })
        }), linkedSignal)
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error
        const safeError = new Error('AI provider stream failed')
        Object.defineProperty(safeError, 'diagnosticMessage', {
          value: sanitizeDiagnosticText(error?.message || error),
          enumerable: false
        })
        throw safeError
      }

      if (!response.ok) {
        const { body: data } = await readJsonBody(response, linkedSignal, responseLimits.jsonBytes)
        const providerMessage = typeof data?.error?.message === 'string' ? data.error.message : ''
        const providerCode = typeof data?.error?.code === 'string' ? data.error.code : ''
        const providerError = createProviderError({
          status: response.status,
          code: providerCode
        })
        if (isStreamingUnsupportedProviderResponse({
          code: providerCode,
          message: providerMessage
        })) {
          linkedSignal.clear()
          linkedSignal = null
          const fallbackResult = await complete({ messages, tools, requestId: safeRequestId, signal })
          recordLog({
            level: 'info',
            event: 'ai.provider.stream.completed',
            message: 'AI provider stream completed through non-streaming fallback',
            details: {
              ...baseDetails,
              outcome: 'completed',
              status: response.status,
              durationMs: Date.now() - startedAt,
              elapsedMs: Date.now() - startedAt,
              chunkCount: 0,
              replyChars: String(fallbackResult.reply || '').length,
              finishReason: '',
              fallback: true,
              fallbackReason: 'unsupported-stream'
            }
          })
          return {
            ...fallbackResult,
            streaming: false,
            fallback: true,
            fallbackReason: 'unsupported-stream',
            chunkCount: 0,
            finishReason: ''
          }
        }
        throw providerError
      }

      let responseMode = classifyProviderResponse(response)
      let sniffedResponse = null
      if (hasReadableStreamBody(response.body)) {
        sniffedResponse = await sniffProviderResponseBody(response.body, linkedSignal, responseMode, responseLimits.streamBytes)
        responseMode = sniffedResponse.mode
      }

      if (responseMode === 'json') {
        let data
        if (sniffedResponse) {
          data = await readSniffedJsonBody(sniffedResponse, linkedSignal)
        } else {
          const parsed = await readJsonBody(response, linkedSignal, responseLimits.jsonBytes)
          if (!parsed.ok) throw createProviderResponseParseError()
          data = parsed.body
        }
        const result = parseChatResult(data)
        assertProviderByteLimit(Buffer.byteLength(result.reply, 'utf8'), responseLimits.replyBytes, linkedSignal)
        const nonStreamFinishReason = typeof data?.choices?.[0]?.finish_reason === 'string'
          ? data.choices[0].finish_reason
          : ''
        recordLog({
          level: 'info',
          event: 'ai.provider.stream.completed',
          message: 'AI provider stream completed through the response JSON fallback',
          details: {
            ...baseDetails,
            outcome: 'completed',
            status: response.status,
            durationMs: Date.now() - startedAt,
            elapsedMs: Date.now() - startedAt,
            chunkCount: 0,
            replyChars: String(result.reply || '').length,
            finishReason: nonStreamFinishReason,
            fallback: true,
            fallbackReason: 'non-stream-response'
          }
        })
        return {
          ...result,
          elapsedMs: Date.now() - startedAt,
          streaming: false,
          fallback: true,
          fallbackReason: 'non-stream-response',
          chunkCount: 0,
          finishReason: nonStreamFinishReason
        }
      }

      let buffer = ''
      let done = false
      const consumeLine = (line) => {
        const event = parseOpenAiStreamLine(line)
        if (!event) return false
        if (event.done) return true
        if (event.finishReason) finishReason = event.finishReason
        if (!event.delta) return false
        assertProviderByteLimit(Buffer.byteLength(reply, 'utf8') + Buffer.byteLength(event.delta, 'utf8'), responseLimits.replyBytes, linkedSignal)
        chunkCount += 1
        reply += event.delta
        if (typeof onDelta === 'function') onDelta(event.delta)
        return false
      }
      const streamChunks = sniffedResponse
        ? replayPrefetchedTextChunks(sniffedResponse)
        : readStreamTextChunks(response.body, linkedSignal, responseLimits.streamBytes)
      for await (const textChunk of streamChunks) {
        if (linkedSignal.signal.aborted) {
          if (linkedSignal.isTimeout()) throw createTimeoutError()
          const abortError = new Error('AI provider stream aborted')
          abortError.name = 'AbortError'
          throw abortError
        }
        buffer += textChunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (consumeLine(line)) {
            done = true
            break
          }
        }
        if (done) break
      }
      if (!done && buffer) consumeLine(buffer)
      if (!reply.trim()) throw new Error('AI provider returned an empty response')

      recordLog({
        level: 'info',
        event: 'ai.provider.stream.completed',
        message: 'AI provider stream completed',
        details: {
          ...baseDetails,
          outcome: 'completed',
          status: response.status,
          durationMs: Date.now() - startedAt,
          elapsedMs: Date.now() - startedAt,
          chunkCount,
          replyChars: reply.length,
          finishReason
        }
      })
      return {
        reply,
        behaviorIntent: null,
        elapsedMs: Date.now() - startedAt,
        streaming: true,
        fallback: false,
        fallbackReason: '',
        chunkCount,
        finishReason
      }
    } catch (error) {
      const reportedError = error?.name === 'AbortError' && linkedSignal?.isTimeout?.()
        ? createTimeoutError()
        : error
      recordLog({
        level: 'error',
        event: 'ai.provider.stream.failed',
        message: 'AI provider stream failed',
        details: {
          ...baseDetails,
          outcome: 'failed',
          status: reportedError?.providerStatus || response?.status || 0,
          providerCode: reportedError?.providerCode || '',
          durationMs: Date.now() - startedAt,
          elapsedMs: Date.now() - startedAt,
          chunkCount,
          partialReplyChars: reply.length,
          errorName: sanitizeDiagnosticText(reportedError?.name || 'Error'),
          errorMessage: reportedError?.providerStatus
            ? 'AI provider returned an error response'
            : sanitizeDiagnosticText(reportedError?.diagnosticMessage || reportedError?.message)
        }
      })
      throw reportedError
    } finally {
      linkedSignal?.clear()
    }
  }

  const completeStructuredTool = async ({
    messages,
    tool,
    configOverride = null,
    signal = null,
    timeoutMs = requestTimeoutMs
  } = {}) => {
    const normalizedMessages = Array.isArray(messages) ? messages : []
    if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) {
      throw new Error('Structured AI completion requires one function tool')
    }
    const toolName = typeof tool.function.name === 'string' ? tool.function.name.trim() : ''
    if (!toolName || !/^[a-zA-Z0-9_-]{1,80}$/.test(toolName)) {
      throw new Error('Structured AI completion tool name is invalid')
    }
    const config = normalizeCompletionConfig(configOverride || getRawConfig())
    const apiKey = secretService.getSecretValue(config.apiKeyRef)
    const effectiveTimeoutMs = Math.min(120000, Math.max(1000, Number(timeoutMs) || requestTimeoutMs))
    const startedAt = Date.now()
    const configSource = typeof configOverride?.source === 'string' && configOverride.source.trim()
      ? configOverride.source.trim().slice(0, 80)
      : (configOverride ? 'override' : 'chat')
    const baseDetails = {
      configSource,
      provider: config.provider,
      model: config.model,
      endpoint: normalizeEndpointForLog(config.baseUrl),
      messagesCount: normalizedMessages.length,
      toolName,
      timeoutMs: effectiveTimeoutMs,
      hasApiKey: Boolean(apiKey)
    }
    recordLog({
      level: 'info',
      event: 'ai.structured.request.started',
      message: 'Structured AI provider request started',
      details: baseDetails
    })
    let response
    try {
      if (!apiKey) throw new Error('AI API key is not configured')
      if (config.provider !== 'openai-compatible') {
        throw new Error(`Unsupported AI provider: ${config.provider}`)
      }
      if (typeof fetchImpl !== 'function') throw new Error('fetch is not available')

      const linkedSignal = createLinkedAbortSignal(signal, effectiveTimeoutMs)
      let data = {}
      try {
        response = await raceWithLinkedAbort(fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          signal: linkedSignal.signal,
          body: JSON.stringify({
            model: config.model,
            messages: normalizedMessages,
            tools: [tool],
            tool_choice: {
              type: 'function',
              function: { name: toolName }
            }
          })
        }), linkedSignal)
        const parsed = await readJsonBody(response, linkedSignal, responseLimits.jsonBytes)
        data = parsed.body
      } catch (error) {
        if (error?.name === 'AbortError' && linkedSignal.isTimeout()) {
          throw createTimeoutError()
        }
        throw error
      } finally {
        linkedSignal.clear()
      }

      if (!response.ok) {
        throw createProviderError({
          message: data?.error?.message || `AI provider request failed with status ${response.status}`,
          status: response.status,
          code: data?.error?.code
        })
      }
      const argumentsValue = parseNamedToolCall(data, toolName)
      const elapsedMs = Date.now() - startedAt
      recordLog({
        level: 'info',
        event: 'ai.structured.request.completed',
        message: 'Structured AI provider request completed',
        details: {
          ...baseDetails,
          status: response.status,
          elapsedMs
        }
      })
      return {
        arguments: argumentsValue,
        model: config.model,
        provider: config.provider,
        elapsedMs
      }
    } catch (error) {
      recordLog({
        level: 'error',
        event: 'ai.structured.request.failed',
        message: 'Structured AI provider request failed',
        details: {
          ...baseDetails,
          status: error?.providerStatus || response?.status || 0,
          providerCode: error?.providerCode || '',
          elapsedMs: Date.now() - startedAt,
          errorName: sanitizeDiagnosticText(error?.name || 'Error'),
          errorMessage: error?.providerStatus
            ? 'AI provider returned an error response'
            : sanitizeDiagnosticText(error?.message)
        }
      })
      throw error
    }
  }

  const chat = async ({ message, conversationId }) => {
    const normalizedConversationId = assertValidConversationId(normalizeConversationId(conversationId))
    return enqueueConversation(normalizedConversationId, async () => {
      const config = getRawConfig()
      if (!config.enabled) throw new Error('AI chat is disabled')
      const history = normalizedConversationId ? getConversation(normalizedConversationId) : []
      const content = String(message || '').trim()
      if (!content) throw new Error('AI chat message is empty')
      if (content.length > MAX_USER_MESSAGE_CHARS) throw new Error('AI chat message is too long')
      const userMessage = { role: 'user', content }
      const messages = []
      if (config.systemPrompt) messages.push({ role: 'system', content: config.systemPrompt })
      messages.push(...history, userMessage)
      const tools = config.behavior.enabled && config.behavior.useTools ? [getBehaviorToolDefinition()] : []
      const result = await complete({ messages, tools })
      let nextMessages
      if (normalizedConversationId) {
        nextMessages = rememberConversation(normalizedConversationId, [...history, userMessage, { role: 'assistant', content: result.reply }])
      }
      return { conversationId: normalizedConversationId || undefined, reply: result.reply, behaviorIntent: result.behaviorIntent || undefined, messages: nextMessages }
    })
  }

  const testConnection = async () => {
    const config = getRawConfig()
    const apiKey = secretService.getSecretValue(config.apiKeyRef)
    const hasApiKey = Boolean(apiKey)
    const startedAt = Date.now()
    const requestId = createRequestId()
    const baseResult = {
      provider: config.provider,
      baseUrl: sanitizeBaseUrlForDisplay(config.baseUrl),
      model: config.model,
      hasApiKey
    }
    recordLog({
      scope: 'ai-settings',
      level: 'info',
      event: 'ai.settings.connection-test.started',
      message: 'AI provider connection test started',
      details: {
        ...createProviderOperationDetails({
          capability: 'chat',
          operation: 'connection-test',
          config,
          configSource: 'chat',
          requestId,
          outcome: 'started'
        }),
        ...baseResult
      }
    })
    try {
      const result = await complete({
        requestId,
        messages: [
          { role: 'user', content: 'Reply with ok.' }
        ]
      })
      const modelProbe = await probeAvailableModels({
        config,
        fetchImpl,
        apiKey,
        requestTimeoutMs,
        responseLimits
      })
      const response = {
        ok: true,
        ...baseResult,
        elapsedMs: Date.now() - startedAt,
        reply: String(result.reply || '').slice(0, 120),
        code: 'ok',
        message: 'AI provider connection test succeeded',
        ...modelProbe
      }
      if (response.modelsProbe === 'ok') {
        persistModelCatalog(config, response.availableModels)
      }
      recordLog({
        scope: 'ai-settings',
        level: 'info',
        event: 'ai.settings.connection-test.completed',
        message: 'AI provider connection test completed',
        details: {
          ...createProviderOperationDetails({
            capability: 'chat',
            operation: 'connection-test',
            config,
            configSource: 'chat',
            requestId,
            outcome: 'completed'
          }),
          ...baseResult,
          durationMs: response.elapsedMs,
          elapsedMs: response.elapsedMs,
          replyChars: response.reply.length,
          modelsProbe: response.modelsProbe || 'failed',
          availableModelsCount: Array.isArray(response.availableModels) ? response.availableModels.length : 0
        }
      })
      return response
    } catch (error) {
      const classified = classifyConnectionError(error)
      const response = {
        ok: false,
        ...baseResult,
        elapsedMs: Date.now() - startedAt,
        code: classified.code,
        message: classified.message
      }
      recordLog({
        scope: 'ai-settings',
        level: 'error',
        event: 'ai.settings.connection-test.failed',
        message: 'AI provider connection test failed',
        details: {
          ...createProviderOperationDetails({
            capability: 'chat',
            operation: 'connection-test',
            config,
            configSource: 'chat',
            requestId,
            outcome: 'failed'
          }),
          ...baseResult,
          durationMs: response.elapsedMs,
          elapsedMs: response.elapsedMs,
          status: error?.providerStatus || 0,
          providerCode: error?.providerCode || '',
          code: classified.code,
          message: classified.message
        }
      })
      return response
    }
  }

  const discoverModels = async () => {
    const storedConfig = getRawConfig()
    let config = storedConfig
    const apiKey = secretService.getSecretValue(storedConfig.apiKeyRef)
    const startedAt = Date.now()
    const requestId = createRequestId()
    const baseResult = {
      provider: config.provider,
      baseUrl: sanitizeBaseUrlForDisplay(config.baseUrl),
      model: config.model,
      hasApiKey: Boolean(apiKey)
    }
    recordLog({
      scope: 'ai-settings',
      level: 'info',
      event: 'ai.settings.model-discovery.started',
      message: 'AI provider model discovery started',
      details: {
        ...createProviderOperationDetails({
          capability: 'chat',
          operation: 'discover-models',
          config,
          configSource: 'chat',
          requestId,
          outcome: 'started'
        }),
        ...baseResult
      }
    })
    let response
    let linkedSignal = null
    let discoveryResult = null
    const completeDiscovery = (result) => {
      discoveryResult = result
      return result
    }
    try {
      config = resolveRuntimeProviderConfig(storedConfig, 'AI')
      if (!apiKey) {
        return completeDiscovery({
          ok: false,
          ...baseResult,
          models: [],
          code: 'missing_api_key',
          message: 'AI API key is not configured'
        })
      }
      if (config.provider !== 'openai-compatible') {
        return completeDiscovery({
          ok: false,
          ...baseResult,
          models: [],
          code: 'unsupported_provider',
          message: 'Unsupported AI provider'
        })
      }
      if (typeof fetchImpl !== 'function') {
        return completeDiscovery({
          ok: false,
          ...baseResult,
          models: [],
          code: 'fetch_unavailable',
          message: 'Fetch is not available'
        })
      }

      linkedSignal = createLinkedAbortSignal(null, requestTimeoutMs)
      response = await raceWithLinkedAbort(fetchImpl(`${config.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: linkedSignal.signal
      }), linkedSignal)

      const { body } = await readJsonBody(response, linkedSignal, responseLimits.jsonBytes)
      if (!response.ok) {
        if (isOptionalModelsProbeStatus(response.status)) {
          return completeDiscovery({
            ok: true,
            ...baseResult,
            models: [],
            code: 'provider_reachable_models_unavailable',
            message: 'AI provider is reachable, but the optional /models probe is unavailable'
          })
        }
        throw createProviderError({
          status: response.status,
          code: body?.error?.code
        })
      }

      const discoveredModels = extractDiscoveredModelIds(body, { secrets: [apiKey] })
      persistModelCatalog(config, discoveredModels)
      return completeDiscovery({
        ok: true,
        ...baseResult,
        models: discoveredModels,
        code: 'ok',
        message: 'AI provider model discovery succeeded'
      })
    } catch (error) {
      const classified = classifyConnectionError(error)
      return completeDiscovery({
        ok: false,
        ...baseResult,
        models: [],
        code: classified.code,
        message: classified.message
      })
    } finally {
      linkedSignal?.clear()
      const succeeded = discoveryResult?.ok === true
      recordLog({
        scope: 'ai-settings',
        level: succeeded ? 'info' : 'error',
        event: succeeded ? 'ai.settings.model-discovery.completed' : 'ai.settings.model-discovery.failed',
        message: succeeded ? 'AI provider model discovery completed' : 'AI provider model discovery failed',
        details: {
          ...createProviderOperationDetails({
            capability: 'chat',
            operation: 'discover-models',
            config,
            configSource: 'chat',
            requestId,
            outcome: succeeded ? 'completed' : 'failed'
          }),
          ...baseResult,
          durationMs: Date.now() - startedAt,
          elapsedMs: Date.now() - startedAt,
          status: response?.status || 0,
          modelCount: Array.isArray(discoveryResult?.models) ? discoveryResult.models.length : 0,
          errorCode: succeeded ? '' : String(discoveryResult?.code || 'model_discovery_error'),
          errorMessage: succeeded ? '' : sanitizeDiagnosticText(discoveryResult?.message || 'AI provider model discovery failed')
        }
      })
    }
  }

  const discoverVisionModels = async () => {
    const config = getRawConfig()
    const storedState = getStoredAiState()
    const storedVisionConfig = normalizeVisionConfig(config.vision)
    const storedEffectiveVisionConfig = buildEffectiveVisionConfig({ config, secretService, storedState })
    let visionConfig = storedEffectiveVisionConfig
    const followsChat = storedVisionConfig.mode !== 'override'
    const configSource = followsChat ? 'vision-follow-chat' : 'vision-override'
    const requestId = createRequestId()
    const startedAt = Date.now()
    const baseResult = {
      provider: visionConfig.provider,
      baseUrl: sanitizeBaseUrlForDisplay(visionConfig.baseUrl),
      model: visionConfig.model,
      hasApiKey: Boolean(secretService.getSecretValue(visionConfig.apiKeyRef))
    }
    recordLog({
      level: 'info',
      event: 'ai.vision-models.started',
      message: 'Vision provider model discovery started',
      details: {
        ...createProviderOperationDetails({
          capability: 'vision',
          operation: 'discover-models',
          config: visionConfig,
          configSource,
          requestId,
          outcome: 'started'
        }),
        requestId,
        provider: visionConfig.provider,
        model: visionConfig.model,
        endpoint: normalizeEndpointForLog(visionConfig.baseUrl)
      }
    })
    const completeDiscovery = (result, { level = result.ok ? 'info' : 'error', status = 0 } = {}) => {
      recordLog({
        level,
        event: result.ok ? 'ai.vision-models.completed' : 'ai.vision-models.failed',
        message: result.ok ? 'Vision provider model discovery completed' : 'Vision provider model discovery failed',
        details: {
          ...createProviderOperationDetails({
            capability: 'vision',
            operation: 'discover-models',
            config: visionConfig,
            configSource,
            requestId,
            outcome: result.ok ? 'completed' : 'failed'
          }),
          durationMs: Date.now() - startedAt,
          status,
          modelCount: Array.isArray(result.models) ? result.models.length : 0,
          errorCode: result.ok ? '' : result.code,
          errorMessage: result.ok ? '' : sanitizeDiagnosticText(result.message)
        }
      })
      return result
    }
    let linkedSignal = null
    try {
      visionConfig = resolveRuntimeProviderConfig(storedEffectiveVisionConfig, 'Vision')
      const apiKey = secretService.getSecretValue(visionConfig.apiKeyRef)
      if (!apiKey) {
        return completeDiscovery({
          ok: false,
          ...baseResult,
          models: [],
          code: 'missing_api_key',
          message: 'Vision API key is not configured'
        })
      }
      if (visionConfig.provider !== 'openai-compatible') {
        return completeDiscovery({
          ok: false,
          ...baseResult,
          models: [],
          code: 'unsupported_provider',
          message: 'Unsupported vision provider'
        })
      }
      if (typeof fetchImpl !== 'function') {
        return completeDiscovery({
          ok: false,
          ...baseResult,
          models: [],
          code: 'fetch_unavailable',
          message: 'Fetch is not available'
        })
      }
      let response
      linkedSignal = createLinkedAbortSignal(null, requestTimeoutMs)
      response = await raceWithLinkedAbort(fetchImpl(`${visionConfig.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: linkedSignal.signal
      }), linkedSignal)
      const status = response?.status || 'error'
      const { body } = await readJsonBody(response, linkedSignal, responseLimits.jsonBytes)
      if (!response?.ok) {
        if (isOptionalModelsProbeStatus(status)) {
          return completeDiscovery({
            ok: true,
            ...baseResult,
            models: [],
            code: 'provider_reachable_models_unavailable',
            message: 'Vision provider is reachable, but the optional /models probe is unavailable'
          }, { status })
        }
        return completeDiscovery({
          ok: false,
          ...baseResult,
          models: [],
          code: 'provider_http_error',
          message: `Vision provider request failed with status ${status}`
        }, { status })
      }
      const discoveredModels = extractDiscoveredModelIds(body, { secrets: [apiKey] })
      if (followsChat) persistModelCatalog(visionConfig, discoveredModels)
      else persistVisionModelCatalog(visionConfig, discoveredModels)
      return completeDiscovery({
        ok: true,
        ...baseResult,
        models: discoveredModels,
        code: 'ok',
        message: 'Vision provider model discovery succeeded'
      }, { status })
    } catch (error) {
      const classified = classifyConnectionError(error)
      return completeDiscovery({
        ok: false,
        ...baseResult,
        models: [],
        code: classified.code,
        message: classified.message
      })
    } finally {
      linkedSignal?.clear()
    }
  }

  return {
    getConfig,
    getEffectiveVisionConfig,
    saveConfig,
    saveApiKey,
    saveVisionApiKey,
    clearVisionApiKey,
    getConversation,
    clearConversation,
    chat,
    complete,
    completeVision,
    streamComplete,
    completeStructuredTool,
    testConnection,
    discoverModels,
    discoverVisionModels
  }
}

export {
  DEFAULT_AI_CONFIG,
  DEFAULT_MAX_CONVERSATIONS,
  DEFAULT_MAX_HISTORY_MESSAGES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CONVERSATION_ID_CHARS,
  MAX_USER_MESSAGE_CHARS,
  getBehaviorToolDefinition,
  parseNamedToolCall,
  parseChatResult,
  createAiService
}
