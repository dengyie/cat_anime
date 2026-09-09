import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { ApiError, sendSuccess } from "../http/middleware.js"
import { streamAiChat } from "./ai-stream.js"

const require = createRequire(import.meta.url)
const { createAiConfigView, createAiPersonaProfileView, createAiPersonaDraftView, createAiMemoryProfileView, createAiBehaviorConfigView, createAiBehaviorResultView } = require("../../../src/main/control-center-adapters.js")

export const AI_RUNTIME_ROUTES = Object.freeze([
  "GET /ai/state", "GET /ai/config", "PATCH /ai/config",
  "GET /ai/hatch/config", "PATCH /ai/hatch/config",
  "POST /ai/providers/:id/test", "GET /ai/providers/:id/models",
  "GET /ai/persona", "PUT /ai/persona", "POST /ai/persona/draft",
  "GET /ai/memories", "POST /ai/memories", "DELETE /ai/memories", "DELETE /ai/memories/:id",
  "GET /ai/conversations", "GET /ai/conversations/:id", "DELETE /ai/conversations/:id",
  "GET /ai/traces", "POST /ai/traces/export", "POST /ai/traces/diagnostics",
  "POST /ai/chat", "POST /ai/chat/:id/cancel",
  "GET /ai/behavior", "PATCH /ai/behavior", "GET /ai/behavior/rules", "POST /ai/behavior/rules",
  "PATCH /ai/behavior/rules/:id", "DELETE /ai/behavior/rules/:id",
  "POST /ai/behavior/dry-run", "POST /ai/behavior/evaluate", "POST /ai/behavior/replay",
  "POST /ai/behavior/diagnostics", "DELETE /ai/behavior/decisions",
  "POST /ai/utterances", "POST /ai/completions", "POST /ai/entrypoints/chat",
])

function object(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("VALIDATION_FAILED", "Object payload is required")
  return value
}

function capability(id) {
  if (["chat", "ai.default"].includes(id)) return "chat"
  if (["vision", "ai.vision"].includes(id)) return "vision"
  throw new ApiError("NOT_FOUND", "AI provider capability not found")
}

export function registerAiRuntimeRoutes(router, { getDomain, present, getActions = async () => [] } = {}) {
  const domain = () => {
    const ai = getDomain?.()
    if (!ai) throw new ApiError("BACKEND_UNAVAILABLE", "AI backend is unavailable")
    return ai
  }
  const talk = async (ctx, method, args = [], view = (value) => value) => sendSuccess(ctx, view(await domain().invokeTalk(method, ...args)))
  router.get("/ai/state", async (ctx) => { const ai = domain(); await ai.requirePack(); sendSuccess(ctx, ai.snapshot()) })
  router.get("/ai/config", (ctx) => sendSuccess(ctx, createAiConfigView(domain().provider.getConfig())))
  router.patch("/ai/config", (ctx) => sendSuccess(ctx, createAiConfigView(domain().saveConfig(object(ctx.body)))))
  router.get("/ai/hatch/config", (ctx) => sendSuccess(ctx, domain().getHatchConfig()))
  router.patch("/ai/hatch/config", (ctx) => {
    const ai = domain()
    ai.saveConfig({ hatchPet: object(ctx.body) })
    sendSuccess(ctx, ai.getHatchConfig())
  })
  router.post("/ai/providers/:id/test", async (ctx) => {
    if (capability(ctx.params.id) !== "chat") throw new ApiError("VALIDATION_FAILED", "Connection test is available for chat")
    sendSuccess(ctx, await domain().provider.testConnection())
  })
  router.get("/ai/providers/:id/models", async (ctx) => {
    const ai = domain()
    const method = capability(ctx.params.id) === "vision" ? "discoverVisionModels" : "discoverModels"
    sendSuccess(ctx, await ai.provider[method]())
    ai.publishSnapshot()
  })
  router.get("/ai/persona", (ctx) => talk(ctx, "getPersonaProfile", [], createAiPersonaProfileView))
  router.put("/ai/persona", (ctx) => talk(ctx, "savePersonaOverride", [object(ctx.body)], createAiPersonaProfileView))
  router.post("/ai/persona/draft", (ctx) => talk(ctx, "generatePersonaDraft", [object(ctx.body)], createAiPersonaDraftView))
  router.get("/ai/memories", (ctx) => talk(ctx, "getMemoryProfile", [], createAiMemoryProfileView))
  router.post("/ai/memories", async (ctx) => {
    const ai = domain()
    await ai.requirePack()
    const input = object(ctx.body)
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 500) throw new ApiError("VALIDATION_FAILED", "Memory text must contain 1 to 500 characters")
    ai.store.applyMemoryOperations({ petPackId: ai.snapshot().petPackId, operations: [{ ...input, operation: "create" }] })
    return talk(ctx, "getMemoryProfile", [], createAiMemoryProfileView)
  })
  router.delete("/ai/memories", (ctx) => talk(ctx, "clearPetPackMemories", [], createAiMemoryProfileView))
  router.delete("/ai/memories/:id", (ctx) => talk(ctx, "deleteMemory", [ctx.params.id], createAiMemoryProfileView))
  router.get("/ai/conversations", async (ctx) => {
    const ai = domain()
    await ai.requirePack()
    if (ctx.query.conversationId !== undefined) return talk(ctx, "getConversation", [ctx.query.conversationId])
    sendSuccess(ctx, Object.entries(ai.store.getState().conversations).map(([key, value]) => ({ ...value, key })))
  })
  router.get("/ai/conversations/:id", (ctx) => talk(ctx, "getConversation", [ctx.params.id]))
  router.delete("/ai/conversations/:id", (ctx) => {
    const ai = domain()
    const cleared = ai.store.clearConversation(ctx.params.id)
    ai.publishSnapshot()
    sendSuccess(ctx, { cleared })
  })
  router.get("/ai/traces", (ctx) => talk(ctx, "getLatestTraceSummary", [ctx.query]))
  router.post("/ai/traces/export", (ctx) => talk(ctx, "exportTrace", [object(ctx.body)]))
  router.post("/ai/traces/diagnostics", (ctx) => talk(ctx, "exportTraceDiagnostics", [{ filters: object(ctx.body), behaviorDecisions: domain().behavior.getConfig().decisions }]))
  router.post("/ai/chat", (ctx) => streamAiChat(ctx, { ai: domain(), present }))
  router.post("/ai/chat/:id/cancel", (ctx) => sendSuccess(ctx, domain().cancel(ctx.params.id)))
  router.get("/ai/behavior", (ctx) => sendSuccess(ctx, createAiBehaviorConfigView(domain().behavior.getConfig())))
  const saveBehavior = (ctx, input) => {
    const ai = domain()
    const config = ai.behavior.saveConfig(input)
    ai.publishSnapshot()
    sendSuccess(ctx, createAiBehaviorConfigView(config))
  }
  router.patch("/ai/behavior", (ctx) => saveBehavior(ctx, object(ctx.body)))
  router.get("/ai/behavior/rules", (ctx) => sendSuccess(ctx, domain().behavior.getConfig().rules))
  router.post("/ai/behavior/rules", (ctx) => {
    const rule = { ...object(ctx.body), id: ctx.body.id || randomUUID() }
    const rules = domain().behavior.getConfig().rules
    if (rules.some(({ id }) => id === rule.id)) throw new ApiError("CONFLICT", "Behavior rule already exists")
    saveBehavior(ctx, { rules: [...rules, rule] })
  })
  router.patch("/ai/behavior/rules/:id", (ctx) => {
    const rules = domain().behavior.getConfig().rules
    if (!rules.some(({ id }) => id === ctx.params.id)) throw new ApiError("NOT_FOUND", "Behavior rule not found")
    saveBehavior(ctx, { rules: rules.map((rule) => rule.id === ctx.params.id ? { ...rule, ...object(ctx.body), id: rule.id } : rule) })
  })
  router.delete("/ai/behavior/rules/:id", (ctx) => saveBehavior(ctx, { rules: domain().behavior.getConfig().rules.filter(({ id }) => id !== ctx.params.id) }))
  for (const [path, method] of [["dry-run", "dryRun"], ["evaluate", "evaluate"], ["replay", "replayDecision"]]) {
    router.post(`/ai/behavior/${path}`, async (ctx) => {
      const ai = domain()
      const result = ai.behavior[method]({ ...object(ctx.body), actions: await getActions() })
      ai.publishSnapshot()
      sendSuccess(ctx, createAiBehaviorResultView(result))
    })
  }
  router.post("/ai/behavior/diagnostics", (ctx) => sendSuccess(ctx, domain().behavior.exportDiagnostics()))
  router.delete("/ai/behavior/decisions", (ctx) => { const ai = domain(); const result = ai.behavior.clearDecisions(); ai.publishSnapshot(); sendSuccess(ctx, result) })
  router.post("/ai/utterances", (ctx) => sendSuccess(ctx, domain().utterances.record(object(ctx.body))))
  router.post("/ai/entrypoints/chat", (ctx) => talk(ctx, "chatFromEntrypoint", [object(ctx.body)]))
  router.post("/ai/completions", async (ctx) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    ctx.res.once("close", abort)
    try { sendSuccess(ctx, await domain().complete(object(ctx.body), { signal: controller.signal })) }
    finally { ctx.res.removeListener("close", abort) }
  })
}
