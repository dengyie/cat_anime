import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { createAiService } from "./provider.js"
import { createAiTalkService } from "./talk.js"
import { createAiTalkStore } from "./talk-store.js"
import { ApiError } from "../../http/middleware.js"

const require = createRequire(import.meta.url)
const { createPetUtteranceLogService } = require("../../../../src/main/services/pet-utterance-log-service.js")
const { createBehaviorOrchestratorService } = require("../../../../src/main/services/behavior-orchestrator-service.js")
const { resolveHatchPetCompletionConfig, createHatchPetAgentPublicConfig } = require("../../../../src/main/services/hatch-pet-agent-contracts.js")

export function createAiSettingsAdapter({ settings, mutationAuthority }) {
  const update = (updater) => {
    const current = settings.read()
    const next = updater(structuredClone(current.values))
    mutationAuthority.patch({ ifVersion: current.version, patch: { ai: next.ai || {} } })
    return settings.read().values
  }
  return { get: () => settings.read().values, update, save: (next) => update(() => next) }
}

export function createAiDomain({ settings, secrets, repository, getActivePetPack, emit, logger, fetchImpl, mutationAuthority, onSnapshot } = {}) {
  if (!repository?.loadState || !repository?.commitState) throw new TypeError("AI domain requires a conversation repository")
  if (!settings?.read || !mutationAuthority?.patch) throw new TypeError("AI domain requires the settings mutation authority")
  if (!secrets?.get) throw new TypeError("AI domain requires provider secrets")
  const settingsService = createAiSettingsAdapter({ settings, mutationAuthority })
  const behavior = createBehaviorOrchestratorService({ settingsService })
  const appLogService = { record: (entry) => logger?.[entry.level || "info"]?.(entry.message, entry.details) }
  const store = createAiTalkStore({ repository })
  store.replaceProviderConversations(settings.read().values.ai?.conversations || {}, { importOnly: true })
  const provider = createAiService({
    settingsService,
    secretService: { getSecretValue: (ref) => secrets.get(ref) },
    conversationStore: { load: store.getProviderConversations, save: store.replaceProviderConversations },
    fetchImpl,
    appLogService,
  })
  let activePack = null
  let packRefresh = null
  const utterances = createPetUtteranceLogService({ aiTalkStore: store, appLogService })
  const talk = createAiTalkService({ aiService: provider, aiTalkStore: store, petPackService: { getActivePetPack: () => activePack }, appLogService, petUtteranceLogService: utterances })

  const hatchCompletionConfig = () => {
    const aiConfig = settings.read().values.ai || {}
    const resolved = resolveHatchPetCompletionConfig({ aiConfig, hatchPetConfig: aiConfig.hatchPet })
    return { ...resolved, apiKeyRef: resolved.source === "hatch-pet-override" ? "ai.hatch-pet" : "ai.default" }
  }
  const getHatchConfig = () => {
    const effective = hatchCompletionConfig()
    const stored = provider.getConfig().hatchPet
    return {
      ...stored,
      hasApiKey: Boolean(secrets.get(effective.apiKeyRef)),
      configSource: effective.source,
      effectiveProvider: effective.provider,
      effectiveBaseUrl: createHatchPetAgentPublicConfig({ ...stored, baseUrl: effective.baseUrl }).baseUrl,
      effectiveModel: effective.model,
    }
  }

  const snapshot = () => ({
    config: provider.getConfig(),
    hatchConfig: getHatchConfig(),
    behavior: behavior.getConfig(),
    persona: activePack ? talk.getPersonaProfile() : null,
    messages: activePack ? talk.getConversation("") : [],
    petPackId: activePack?.manifest?.id || "",
  })
  const publishSnapshot = () => {
    const value = snapshot()
    onSnapshot?.(value)
    return value
  }
  const hydratePack = async () => {
    if (!packRefresh) {
      packRefresh = Promise.resolve().then(() => getActivePetPack?.()).then((pack) => {
        if (!pack?.manifest?.id) throw new Error("Active pet pack is unavailable")
        activePack = structuredClone(pack)
        return publishSnapshot()
      }).finally(() => { packRefresh = null })
    }
    return packRefresh
  }
  const requirePack = async () => { await hydratePack() }
  const requests = new Map()
  const chat = async (input, { onState, signal } = {}) => {
    const requestId = input.requestId || randomUUID()
    if (requests.has(requestId)) throw Object.assign(new Error("AI request is already active"), { code: "CONFLICT" })
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    requests.set(requestId, controller)
    try {
      await requirePack()
      const petPackId = activePack.manifest.id
      const result = await talk.streamChat({ ...input, requestId, signal: controller.signal, onState: (state) => {
        onState?.(state)
        emit?.("ai.chat-delta", state)
      } })
      return { ...result, petPackId }
    } finally {
      requests.delete(requestId)
      signal?.removeEventListener("abort", abort)
      publishSnapshot()
    }
  }
  const cancel = (requestId) => {
    const controller = requests.get(requestId)
    controller?.abort()
    return { requestId, canceled: Boolean(controller) }
  }
  const saveKey = async (capability, value) => {
    const ref = capability === "vision" ? "ai.vision" : "ai.default"
    const result = value === null ? await secrets.clear(ref) : await secrets.set(ref, value)
    publishSnapshot()
    return result
  }
  const saveConfig = (input) => {
    const result = provider.saveConfig(input)
    publishSnapshot()
    return result
  }
  const invokeTalk = async (method, ...args) => {
    await requirePack()
    try { return await talk[method](...args) } finally { publishSnapshot() }
  }
  const complete = async ({ method, request, capability = "chat" }, { signal } = {}) => {
    const fields = {
      complete: ["messages", "tools", "requestId"],
      completeVision: ["messages", "tools", "requestId"],
      completeStructuredTool: ["messages", "tool", "timeoutMs"],
      chat: ["message", "conversationId"],
    }
    if (!Object.hasOwn(fields, method) || !request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some((field) => !fields[method].includes(field))) {
      throw new ApiError("VALIDATION_FAILED", "Unsupported completion request fields")
    }
    if (!["chat", "hatch-pet"].includes(capability) || capability === "hatch-pet" && method !== "completeStructuredTool") {
      throw new ApiError("VALIDATION_FAILED", "Unsupported completion capability")
    }
    const input = { ...request, signal, ...(capability === "hatch-pet" ? { configOverride: hatchCompletionConfig() } : {}) }
    try { return await provider[method](input) } finally { publishSnapshot() }
  }
  const dispose = async () => {
    for (const controller of requests.values()) controller.abort()
    talk.dispose()
    talk.interruptPendingMemoryJobs("shutdown_interrupted")
    await talk.flushMemoryJobs()
  }
  return { provider, talk, store, behavior, utterances, snapshot, getHatchConfig, complete, publishSnapshot, hydratePack, requirePack, chat, cancel, saveKey, saveConfig, invokeTalk, dispose }
}
