'use strict'

const { createParser } = require('eventsource-parser')
const { randomUUID } = require('node:crypto')

function createAiSidecarProxy({ getBackend, getActivePetPackId, fetchImpl = globalThis.fetch, onSnapshot = () => {} } = {}) {
  let snapshot = null
  let generation = 0
  let disposed = false
  const active = new Set()
  const controllers = new Set()
  const clone = (value) => structuredClone(value)
  const current = () => snapshot?.petPackId === getActivePetPackId?.() ? snapshot : null
  const receive = (value) => {
    if (!value || typeof value.config !== 'object' || !Array.isArray(value.messages)) throw new Error('Invalid AI backend snapshot')
    snapshot = clone(value)
    onSnapshot(clone(value))
  }
  const reset = () => { generation++; snapshot = null; for (const controller of controllers) controller.abort() }
  const request = async (path, { method = 'GET', body, signal, accept } = {}) => {
    const backend = getBackend?.()
    if (!backend) throw Object.assign(new Error('AI backend is unavailable'), { code: 'BACKEND_UNAVAILABLE' })
    return fetchImpl(`${backend.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${backend.sessionToken}`, 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    })
  }
  const json = async (path, options) => {
    const response = await request(path, options)
    const payload = await response.json()
    if (!response.ok || payload?.ok !== true) throw Object.assign(new Error(payload?.error?.message || 'AI backend request failed'), { code: payload?.error?.code || 'BACKEND_UNAVAILABLE' })
    return payload.data
  }
  const hydrate = async () => {
    const expected = generation
    const value = await json('/ai/state')
    if (generation === expected) receive(value)
    return value
  }
  const mutate = async (path, body, method = 'POST', options = {}) => {
    const result = await json(path, { method, body, ...options })
    await hydrate()
    return result
  }
  const streamChat = (input = {}) => {
    const run = (async () => {
      if (disposed) throw new Error('AI proxy is disposed')
      const requestId = input.requestId || randomUUID()
      const controller = new AbortController()
      const abort = () => controller.abort(input.signal?.reason)
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
      controllers.add(controller)
      const decoder = new TextDecoder()
      let terminal
      const parser = createParser({ onEvent: ({ event, data }) => {
        const payload = JSON.parse(data)
        if (event === 'ai.chat-delta') input.onState?.(payload)
        if (event === 'ai.chat-done') terminal = payload
      } })
      try {
        const response = await request('/ai/chat', { method: 'POST', body: { ...input, onState: undefined, signal: undefined, requestId, present: false }, signal: controller.signal, accept: 'text/event-stream' })
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('AI backend did not return a chat stream')
        for await (const chunk of response.body) parser.feed(decoder.decode(chunk, { stream: true }))
        parser.feed(decoder.decode())
        if (!terminal || terminal.requestId !== requestId) throw new Error('AI stream ended without a matching result')
        if (!terminal.ok) throw Object.assign(new Error(terminal.error?.message || 'AI request failed'), { code: terminal.error?.code })
        await hydrate()
        return terminal.data
      } finally {
        input.signal?.removeEventListener('abort', abort)
        controllers.delete(controller)
      }
    })()
    active.add(run)
    void run.finally(() => active.delete(run)).catch(() => {})
    return run
  }
  const getConfig = () => clone(snapshot?.config || { enabled: false, hasApiKey: false, memory: { enabled: false }, behavior: { enabled: false }, vision: {} })
  const aiService = {
    getConfig,
    getEffectiveVisionConfig: () => getConfig().vision,
    saveConfig: (input) => mutate('/ai/config', input, 'PATCH'),
    saveApiKey: (apiKey) => mutate('/ai/providers/ai.default/key', { apiKey }, 'PUT'),
    saveVisionApiKey: (apiKey) => mutate('/ai/providers/ai.vision/key', { apiKey }, 'PUT'),
    clearVisionApiKey: () => mutate('/ai/providers/ai.vision/key', undefined, 'DELETE'),
    getConversation: () => clone(current()?.messages || []),
    testConnection: () => mutate('/ai/providers/chat/test'),
    discoverModels: () => mutate('/ai/providers/chat/models', undefined, 'GET'),
    discoverVisionModels: () => mutate('/ai/providers/vision/models', undefined, 'GET'),
  }
  for (const method of ['complete', 'completeVision', 'completeStructuredTool', 'chat']) {
    aiService[method] = ({ signal, ...input } = {}) => mutate('/ai/completions', { method, request: input }, 'POST', { signal })
  }
  const hatchConfiguration = {
    getAiConfig: getConfig,
    getConfig: () => {
      if (!snapshot?.hatchConfig) throw new Error('AI backend configuration is unavailable')
      return clone(snapshot.hatchConfig)
    },
    saveConfig: (input) => mutate('/ai/hatch/config', input, 'PATCH'),
    saveApiKey: async (apiKey) => {
      const result = await mutate('/ai/providers/ai.hatch-pet/key', { apiKey }, 'PUT')
      return { apiKeyRef: 'ai.hatch-pet', hasApiKey: result.configured, updatedAt: new Date().toISOString() }
    },
    clearApiKey: async () => {
      const result = await mutate('/ai/providers/ai.hatch-pet/key', undefined, 'DELETE')
      return { apiKeyRef: 'ai.hatch-pet', hasApiKey: result.configured, updatedAt: new Date().toISOString() }
    },
  }
  const hatchAiService = {
    ...aiService,
    // Only the named capability crosses the boundary; the backend owns routing.
    completeStructuredTool: ({ configOverride, signal, ...input } = {}) => mutate('/ai/completions', {
      method: 'completeStructuredTool', capability: 'hatch-pet', request: input,
    }, 'POST', { signal }),
  }
  const aiTalkService = {
    streamChat,
    chat: streamChat,
    chatFromEntrypoint: (input) => mutate('/ai/entrypoints/chat', input),
    cancelRequest: ({ requestId }) => json(`/ai/chat/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' }),
    getConversation: () => clone(current()?.messages || []),
    getPersonaProfile: () => clone(current()?.persona || {}),
    getMemoryProfile: () => json('/ai/memories'),
    savePersonaOverride: (input) => mutate('/ai/persona', input, 'PUT'),
    generatePersonaDraft: (input) => mutate('/ai/persona/draft', input),
    deleteMemory: (id) => mutate(`/ai/memories/${encodeURIComponent(id)}`, undefined, 'DELETE'),
    clearPetPackMemories: () => mutate('/ai/memories', undefined, 'DELETE'),
    getLatestTraceSummary: (input = {}) => json(`/ai/traces?${new URLSearchParams(input)}`),
    exportTrace: (input) => json('/ai/traces/export', { method: 'POST', body: input }),
    exportTraceDiagnostics: ({ filters } = {}) => json('/ai/traces/diagnostics', { method: 'POST', body: filters || {} }),
    flushMemoryJobs: () => Promise.allSettled([...active]),
    interruptPendingMemoryJobs: () => ({ interruptedCount: 0 }),
    dispose: () => { disposed = true; reset() },
    hydrate,
  }
  const behaviorOrchestratorService = {
    getConfig: () => clone(snapshot?.behavior || { enabled: false, rules: [], decisions: [] }),
    saveConfig: (input) => mutate('/ai/behavior', input, 'PATCH'),
    evaluate: (input) => mutate('/ai/behavior/evaluate', input),
    dryRun: (input) => mutate('/ai/behavior/dry-run', input),
    replayDecision: (input) => mutate('/ai/behavior/replay', input),
    exportDiagnostics: () => json('/ai/behavior/diagnostics', { method: 'POST' }),
    clearDecisions: () => mutate('/ai/behavior/decisions', undefined, 'DELETE'),
  }
  return { aiService, aiTalkService, hatchAiService, hatchConfiguration, behaviorOrchestratorService, petUtteranceLogService: { record: (input) => json('/ai/utterances', { method: 'POST', body: input }) }, receive, reset, hydrate }
}

module.exports = { createAiSidecarProxy }
