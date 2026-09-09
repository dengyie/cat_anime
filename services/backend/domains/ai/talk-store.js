import { createRequire } from "node:module"
const require = createRequire(import.meta.url)

const fs = require('fs')
const crypto = require('crypto')
const { writeJsonAtomic } = require('../../../../src/main/json-file-utils.js')

const SCHEMA_VERSION = 1
const DEFAULT_CONTEXT_POLICY = Object.freeze({
  maxContextMessages: 20,
  maxContextTurns: 10
})
const MESSAGE_ROLES = new Set(['user', 'assistant'])
const MAX_MESSAGE_CHARS = 8000
const MEMORY_SCOPES = new Set(['global', 'petPack'])
const MEMORY_OPERATIONS = new Set(['create', 'update', 'reinforce', 'ignore'])
const MEMORY_STATUSES = new Set(['active', 'superseded', 'deleted'])
const MAX_MEMORY_TEXT_CHARS = 500
const MAX_MEMORY_TAGS = 12
const MAX_MESSAGES_PER_CONVERSATION = 400
const MAX_EXTERNAL_CONVERSATIONS = 500
// Cap active memories so the store cannot grow without bound. Traces/utterances
// already have caps; memories did not, which made every persist() write and
// findActiveMemory() scan linearly slower over time. Pruning keeps the active
// set to the most important/confident/recent entries; the rest move into a
// bounded inactive audit history.
const MAX_ACTIVE_MEMORIES = 200
const MAX_INACTIVE_MEMORIES = 400
const MAX_MEMORY_JOBS = 200
const MAX_PET_UTTERANCE_TEXT_CHARS = 1000
const MAX_PET_UTTERANCES_PER_PACK = 100
const DEFAULT_RECENT_PET_UTTERANCE_LIMIT = 6
const DEFAULT_RECENT_PET_UTTERANCE_CHARS = 1200
const MAX_TRACE_ITEMS = 50
const DEFAULT_TRACE_LIMIT = 20
const MAX_TRACE_RECORDS = 200

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

const createEmptyState = () => ({
  schemaVersion: SCHEMA_VERSION,
  sessions: {},
  conversations: {},
  messages: {},
  personaOverrides: {},
  memories: {},
  petUtterances: {},
  memoryJobs: {},
  traces: {}
})

const clone = (value) => JSON.parse(JSON.stringify(value))

const backupCorruptStore = (storePath, now) => {
  if (!fs.existsSync(storePath)) return ''
  const suffix = String(now()).replace(/[:.]/g, '-')
  const backupPath = `${storePath}.corrupt-${suffix}`
  fs.copyFileSync(storePath, backupPath)
  return backupPath
}

const normalizeMessages = (messages) => {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => {
    if (!isPlainObject(message) || !MESSAGE_ROLES.has(message.role)) return null
    const content = typeof message.content === 'string' ? message.content.trim().slice(0, MAX_MESSAGE_CHARS) : ''
    if (!content) return null
    return {
      ...message,
      id: typeof message.id === 'string' && message.id ? message.id : '',
      role: message.role,
      content,
      createdAt: typeof message.createdAt === 'string' ? message.createdAt : ''
    }
  }).filter(Boolean)
}

const normalizePetUtterance = (utterance) => {
  if (!isPlainObject(utterance)) return null
  const text = typeof utterance.text === 'string'
    ? utterance.text.trim().replace(/\s+/g, ' ').slice(0, MAX_PET_UTTERANCE_TEXT_CHARS)
    : ''
  const petPackId = typeof utterance.petPackId === 'string' ? utterance.petPackId.trim() : ''
  if (!text || !petPackId) return null
  const ttlMs = Number(utterance.ttlMs)
  return {
    ...utterance,
    id: typeof utterance.id === 'string' && utterance.id ? utterance.id : '',
    petPackId,
    text,
    source: typeof utterance.source === 'string' ? utterance.source.trim().slice(0, 120) : '',
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? Math.round(ttlMs) : 0,
    createdAt: typeof utterance.createdAt === 'string' && utterance.createdAt ? utterance.createdAt : ''
  }
}

const normalizePetUtterances = (petUtterances) => {
  if (!isPlainObject(petUtterances)) return {}
  return Object.fromEntries(
    Object.entries(petUtterances).map(([petPackId, utterances]) => {
      const packId = typeof petPackId === 'string' ? petPackId.trim() : ''
      const normalized = (Array.isArray(utterances) ? utterances : [])
        .map((utterance) => normalizePetUtterance({ ...utterance, petPackId: utterance?.petPackId || packId }))
        .filter(Boolean)
        .slice(-MAX_PET_UTTERANCES_PER_PACK)
      return [packId, normalized]
    }).filter(([petPackId]) => Boolean(petPackId))
  )
}

const normalizeState = (value) => {
  const input = isPlainObject(value) ? value : {}
  const state = createEmptyState()
  state.schemaVersion = Number(input.schemaVersion) || SCHEMA_VERSION
  state.sessions = isPlainObject(input.sessions) ? input.sessions : {}
  state.conversations = isPlainObject(input.conversations) ? input.conversations : {}
  state.messages = isPlainObject(input.messages)
    ? Object.fromEntries(Object.entries(input.messages).map(([key, messages]) => [key, normalizeMessages(messages)]))
    : {}
  state.personaOverrides = isPlainObject(input.personaOverrides) ? input.personaOverrides : {}
  state.memories = isPlainObject(input.memories) ? input.memories : {}
  state.petUtterances = normalizePetUtterances(input.petUtterances)
  state.memoryJobs = isPlainObject(input.memoryJobs) ? input.memoryJobs : {}
  state.traces = isPlainObject(input.traces) ? input.traces : {}
  return state
}

const loadState = ({ storePath, now }) => {
  if (!fs.existsSync(storePath)) return createEmptyState()
  try {
    return normalizeState(JSON.parse(fs.readFileSync(storePath, 'utf-8')))
  } catch (_) {
    backupCorruptStore(storePath, now)
    return createEmptyState()
  }
}

const createSessionId = ({ entrypoint, petPackId }) => `${entrypoint || 'control-center'}:${petPackId || 'legacy-cat'}`

const createMessageId = ({ sessionId, conversationId }) => `${sessionId}:${conversationId}:message:${crypto.randomUUID()}`

const hashText = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex')

const normalizeMemoryTextKey = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()

const hasSensitiveMemoryText = (text) => {
  const value = String(text || '')
  return [
    /\bsk-[A-Za-z0-9_-]{12,}\b/i,
    /\bsk-cpa-[A-Za-z0-9_-]{12,}\b/i,
    /\b(api[_ -]?key|token|password|passcode|otp|one[- ]?time code)\b\s*[:=]?\s*\S{6,}/i,
    /\b\d{13,19}\b/,
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b\d{5,}\s+[\w\s]{3,}\s+(street|st\.|road|rd\.|avenue|ave\.|lane|ln\.|drive|dr\.)\b/i
  ].some((pattern) => pattern.test(value))
}

const normalizeMemoryTags = (tags) => {
  if (!Array.isArray(tags)) return []
  return Array.from(new Set(tags.map((tag) => (typeof tag === 'string' ? tag.trim() : '')).filter(Boolean))).slice(0, MAX_MEMORY_TAGS)
}

const normalizeScore = (value, fallback = 0.5) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(1, Math.max(0, number))
}

const normalizeMemoryOperation = (operation, petPackId) => {
  if (!isPlainObject(operation)) return null
  const op = typeof operation.operation === 'string' ? operation.operation.trim() : ''
  if (!MEMORY_OPERATIONS.has(op)) return null
  if (op === 'ignore') return { operation: op }
  const scope = typeof operation.scope === 'string' ? operation.scope.trim() : ''
  const text = typeof operation.text === 'string' ? operation.text.trim().replace(/\s+/g, ' ').slice(0, MAX_MEMORY_TEXT_CHARS) : ''
  if (!MEMORY_SCOPES.has(scope) || !text) return null
  return {
    operation: op,
    scope,
    petPackId: scope === 'petPack' ? petPackId : '',
    text,
    tags: normalizeMemoryTags(operation.tags),
    confidence: normalizeScore(operation.confidence),
    importance: normalizeScore(operation.importance),
    targetId: typeof operation.targetId === 'string' ? operation.targetId.trim() : '',
    reason: typeof operation.reason === 'string' ? operation.reason.trim().slice(0, 240) : ''
  }
}

const normalizePersonaOverride = (override) => {
  if (!isPlainObject(override)) return {}
  const result = {}
  for (const field of ['name', 'identity', 'tone', 'speakingStyle', 'relationshipToUser', 'actionStyle']) {
    if (typeof override[field] === 'string' && override[field].trim()) result[field] = override[field].trim()
  }
  for (const field of ['coreTraits', 'boundaries']) {
    if (Array.isArray(override[field])) {
      const values = override[field].map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      if (values.length) result[field] = values
    }
  }
  return result
}

const summarizeMessage = (message) => ({
  id: typeof message?.id === 'string' ? message.id : '',
  role: MESSAGE_ROLES.has(message?.role) ? message.role : 'user',
  contentChars: typeof message?.content === 'string' ? message.content.length : 0,
  contentSha256: hashText(message?.content || ''),
  createdAt: typeof message?.createdAt === 'string' ? message.createdAt : ''
})

const summarizeMemory = (memory) => {
  const normalized = isPlainObject(memory) ? memory : {}
  const text = typeof normalized.text === 'string' ? normalized.text : ''
  return {
    id: typeof normalized.id === 'string' ? normalized.id : '',
    scope: MEMORY_SCOPES.has(normalized.scope) ? normalized.scope : 'global',
    petPackId: typeof normalized.petPackId === 'string' ? normalized.petPackId : '',
    conversationId: typeof normalized.sourceConversationId === 'string' ? normalized.sourceConversationId : '',
    textChars: text.length,
    textSha256: hashText(text),
    tags: normalizeMemoryTags(normalized.tags),
    confidence: normalizeScore(normalized.confidence),
    importance: normalizeScore(normalized.importance),
    sourceConversationId: typeof normalized.sourceConversationId === 'string' ? normalized.sourceConversationId : '',
    sourceMessageIds: Array.isArray(normalized.sourceMessageIds) ? normalized.sourceMessageIds.filter((id) => typeof id === 'string' && id) : [],
    status: MEMORY_STATUSES.has(normalized.status) ? normalized.status : 'active',
    useCount: Math.max(0, Number(normalized.useCount) || 0),
    createdAt: typeof normalized.createdAt === 'string' ? normalized.createdAt : '',
    updatedAt: typeof normalized.updatedAt === 'string' ? normalized.updatedAt : '',
    lastUsedAt: typeof normalized.lastUsedAt === 'string' ? normalized.lastUsedAt : '',
    lastEvidenceAt: typeof normalized.lastEvidenceAt === 'string' ? normalized.lastEvidenceAt : ''
  }
}

const normalizeTraceBehavior = (behavior = {}) => {
  if (!isPlainObject(behavior)) return { providerIntent: null, finalDecision: null }
  const normalizeDecision = (decision) => {
    if (!isPlainObject(decision)) return null
    return {
      intent: typeof decision.intent === 'string' ? decision.intent.trim().slice(0, 120) : '',
      actionId: typeof decision.actionId === 'string' ? decision.actionId.trim().slice(0, 120) : '',
      confidence: Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : 0,
      matched: Boolean(decision.matched),
      type: typeof decision.type === 'string' ? decision.type.trim().slice(0, 120) : '',
      ruleId: typeof decision.ruleId === 'string' ? decision.ruleId.trim().slice(0, 120) : '',
      reason: typeof decision.reason === 'string' ? decision.reason.trim().slice(0, 240) : '',
      displayMode: typeof decision.displayMode === 'string' ? decision.displayMode.trim().slice(0, 40) : ''
    }
  }
  return {
    providerIntent: normalizeDecision(behavior.providerIntent),
    finalDecision: normalizeDecision(behavior.finalDecision)
  }
}

const normalizeTraceEntry = (trace = {}) => {
  if (!isPlainObject(trace)) return null
  const id = typeof trace.id === 'string' ? trace.id.trim() : ''
  if (!id) return null
  const explicitType = typeof trace.type === 'string' && trace.type.trim() ? trace.type.trim() : ''
  const inferredType = explicitType || (Array.isArray(trace.filteredMemoryCandidates) ? 'ai-talk-memory-filter' : 'ai-talk-chat')
  return {
    id,
    type: inferredType,
    petPackId: typeof trace.petPackId === 'string' ? trace.petPackId.trim() : '',
    conversationId: typeof trace.conversationId === 'string' ? trace.conversationId.trim() : '',
    personaHash: typeof trace.personaHash === 'string' ? trace.personaHash.trim() : '',
    provider: typeof trace.provider === 'string' ? trace.provider.trim() : '',
    baseUrl: typeof trace.baseUrl === 'string' ? trace.baseUrl.trim() : '',
    model: typeof trace.model === 'string' ? trace.model.trim() : '',
    entrypoint: typeof trace.entrypoint === 'string' ? trace.entrypoint.trim() : '',
    historyCount: Math.max(0, Number(trace.historyCount) || 0),
    messagesCount: Math.max(0, Number(trace.messagesCount) || 0),
    messageChars: Math.max(0, Number(trace.messageChars) || 0),
    memoryContextCount: Math.max(0, Number(trace.memoryContextCount) || 0),
    memoryIdsInjected: Array.isArray(trace.memoryIdsInjected)
      ? trace.memoryIdsInjected.filter((memoryId) => typeof memoryId === 'string' && memoryId.trim())
      : [],
    recentPetActivityCount: Math.max(0, Number(trace.recentPetActivityCount) || 0),
    toolsCount: Math.max(0, Number(trace.toolsCount) || 0),
    streaming: trace.streaming === true,
    status: typeof trace.status === 'string' && trace.status.trim()
      ? trace.status.trim().slice(0, 40)
      : (trace.success === false ? 'failed' : 'completed'),
    chunkCount: Math.max(0, Number(trace.chunkCount) || 0),
    partialReplyChars: Math.max(0, Number(trace.partialReplyChars) || 0),
    elapsedMs: Math.max(0, Number(trace.elapsedMs) || 0),
    providerLatencyMs: Math.max(0, Number(trace.providerLatencyMs) || 0),
    finishReason: typeof trace.finishReason === 'string' ? trace.finishReason.trim().slice(0, 120) : '',
    cancelReason: typeof trace.cancelReason === 'string' ? trace.cancelReason.trim().slice(0, 120) : '',
    memoryExtractionScheduled: trace.memoryExtractionScheduled === true,
    behaviorDecisionScheduled: trace.behaviorDecisionScheduled === true,
    replyChars: Math.max(0, Number(trace.replyChars) || 0),
    bubbleSegmentCount: Math.max(0, Number(trace.bubbleSegmentCount) || 0),
    hasBehaviorIntent: Boolean(trace.hasBehaviorIntent),
    behaviorIntentIntent: typeof trace.behaviorIntentIntent === 'string' ? trace.behaviorIntentIntent.trim().slice(0, 120) : '',
    behaviorIntentDisplayMode: typeof trace.behaviorIntentDisplayMode === 'string' ? trace.behaviorIntentDisplayMode.trim().slice(0, 40) : '',
    behavior: normalizeTraceBehavior(trace.behavior),
    memoryJobId: typeof trace.memoryJobId === 'string' ? trace.memoryJobId.trim() : '',
    persistedMessageCount: Math.max(0, Number(trace.persistedMessageCount) || 0),
    displayMode: typeof trace.displayMode === 'string' ? trace.displayMode.trim().slice(0, 40) : '',
    errorCode: typeof trace.errorCode === 'string' ? trace.errorCode.trim().slice(0, 120) : '',
    providerStatus: Math.max(0, Number(trace.providerStatus) || 0),
    success: trace.success !== false,
    requestId: typeof trace.requestId === 'string' ? trace.requestId.trim().slice(0, 120) : '',
    createdAt: typeof trace.createdAt === 'string' && trace.createdAt ? trace.createdAt : '',
    updatedAt: typeof trace.updatedAt === 'string' && trace.updatedAt ? trace.updatedAt : '',
    filteredMemoryCandidates: Array.isArray(trace.filteredMemoryCandidates)
      ? trace.filteredMemoryCandidates
        .map((candidate) => ({
          operation: typeof candidate?.operation === 'string' ? candidate.operation.trim().slice(0, 120) : '',
          scope: typeof candidate?.scope === 'string' ? candidate.scope.trim().slice(0, 120) : '',
          reason: typeof candidate?.reason === 'string' ? candidate.reason.trim().slice(0, 120) : ''
        }))
        .filter((candidate) => candidate.operation || candidate.scope || candidate.reason)
      : []
  }
}

const createAiTalkStore = ({ storePath, repository = null, now = () => new Date().toISOString() } = {}) => {
  if (!repository && !storePath) throw new Error('storePath or repository is required')
  if (repository && (typeof repository.loadState !== 'function' || typeof repository.commitState !== 'function')) throw new TypeError('AI repository requires loadState and commitState')
  let state = repository ? normalizeState(repository.loadState()) : loadState({ storePath, now })
  let committedState = clone(state)

  const recoverOrphanedMemoryJobs = () => {
    const timestamp = now()
    let interruptedCount = 0
    for (const [id, job] of Object.entries(state.memoryJobs || {})) {
      if (job?.status !== 'pending') continue
      state.memoryJobs[id] = {
        ...job,
        status: 'interrupted',
        errorCode: 'process_restarted',
        updatedAt: timestamp
      }
      interruptedCount += 1
    }
    return interruptedCount
  }

  const recoveredMemoryJobCount = recoverOrphanedMemoryJobs()

  const pruneConversationMessages = () => {
    let removedCount = 0
    for (const [conversationKey, messages] of Object.entries(state.messages || {})) {
      const normalized = normalizeMessages(messages)
      const retained = normalized.slice(-MAX_MESSAGES_PER_CONVERSATION)
      removedCount += Math.max(0, normalized.length - retained.length)
      state.messages[conversationKey] = retained
    }
    return removedCount
  }

  const pruneExternalConversations = () => {
    const external = Object.entries(state.conversations || {})
      .map(([key, conversation], order) => ({ key, conversation, order }))
      .filter(({ conversation }) => conversation?.id !== 'main')
      .sort((left, right) => {
        const leftTime = String(left.conversation?.updatedAt || left.conversation?.createdAt || '')
        const rightTime = String(right.conversation?.updatedAt || right.conversation?.createdAt || '')
        const timeOrder = leftTime.localeCompare(rightTime)
        return timeOrder !== 0 ? timeOrder : left.order - right.order
      })
    const overflow = external.slice(0, Math.max(0, external.length - MAX_EXTERNAL_CONVERSATIONS))
    if (!overflow.length) return 0

    for (const { key } of overflow) {
      delete state.conversations[key]
      delete state.messages[key]
    }
    for (const [sessionId, session] of Object.entries(state.sessions || {})) {
      const activeKey = `${sessionId}:${session?.activeConversationId || ''}`
      if (state.conversations[activeKey]) continue
      const candidates = Object.values(state.conversations)
        .filter((conversation) => conversation?.sessionId === sessionId)
        .sort((left, right) => {
          if (left.id === 'main' && right.id !== 'main') return -1
          if (right.id === 'main' && left.id !== 'main') return 1
          return String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''))
        })
      state.sessions[sessionId] = {
        ...session,
        activeConversationId: candidates[0]?.id || ''
      }
    }
    return overflow.length
  }

  const pruneMemoryJobs = () => {
    const entries = Object.entries(state.memoryJobs || {}).map(([id, job], order) => ({ id, job, order }))
    if (entries.length <= MAX_MEMORY_JOBS) return 0
    entries.sort((left, right) => {
      const leftPending = left.job?.status === 'pending'
      const rightPending = right.job?.status === 'pending'
      if (leftPending !== rightPending) return leftPending ? -1 : 1
      const updatedOrder = String(right.job?.updatedAt || '').localeCompare(String(left.job?.updatedAt || ''))
      if (updatedOrder !== 0) return updatedOrder
      const createdOrder = String(right.job?.createdAt || '').localeCompare(String(left.job?.createdAt || ''))
      if (createdOrder !== 0) return createdOrder
      return right.order - left.order
    })
    state.memoryJobs = Object.fromEntries(entries.slice(0, MAX_MEMORY_JOBS).map(({ id, job }) => [id, job]))
    return entries.length - MAX_MEMORY_JOBS
  }

  const prunedMessageCount = pruneConversationMessages()
  const prunedExternalConversationCount = pruneExternalConversations()
  const prunedMemoryJobCount = pruneMemoryJobs()

  // The store is synchronous within one backend process. The repository diffs
  // records inside a transaction; failed commits must also roll back this view.
  const persist = (changes) => {
    try {
      if (changes && typeof repository?.commitChanges === 'function') {
        repository.commitChanges(state, changes)
        for (const [collection, keys] of Object.entries(changes)) {
          if (keys === null) committedState[collection] = clone(state[collection])
          else for (const key of keys) {
            if (Object.hasOwn(state[collection], key)) committedState[collection][key] = clone(state[collection][key])
            else delete committedState[collection][key]
          }
        }
      } else {
        if (repository) repository.commitState(state)
        else writeJsonAtomic(storePath, state)
        committedState = clone(state)
      }
    } catch (error) {
      state = clone(committedState)
      rebuildActiveMemoryIndexes()
      throw error
    }
  }

  const getState = () => clone(state)

  const getProviderConversations = () => Object.fromEntries(
    Object.values(state.conversations)
      .filter((conversation) => conversation.sessionId === 'legacy:global')
      .map((conversation) => [conversation.id, clone(state.messages[`legacy:global:${conversation.id}`] || [])])
  )

  const replaceProviderConversations = (conversations = {}, { importOnly = false } = {}) => {
    const sessionId = 'legacy:global'
    if (importOnly && state.sessions[sessionId]) return false
    const timestamp = now()
    state.sessions[sessionId] ||= { id: sessionId, entrypoint: 'legacy', petPackId: 'global', createdAt: timestamp, updatedAt: timestamp }
    for (const [key, conversation] of Object.entries(state.conversations)) {
      if (conversation.sessionId !== sessionId) continue
      if (!Object.hasOwn(conversations, conversation.id)) {
        delete state.conversations[key]
        delete state.messages[key]
      }
    }
    for (const [id, messages] of Object.entries(conversations)) {
      const key = `${sessionId}:${id}`
      state.conversations[key] = { ...state.conversations[key], id, sessionId, entrypoint: 'legacy', petPackId: 'global', createdAt: state.conversations[key]?.createdAt || timestamp, updatedAt: timestamp }
      state.messages[key] = normalizeMessages(messages)
    }
    persist()
    return true
  }

  const clearConversation = (key) => {
    if (!Object.hasOwn(state.conversations, key)) return false
    state.messages[key] = []
    state.conversations[key] = { ...state.conversations[key], updatedAt: now() }
    persist({ conversations: [key], messages: [key] })
    return true
  }

  const ensureConversation = ({
    entrypoint = 'control-center',
    petPackId,
    conversationId = 'main',
    personaHash = ''
  } = {}) => {
    if (!petPackId || typeof petPackId !== 'string') throw new Error('petPackId is required')
    const timestamp = now()
    const sessionId = createSessionId({ entrypoint, petPackId })
    const normalizedConversationId = typeof conversationId === 'string' && conversationId.trim()
      ? conversationId.trim()
      : 'main'
    const conversationKey = `${sessionId}:${normalizedConversationId}`
    if (!state.sessions[sessionId]) {
      state.sessions[sessionId] = {
        id: sessionId,
        entrypoint,
        petPackId,
        activeConversationId: normalizedConversationId,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
    const created = !state.conversations[conversationKey]
    if (created) {
      state.conversations[conversationKey] = {
        id: normalizedConversationId,
        sessionId,
        petPackId,
        title: '',
        personaPackId: petPackId,
        personaHash: personaHash || '',
        responseMode: 'complete',
        summary: '',
        summaryUpdatedAt: '',
        contextPolicy: { ...DEFAULT_CONTEXT_POLICY },
        createdAt: timestamp,
        updatedAt: timestamp
      }
      state.messages[conversationKey] = []
    } else if (personaHash && state.conversations[conversationKey].personaHash !== personaHash) {
      state.conversations[conversationKey] = {
        ...state.conversations[conversationKey],
        personaHash,
        updatedAt: timestamp
      }
    }
    state.sessions[sessionId] = {
      ...state.sessions[sessionId],
      activeConversationId: normalizedConversationId,
      updatedAt: timestamp
    }
    if (created) pruneExternalConversations()
    persist(created ? undefined : { sessions: [sessionId], conversations: [conversationKey] })
    return {
      sessionId,
      conversationId: normalizedConversationId,
      conversation: clone(state.conversations[conversationKey])
    }
  }

  const ensureMainConversation = (input = {}) => ensureConversation({ ...input, conversationId: 'main' })

  const getMessages = (sessionId, conversationId = 'main') => {
    return clone(state.messages[`${sessionId}:${conversationId}`] || [])
  }

  const appendMessages = (sessionId, conversationId = 'main', messages = []) => {
    const conversationKey = `${sessionId}:${conversationId}`
    if (!state.conversations[conversationKey]) throw new Error(`AI talk conversation does not exist: ${conversationKey}`)
    const timestamp = now()
    const current = state.messages[conversationKey] || []
    const normalized = normalizeMessages(messages).map((message) => ({
      ...message,
      id: message.id || createMessageId({ sessionId, conversationId }),
      createdAt: message.createdAt || timestamp
    }))
    state.messages[conversationKey] = [...current, ...normalized].slice(-MAX_MESSAGES_PER_CONVERSATION)
    state.conversations[conversationKey] = {
      ...state.conversations[conversationKey],
      updatedAt: timestamp
    }
    persist({ conversations: [conversationKey], messages: [conversationKey] })
    return getMessages(sessionId, conversationId)
  }

  const importMessagesIfEmpty = (sessionId, conversationId = 'main', messages = []) => {
    const conversationKey = `${sessionId}:${conversationId}`
    if (!state.conversations[conversationKey]) throw new Error(`AI talk conversation does not exist: ${conversationKey}`)
    const current = state.messages[conversationKey] || []
    if (current.length) return []
    const timestamp = now()
    const normalized = normalizeMessages(messages).map((message) => ({
      ...message,
      id: message.id || createMessageId({ sessionId, conversationId }),
      createdAt: message.createdAt || timestamp
    }))
    if (!normalized.length) return []
    state.messages[conversationKey] = normalized.slice(-MAX_MESSAGES_PER_CONVERSATION)
    state.conversations[conversationKey] = {
      ...state.conversations[conversationKey],
      updatedAt: timestamp
    }
    persist({ conversations: [conversationKey], messages: [conversationKey] })
    return getMessages(sessionId, conversationId)
  }

  const getPersonaOverride = (petPackId) => {
    const key = typeof petPackId === 'string' ? petPackId.trim() : ''
    if (!key) return {}
    return clone(normalizePersonaOverride(state.personaOverrides[key]))
  }

  const savePersonaOverride = (petPackId, override = {}) => {
    const key = typeof petPackId === 'string' ? petPackId.trim() : ''
    if (!key) throw new Error('petPackId is required')
    const normalized = normalizePersonaOverride(override)
    if (Object.keys(normalized).length) state.personaOverrides[key] = normalized
    else delete state.personaOverrides[key]
    persist({ personaOverrides: [key] })
    return getPersonaOverride(key)
  }

  const createMemoryId = () => `memory:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
  const createTraceId = () => `trace:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
  const createPetUtteranceId = () => `pet-utterance:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`

  const recordPetUtterance = (utterance = {}) => {
    const timestamp = now()
    const normalized = normalizePetUtterance({
      ...utterance,
      id: typeof utterance.id === 'string' && utterance.id ? utterance.id : createPetUtteranceId(),
      createdAt: typeof utterance.createdAt === 'string' && utterance.createdAt ? utterance.createdAt : timestamp
    })
    if (!normalized) throw new Error('Valid pet utterance text and petPackId are required')
    const current = Array.isArray(state.petUtterances[normalized.petPackId])
      ? state.petUtterances[normalized.petPackId]
      : []
    state.petUtterances[normalized.petPackId] = [...current, normalized].slice(-MAX_PET_UTTERANCES_PER_PACK)
    persist({ petUtterances: [normalized.petPackId] })
    return clone(normalized)
  }

  const listRecentPetUtterances = ({ petPackId, limit = DEFAULT_RECENT_PET_UTTERANCE_LIMIT, maxChars = DEFAULT_RECENT_PET_UTTERANCE_CHARS } = {}) => {
    const packId = typeof petPackId === 'string' ? petPackId.trim() : ''
    if (!packId) return []
    const max = Math.max(0, Number(limit) || 0)
    const charBudget = Math.max(0, Number(maxChars) || 0)
    const utterances = Array.isArray(state.petUtterances[packId])
      ? state.petUtterances[packId].map(normalizePetUtterance).filter(Boolean)
      : []
    const selected = []
    let usedChars = 0
    for (const utterance of utterances.slice().reverse()) {
      if (max && selected.length >= max) break
      const nextChars = usedChars + utterance.text.length
      if (charBudget && selected.length > 0 && nextChars > charBudget) break
      selected.push(utterance)
      usedChars = nextChars
      if (charBudget && usedChars >= charBudget) break
    }
    return clone(selected.reverse())
  }

  const clearPetUtterances = (petPackId) => {
    const packId = typeof petPackId === 'string' ? petPackId.trim() : ''
    if (!packId) throw new Error('petPackId is required')
    const deletedCount = Array.isArray(state.petUtterances[packId]) ? state.petUtterances[packId].length : 0
    delete state.petUtterances[packId]
    if (deletedCount > 0) persist()
    return { petPackId: packId, deletedCount }
  }

  const normalizeExistingMemory = (memory) => ({
    ...memory,
    id: typeof memory?.id === 'string' && memory.id ? memory.id : createMemoryId(),
    scope: MEMORY_SCOPES.has(memory?.scope) ? memory.scope : 'global',
    petPackId: typeof memory?.petPackId === 'string' ? memory.petPackId : '',
    text: typeof memory?.text === 'string' ? memory.text.trim().slice(0, MAX_MEMORY_TEXT_CHARS) : '',
    tags: normalizeMemoryTags(memory?.tags),
    confidence: normalizeScore(memory?.confidence),
    importance: normalizeScore(memory?.importance),
    sourceConversationId: typeof memory?.sourceConversationId === 'string' ? memory.sourceConversationId : '',
    sourceMessageIds: Array.isArray(memory?.sourceMessageIds) ? memory.sourceMessageIds.filter((id) => typeof id === 'string' && id) : [],
    createdAt: typeof memory?.createdAt === 'string' && memory.createdAt ? memory.createdAt : now(),
    updatedAt: typeof memory?.updatedAt === 'string' && memory.updatedAt ? memory.updatedAt : now(),
    lastUsedAt: typeof memory?.lastUsedAt === 'string' ? memory.lastUsedAt : '',
    lastEvidenceAt: typeof memory?.lastEvidenceAt === 'string' ? memory.lastEvidenceAt : '',
    useCount: Math.max(0, Number(memory?.useCount) || 0),
    status: MEMORY_STATUSES.has(memory?.status) ? memory.status : 'active',
    supersedes: typeof memory?.supersedes === 'string' ? memory.supersedes : '',
    reason: typeof memory?.reason === 'string' ? memory.reason : ''
  })

  let activeMemoryIds = new Set()
  let activeMemoryKeyIndex = new Map()

  const createActiveMemoryKey = (memory) => [
    memory.scope,
    memory.scope === 'petPack' ? memory.petPackId : '',
    normalizeMemoryTextKey(memory.text)
  ].join('\u0000')

  const removeMemoryFromActiveIndexes = (memory) => {
    if (memory?.status !== 'active' || !memory.id) return
    activeMemoryIds.delete(memory.id)
    const key = createActiveMemoryKey(memory)
    if (activeMemoryKeyIndex.get(key) !== memory.id) return
    activeMemoryKeyIndex.delete(key)
    for (const candidateId of activeMemoryIds) {
      const candidate = state.memories[candidateId]
      if (candidate?.status === 'active' && createActiveMemoryKey(candidate) === key) {
        activeMemoryKeyIndex.set(key, candidateId)
        break
      }
    }
  }

  const addMemoryToActiveIndexes = (memory) => {
    if (memory?.status !== 'active' || !memory.id) return
    activeMemoryIds.add(memory.id)
    activeMemoryKeyIndex.set(createActiveMemoryKey(memory), memory.id)
  }

  const setMemory = (memoryId, memory) => {
    const id = typeof memoryId === 'string' && memoryId ? memoryId : memory?.id
    if (!id) return null
    const current = state.memories[id] ? normalizeExistingMemory(state.memories[id]) : null
    removeMemoryFromActiveIndexes(current)
    const normalized = normalizeExistingMemory({ ...memory, id })
    state.memories[id] = normalized
    addMemoryToActiveIndexes(normalized)
    return normalized
  }

  const rebuildActiveMemoryIndexes = () => {
    activeMemoryIds = new Set()
    activeMemoryKeyIndex = new Map()
    for (const [id, candidate] of Object.entries(state.memories || {})) {
      const memory = normalizeExistingMemory({ ...candidate, id: candidate?.id || id })
      state.memories[id] = memory
      addMemoryToActiveIndexes(memory)
    }
  }

  const findActiveMemory = (memory) => {
    const memoryId = activeMemoryKeyIndex.get(createActiveMemoryKey(memory))
    return memoryId ? state.memories[memoryId] : undefined
  }

  // Keep the active memory set bounded. When it exceeds MAX_ACTIVE_MEMORIES,
  // demote the lowest-value entries (importance + confidence, then recency) to
  // 'superseded' before bounded inactive-history pruning. Active lookup remains
  // O(active) instead of growing with all-time history.
  const pruneActiveMemories = () => {
    const activeIds = Array.from(activeMemoryIds)
    if (activeIds.length <= MAX_ACTIVE_MEMORIES) return 0
    const ranked = activeIds
      .map((id) => {
        const m = state.memories[id]
        return { id, score: Number(m.importance || 0) + Number(m.confidence || 0), updatedAt: String(m.updatedAt || '') }
      })
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score
        return a.updatedAt.localeCompare(b.updatedAt)
      })
    const demoteCount = activeIds.length - MAX_ACTIVE_MEMORIES
    const timestamp = now()
    for (let i = 0; i < demoteCount; i += 1) {
      const id = ranked[i].id
      setMemory(id, { ...state.memories[id], status: 'superseded', updatedAt: timestamp })
    }
    return demoteCount
  }

  const pruneInactiveMemories = () => {
    const inactive = Object.entries(state.memories || {})
      .filter(([, memory]) => memory?.status !== 'active')
      .map(([id, memory], order) => ({ id, memory, order }))
      .sort((left, right) => {
        const updatedOrder = String(right.memory?.updatedAt || '').localeCompare(String(left.memory?.updatedAt || ''))
        if (updatedOrder !== 0) return updatedOrder
        return right.order - left.order
      })
    if (inactive.length <= MAX_INACTIVE_MEMORIES) return 0
    for (const { id } of inactive.slice(MAX_INACTIVE_MEMORIES)) delete state.memories[id]
    return inactive.length - MAX_INACTIVE_MEMORIES
  }

  rebuildActiveMemoryIndexes()
  const prunedActiveMemoryCount = pruneActiveMemories()
  const prunedInactiveMemoryCount = pruneInactiveMemories()
  if (
    recoveredMemoryJobCount > 0 ||
    prunedMessageCount > 0 ||
    prunedExternalConversationCount > 0 ||
    prunedMemoryJobCount > 0 ||
    prunedActiveMemoryCount > 0 ||
    prunedInactiveMemoryCount > 0
  ) persist()

  const applyMemoryOperations = ({ petPackId, conversationId = '', messageIds = [], operations = [] } = {}) => {
    const packId = typeof petPackId === 'string' ? petPackId.trim() : ''
    if (!packId) throw new Error('petPackId is required')
    const timestamp = now()
    const applied = []
    const filtered = []
    for (const candidate of operations) {
      const memory = normalizeMemoryOperation(candidate, packId)
      if (!memory || memory.operation === 'ignore') continue
      if (hasSensitiveMemoryText(memory.text)) {
        filtered.push({ operation: memory.operation, scope: memory.scope, reason: 'sensitive' })
        continue
      }
      const existing = memory.targetId ? state.memories[memory.targetId] : findActiveMemory(memory)
      if (existing?.status === 'active') {
        const next = normalizeExistingMemory({
          ...existing,
          text: memory.operation === 'update' ? memory.text : existing.text,
          tags: Array.from(new Set([...(existing.tags || []), ...memory.tags])).slice(0, MAX_MEMORY_TAGS),
          confidence: Math.max(normalizeScore(existing.confidence), memory.confidence),
          importance: Math.max(normalizeScore(existing.importance), memory.importance),
          sourceMessageIds: Array.from(new Set([...(existing.sourceMessageIds || []), ...messageIds])),
          updatedAt: timestamp,
          lastEvidenceAt: timestamp,
          useCount: memory.operation === 'reinforce' ? Math.max(0, Number(existing.useCount) || 0) + 1 : Math.max(0, Number(existing.useCount) || 0),
          reason: memory.reason || existing.reason
        })
        setMemory(next.id, next)
        applied.push({ id: next.id, operation: memory.operation, scope: next.scope })
        continue
      }
      const id = createMemoryId()
      setMemory(id, {
        id,
        scope: memory.scope,
        petPackId: memory.scope === 'petPack' ? packId : '',
        text: memory.text,
        tags: memory.tags,
        confidence: memory.confidence,
        importance: memory.importance,
        sourceConversationId: conversationId,
        sourceMessageIds: messageIds,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastEvidenceAt: timestamp,
        status: 'active',
        reason: memory.reason
      })
      applied.push({ id, operation: 'create', scope: memory.scope })
    }
    if (filtered.length) {
      const traceId = createTraceId()
      state.traces[traceId] = {
        id: traceId,
        type: 'ai-talk-memory-filter',
        petPackId: packId,
        conversationId,
        filteredMemoryCandidates: filtered,
        createdAt: timestamp
      }
    }
    pruneActiveMemories()
    pruneInactiveMemories()
    persist({ memories: null })
    return { applied, filtered }
  }

  const listMemories = ({ petPackId, scope = '', limit = 8 } = {}) => {
    const packId = typeof petPackId === 'string' ? petPackId.trim() : ''
    const scopeFilter = MEMORY_SCOPES.has(scope) ? scope : ''
    const max = Math.max(0, Number(limit) || 0)
    const memories = Array.from(activeMemoryIds)
      .map((id) => state.memories[id])
      .filter(Boolean)
      .filter((memory) => (
        (!scopeFilter || memory.scope === scopeFilter) &&
        (memory.scope === 'global' || (memory.scope === 'petPack' && memory.petPackId === packId))
      ))
      .sort((a, b) => {
        const scoreA = a.importance + a.confidence
        const scoreB = b.importance + b.confidence
        if (scoreA !== scoreB) return scoreB - scoreA
        return String(b.updatedAt).localeCompare(String(a.updatedAt))
      })
    return clone(max ? memories.slice(0, max) : memories)
  }

  const markMemoriesUsed = (memoryIds = []) => {
    if (!Array.isArray(memoryIds)) return { updatedCount: 0, memories: [] }
    const timestamp = now()
    const ids = Array.from(new Set(memoryIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)))
    const updated = []
    for (const id of ids) {
      if (!state.memories[id]) continue
      const memory = normalizeExistingMemory(state.memories[id])
      if (!memory.id || memory.status !== 'active') continue
      const next = normalizeExistingMemory({
        ...memory,
        lastUsedAt: timestamp,
        updatedAt: timestamp,
        useCount: Math.max(0, Number(memory.useCount) || 0) + 1
      })
      setMemory(id, next)
      updated.push(next)
    }
    if (updated.length) persist()
    return { updatedCount: updated.length, memories: clone(updated) }
  }

  const deleteMemory = (memoryId) => {
    const id = typeof memoryId === 'string' ? memoryId.trim() : ''
    if (!id || !state.memories[id]) return null
    setMemory(id, {
      ...state.memories[id],
      status: 'deleted',
      updatedAt: now()
    })
    pruneInactiveMemories()
    persist()
    return clone(state.memories[id])
  }

  const clearPetPackMemories = (petPackId) => {
    const packId = typeof petPackId === 'string' ? petPackId.trim() : ''
    if (!packId) throw new Error('petPackId is required')
    const timestamp = now()
    let deletedCount = 0
    for (const id of Array.from(activeMemoryIds)) {
      const memory = state.memories[id]
      if (memory?.scope !== 'petPack' || memory.petPackId !== packId) continue
      setMemory(id, {
        ...memory,
        status: 'deleted',
        updatedAt: timestamp
      })
      deletedCount += 1
    }
    if (deletedCount > 0) {
      pruneInactiveMemories()
      persist()
    }
    return { petPackId: packId, deletedCount }
  }

  const createMemoryJob = ({ petPackId, conversationId } = {}) => {
    const id = `memory-job:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
    state.memoryJobs[id] = {
      id,
      petPackId: typeof petPackId === 'string' ? petPackId : '',
      conversationId: typeof conversationId === 'string' ? conversationId : '',
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
      errorCode: ''
    }
    pruneMemoryJobs()
    persist({ memoryJobs: null })
    return state.memoryJobs[id] ? clone(state.memoryJobs[id]) : null
  }

  const finishMemoryJob = (jobId, patch = {}) => {
    if (!jobId || !state.memoryJobs[jobId]) return null
    if (state.memoryJobs[jobId].status !== 'pending') return clone(state.memoryJobs[jobId])
    state.memoryJobs[jobId] = {
      ...state.memoryJobs[jobId],
      status: typeof patch.status === 'string' ? patch.status : state.memoryJobs[jobId].status,
      errorCode: typeof patch.errorCode === 'string' ? patch.errorCode : '',
      appliedCount: Number.isFinite(Number(patch.appliedCount)) ? Number(patch.appliedCount) : state.memoryJobs[jobId].appliedCount,
      filteredCount: Number.isFinite(Number(patch.filteredCount)) ? Number(patch.filteredCount) : state.memoryJobs[jobId].filteredCount,
      updatedAt: now()
    }
    pruneMemoryJobs()
    persist({ memoryJobs: [jobId] })
    return state.memoryJobs[jobId] ? clone(state.memoryJobs[jobId]) : null
  }

  const interruptPendingMemoryJobs = (errorCode = 'shutdown_interrupted') => {
    const normalizedErrorCode = typeof errorCode === 'string' && errorCode.trim()
      ? errorCode.trim().slice(0, 120)
      : 'shutdown_interrupted'
    const timestamp = now()
    let interruptedCount = 0
    for (const [id, job] of Object.entries(state.memoryJobs || {})) {
      if (job?.status !== 'pending') continue
      state.memoryJobs[id] = {
        ...job,
        status: 'interrupted',
        errorCode: normalizedErrorCode,
        updatedAt: timestamp
      }
      interruptedCount += 1
    }
    if (interruptedCount > 0) {
      pruneMemoryJobs()
      persist()
    }
    return { interruptedCount }
  }

  const pruneTraces = () => {
    const traceEntries = Object.entries(state.traces || {})
      .map(([traceId, trace]) => [traceId, normalizeTraceEntry(trace)])
      .filter(([, trace]) => trace)
      .sort((a, b) => String(b[1].createdAt || '').localeCompare(String(a[1].createdAt || '')))
    const kept = traceEntries.slice(0, MAX_TRACE_RECORDS)
    state.traces = Object.fromEntries(kept)
  }

  const recordTrace = (trace = {}) => {
    const normalized = normalizeTraceEntry({
      ...trace,
      id: typeof trace.id === 'string' && trace.id.trim() ? trace.id.trim() : createTraceId(),
      createdAt: typeof trace.createdAt === 'string' && trace.createdAt ? trace.createdAt : now()
    })
    if (!normalized) throw new Error('Valid AI talk trace is required')
    state.traces[normalized.id] = normalized
    pruneTraces()
    persist()
    return clone(normalized)
  }

  const listTraces = ({ petPackId = '', type = 'ai-talk-chat', limit = DEFAULT_TRACE_LIMIT } = {}) => {
    const packId = typeof petPackId === 'string' ? petPackId.trim() : ''
    const typeFilter = typeof type === 'string' ? type.trim() : ''
    const max = Math.max(0, Number(limit) || 0)
    const traces = Object.values(state.traces || {})
      .map(normalizeTraceEntry)
      .filter(Boolean)
      .filter((trace) => !typeFilter || trace.type === typeFilter)
      .filter((trace) => !packId || trace.petPackId === packId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    return clone(max ? traces.slice(0, max) : traces)
  }

  const createTraceView = (trace) => {
    const normalized = normalizeTraceEntry(trace)
    if (!normalized) return null
    const injected = normalized.memoryIdsInjected
      .map((memoryId) => summarizeMemory(state.memories[memoryId]))
      .filter((memory) => memory.id)
    const providerIntent = normalized.behavior.providerIntent || (
      normalized.hasBehaviorIntent
        ? {
            intent: normalized.behaviorIntentIntent,
            actionId: '',
            confidence: 0,
            matched: false,
            type: '',
            ruleId: '',
            reason: '',
            displayMode: normalized.behaviorIntentDisplayMode
          }
        : null
    )
    return {
      ...normalized,
      updatedAt: normalized.updatedAt || normalized.createdAt,
      conversation: {
        conversationId: normalized.conversationId,
        petPackId: normalized.petPackId,
        petPackDisplayName: normalized.petPackId
      },
      provider: {
        provider: normalized.provider,
        baseUrl: normalized.baseUrl,
        model: normalized.model
      },
      request: {
        entrypoint: normalized.entrypoint,
        historyCount: normalized.historyCount,
        messagesCount: normalized.messagesCount,
        messageChars: normalized.messageChars,
        toolsCount: normalized.toolsCount,
        recentPetActivityCount: normalized.recentPetActivityCount
      },
      memory: {
        injected,
        used: injected
      },
      behavior: {
        providerIntent,
        finalDecision: normalized.behavior.finalDecision
      },
      result: {
        streaming: normalized.streaming,
        status: normalized.status,
        chunkCount: normalized.chunkCount,
        partialReplyChars: normalized.partialReplyChars,
        elapsedMs: normalized.elapsedMs,
        providerLatencyMs: normalized.providerLatencyMs,
        finishReason: normalized.finishReason,
        cancelReason: normalized.cancelReason,
        memoryExtractionScheduled: normalized.memoryExtractionScheduled,
        behaviorDecisionScheduled: normalized.behaviorDecisionScheduled,
        replyChars: normalized.replyChars,
        persistedMessageCount: normalized.persistedMessageCount,
        bubbleSegmentCount: normalized.bubbleSegmentCount,
        displayMode: normalized.displayMode || normalized.behaviorIntentDisplayMode || ''
      }
    }
  }

  const getLatestTraceByConversation = (conversationId = '') => {
    const normalizedConversationId = typeof conversationId === 'string' ? conversationId.trim() : ''
    const traces = Object.values(state.traces || {})
      .map(normalizeTraceEntry)
      .filter(Boolean)
      .filter((trace) => trace.type === 'ai-talk-chat')
      .filter((trace) => !normalizedConversationId || trace.conversationId === normalizedConversationId)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    return createTraceView(traces[0])
  }

  const updateTrace = ({ conversationId = '', traceId = '', patch = {} } = {}) => {
    const targetTrace = traceId
      ? normalizeTraceEntry(state.traces[traceId])
      : getLatestTraceByConversation(conversationId)
    if (!targetTrace?.id || !state.traces[targetTrace.id]) return null
    const current = normalizeTraceEntry(state.traces[targetTrace.id])
    const next = normalizeTraceEntry({
      ...current,
      ...patch,
      behavior: {
        ...current.behavior,
        ...(isPlainObject(patch.behavior) ? patch.behavior : {})
      },
      updatedAt: now()
    })
    if (!next) return null
    state.traces[next.id] = next
    persist({ traces: [next.id] })
    return createTraceView(next)
  }

  const migrateLegacyConversation = ({
    entrypoint = 'control-center',
    petPackId = 'legacy-cat',
    personaHash = '',
    messages = []
  } = {}) => {
    const normalizedMessages = normalizeMessages(messages)
    if (!normalizedMessages.length) {
      return { migrated: false, skipped: true, reason: 'no legacy messages', messageCount: 0 }
    }
    const { sessionId, conversationId } = ensureMainConversation({ entrypoint, petPackId, personaHash })
    const conversationKey = `${sessionId}:${conversationId}`
    const current = state.messages[conversationKey] || []
    if (current.length > 0) {
      return {
        migrated: false,
        skipped: true,
        reason: 'target conversation already has messages',
        sessionId,
        conversationId,
        messageCount: current.length
      }
    }
    const timestamp = now()
    state.messages[conversationKey] = normalizedMessages.map((message, index) => ({
      ...message,
      id: message.id || createMessageId({ sessionId, conversationId, index }),
      createdAt: message.createdAt || timestamp
    }))
    state.conversations[conversationKey] = {
      ...state.conversations[conversationKey],
      updatedAt: timestamp
    }
    state.sessions[sessionId] = {
      ...state.sessions[sessionId],
      updatedAt: timestamp
    }
    persist()
    return {
      migrated: true,
      skipped: false,
      reason: '',
      sessionId,
      conversationId,
      messageCount: state.messages[conversationKey].length
    }
  }

  const exportTraceDiagnostics = ({ provider = {}, behaviorDecisions = [], filters = {} } = {}) => {
    const filterPetPackId = typeof filters.petPackId === 'string' ? filters.petPackId.trim() : ''
    const filterConversationId = typeof filters.conversationId === 'string' ? filters.conversationId.trim() : ''
    const matchesFilters = ({ petPackId = '', conversationId = '' } = {}) => {
      if (filterPetPackId && petPackId !== filterPetPackId) return false
      if (filterConversationId && conversationId !== filterConversationId) return false
      return true
    }
    const conversations = Object.entries(state.conversations || {})
      .map(([conversationKey, conversation]) => {
        const messages = normalizeMessages(state.messages[conversationKey] || [])
        return {
          key: conversationKey,
          conversationId: conversationKey,
          id: typeof conversation?.id === 'string' ? conversation.id : '',
          sessionId: typeof conversation?.sessionId === 'string' ? conversation.sessionId : '',
          petPackId: typeof conversation?.petPackId === 'string' ? conversation.petPackId : '',
          personaPackId: typeof conversation?.personaPackId === 'string' ? conversation.personaPackId : '',
          personaHash: typeof conversation?.personaHash === 'string' ? conversation.personaHash : '',
          responseMode: typeof conversation?.responseMode === 'string' ? conversation.responseMode : '',
          messageCount: messages.length,
          messages: messages.map(summarizeMessage).slice(-MAX_TRACE_ITEMS),
          createdAt: typeof conversation?.createdAt === 'string' ? conversation.createdAt : '',
          updatedAt: typeof conversation?.updatedAt === 'string' ? conversation.updatedAt : ''
        }
      })
      .filter((conversation) => matchesFilters({
        petPackId: conversation.petPackId,
        conversationId: conversation.key
      }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, MAX_TRACE_ITEMS)
    const memories = Object.values(state.memories || {})
      .map(summarizeMemory)
      .filter((memory) => matchesFilters({
        petPackId: memory.petPackId,
        conversationId: memory.conversationId
      }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, MAX_TRACE_ITEMS)
    const memoryJobs = Object.values(state.memoryJobs || {})
      .map((job) => ({
        id: typeof job?.id === 'string' ? job.id : '',
        petPackId: typeof job?.petPackId === 'string' ? job.petPackId : '',
        conversationId: typeof job?.conversationId === 'string' ? job.conversationId : '',
        status: typeof job?.status === 'string' ? job.status : '',
        errorCode: typeof job?.errorCode === 'string' ? job.errorCode : '',
        appliedCount: Number.isFinite(Number(job?.appliedCount)) ? Number(job.appliedCount) : 0,
        filteredCount: Number.isFinite(Number(job?.filteredCount)) ? Number(job.filteredCount) : 0,
        createdAt: typeof job?.createdAt === 'string' ? job.createdAt : '',
        updatedAt: typeof job?.updatedAt === 'string' ? job.updatedAt : ''
      }))
      .filter((job) => matchesFilters({
        petPackId: job.petPackId,
        conversationId: job.conversationId
      }))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      .slice(0, MAX_TRACE_ITEMS)
    const traces = Object.values(state.traces || {})
      .map((trace) => ({
        id: typeof trace?.id === 'string' ? trace.id : '',
        petPackId: typeof trace?.petPackId === 'string' ? trace.petPackId : '',
        conversationId: typeof trace?.conversationId === 'string' ? trace.conversationId : '',
        requestId: typeof trace?.requestId === 'string' ? trace.requestId : '',
        streaming: trace?.streaming === true,
        status: typeof trace?.status === 'string' ? trace.status : '',
        chunkCount: Number.isFinite(Number(trace?.chunkCount)) ? Number(trace.chunkCount) : 0,
        partialReplyChars: Number.isFinite(Number(trace?.partialReplyChars)) ? Number(trace.partialReplyChars) : 0,
        replyChars: Number.isFinite(Number(trace?.replyChars)) ? Number(trace.replyChars) : 0,
        elapsedMs: Number.isFinite(Number(trace?.elapsedMs)) ? Number(trace.elapsedMs) : 0,
        providerLatencyMs: Number.isFinite(Number(trace?.providerLatencyMs)) ? Number(trace.providerLatencyMs) : 0,
        finishReason: typeof trace?.finishReason === 'string' ? trace.finishReason : '',
        cancelReason: typeof trace?.cancelReason === 'string' ? trace.cancelReason : '',
        memoryExtractionScheduled: trace?.memoryExtractionScheduled === true,
        behaviorDecisionScheduled: trace?.behaviorDecisionScheduled === true,
        filteredMemoryCandidates: Array.isArray(trace?.filteredMemoryCandidates)
          ? trace.filteredMemoryCandidates.map((candidate) => ({
              operation: typeof candidate?.operation === 'string' ? candidate.operation : '',
              scope: typeof candidate?.scope === 'string' ? candidate.scope : '',
              reason: typeof candidate?.reason === 'string' ? candidate.reason : ''
            }))
          : [],
        createdAt: typeof trace?.createdAt === 'string' ? trace.createdAt : ''
      }))
      .filter((trace) => matchesFilters({
        petPackId: trace.petPackId,
        conversationId: trace.conversationId
      }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, MAX_TRACE_ITEMS)
    const filteredBehaviorDecisions = (Array.isArray(behaviorDecisions) ? behaviorDecisions : [])
      .filter((decision) => {
        if (!filterPetPackId && !filterConversationId) return true
        const petPackId = typeof decision?.petPackId === 'string' ? decision.petPackId : ''
        const conversationId = typeof decision?.conversationId === 'string' ? decision.conversationId : ''
        if (!petPackId && !conversationId) return false
        return matchesFilters({ petPackId, conversationId })
      })
    return JSON.stringify({
      schemaVersion: 1,
      exportedAt: now(),
      redaction: {
        messages: 'content omitted; contentChars and contentSha256 retained',
        memories: 'text omitted; textChars and textSha256 retained',
        provider: 'api keys and credentials omitted by provider view contract',
        behavior: 'decision replay payloads omitted'
      },
      provider: {
        enabled: Boolean(provider.enabled),
        provider: typeof provider.provider === 'string' ? provider.provider : '',
        baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
        model: typeof provider.model === 'string' ? provider.model : '',
        hasApiKey: Boolean(provider.hasApiKey),
        memoryEnabled: Boolean(provider.memory?.enabled),
        behaviorEnabled: Boolean(provider.behavior?.enabled)
      },
      conversations,
      memories,
      memoryJobs,
      traces,
      behaviorDecisions: filteredBehaviorDecisions
        .slice(0, MAX_TRACE_ITEMS)
        .map(({ replay: _replay, ...decision }) => ({
          id: Number.isFinite(Number(decision?.id)) ? Number(decision.id) : 0,
          timestamp: typeof decision?.timestamp === 'string' ? decision.timestamp : '',
          matched: Boolean(decision?.matched),
          type: typeof decision?.type === 'string' ? decision.type : '',
          ruleId: typeof decision?.ruleId === 'string' ? decision.ruleId : '',
          reason: typeof decision?.reason === 'string' ? decision.reason : '',
          actionId: typeof decision?.actionId === 'string' ? decision.actionId : '',
          intent: typeof decision?.intent === 'string' ? decision.intent : '',
          providerReason: typeof decision?.providerReason === 'string' ? decision.providerReason : '',
          displayMode: typeof decision?.displayMode === 'string' ? decision.displayMode : '',
          inputSummary: typeof decision?.inputSummary === 'string' ? decision.inputSummary : '',
          cooldown: Boolean(decision?.cooldown),
          fallback: Boolean(decision?.fallback),
          blockedReason: typeof decision?.blockedReason === 'string' ? decision.blockedReason : '',
          replayRedacted: true
        }))
    }, null, 2)
  }

  return {
    clearConversation,
    getProviderConversations,
    replaceProviderConversations,
    appendMessages,
    applyMemoryOperations,
    createMemoryJob,
    clearPetPackMemories,
    deleteMemory,
    ensureConversation,
    ensureMainConversation,
    finishMemoryJob,
    getMessages,
    getLatestTraceByConversation,
    getPersonaOverride,
    getState,
    exportTraceDiagnostics,
    importMessagesIfEmpty,
    interruptPendingMemoryJobs,
    listRecentPetUtterances,
    listMemories,
    listTraces,
    markMemoriesUsed,
    migrateLegacyConversation,
    persist,
    recordTrace,
    recordPetUtterance,
    clearPetUtterances,
    updateTrace,
    savePersonaOverride
  }
}

export {
  DEFAULT_CONTEXT_POLICY,
  SCHEMA_VERSION,
  createAiTalkStore,
  createEmptyState,
  normalizeState
}
