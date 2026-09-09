const millis = (value) => {
  if (Number.isFinite(value)) return value
  const parsed = Date.parse(value || "")
  return Number.isFinite(parsed) ? parsed : 0
}
const json = (value) => JSON.stringify(value ?? {})
const entry = (key, value, fields) => ({ ...fields, entity_json: json(value) })

export const AI_TABLES = Object.freeze([
  "ai_sessions", "ai_conversations", "ai_messages", "ai_memories",
  "ai_persona_overrides", "ai_pet_utterances", "ai_memory_jobs", "traces",
])

export function projectConversationState(state) {
  const rows = Object.fromEntries(AI_TABLES.map((table) => [table, []]))
  for (const [key, value] of Object.entries(state.sessions || {})) rows.ai_sessions.push(entry(key, value, {
    id: key, entrypoint: value.entrypoint || "control-center", pet_pack_id: value.petPackId || "legacy-cat",
    active_conversation_id: value.activeConversationId || null, created_at: millis(value.createdAt), updated_at: millis(value.updatedAt),
  }))
  for (const [key, value] of Object.entries(state.conversations || {})) rows.ai_conversations.push(entry(key, value, {
    id: key, session_id: value.sessionId || null, public_id: value.id || key, entrypoint: value.entrypoint || null,
    pet_pack_id: value.petPackId || null, title: value.title || "", persona_id: value.personaPackId || null,
    persona_hash: value.personaHash || null, created_at: millis(value.createdAt), updated_at: millis(value.updatedAt), archived: value.archived ? 1 : 0,
  }))
  for (const [key, messages] of Object.entries(state.messages || {})) {
    if (!Array.isArray(messages)) throw new TypeError("Conversation messages must be an array")
    for (const [ordinal, value] of messages.entries()) rows.ai_messages.push(entry(key, value, {
      id: JSON.stringify([key, ordinal]), conversation_id: key, ordinal,
      role: value.role, content: value.content, token_count: value.tokenCount ?? null, created_at: millis(value.createdAt),
    }))
  }
  for (const [key, value] of Object.entries(state.memories || {})) rows.ai_memories.push(entry(key, value, {
    id: key, kind: value.kind || "fact", content: value.text ?? value.content ?? "", weight: value.weight ?? value.confidence ?? 1,
    scope: value.scope || "global", pet_pack_id: value.petPackId || null, status: value.status || "active",
    created_at: millis(value.createdAt), updated_at: millis(value.updatedAt), expires_at: value.expiresAt ? millis(value.expiresAt) : null,
  }))
  for (const [key, value] of Object.entries(state.personaOverrides || {})) rows.ai_persona_overrides.push(entry(key, value, {
    pet_pack_id: key, persona_json: json(value), persona_hash: value.personaHash || "", updated_at: millis(value.updatedAt),
  }))
  for (const [key, values] of Object.entries(state.petUtterances || {})) {
    for (const [ordinal, value] of values.entries()) rows.ai_pet_utterances.push(entry(key, value, {
      id: JSON.stringify([key, ordinal]), pet_pack_id: key, ordinal, text: value.text,
      source: value.source || "", ttl_ms: value.ttlMs || 0, created_at: millis(value.createdAt),
    }))
  }
  for (const [key, value] of Object.entries(state.memoryJobs || {})) rows.ai_memory_jobs.push(entry(key, value, {
    id: key, pet_pack_id: value.petPackId || "", conversation_id: value.conversationId || "", status: value.status || "pending",
    error_code: value.errorCode || "", applied_count: value.appliedCount || 0, filtered_count: value.filteredCount || 0,
    created_at: millis(value.createdAt), updated_at: millis(value.updatedAt),
  }))
  for (const [key, value] of Object.entries(state.traces || {})) rows.traces.push(entry(key, value, {
    id: `ai-talk:${key}`, owner: "ai-talk", state_key: key, request_id: value.requestId || null,
    job_id: value.jobId || null, kind: value.type || value.kind || "ai-talk-chat", payload_json: json(value),
    conversation_id: value.conversationId || null, pet_pack_id: value.petPackId || null, at: millis(value.at || value.createdAt),
  }))
  return rows
}

const iso = (value) => value ? new Date(value).toISOString() : ""
export function decodeConversationRows(rows, schemaVersion = 1) {
  const state = { schemaVersion, sessions: {}, conversations: {}, messages: {}, memories: {}, personaOverrides: {}, petUtterances: {}, memoryJobs: {}, traces: {} }
  const parse = (row, fallback) => row.entity_json ? JSON.parse(row.entity_json) : fallback
  for (const row of rows.ai_sessions) state.sessions[row.id] = parse(row, { id: row.id, entrypoint: row.entrypoint, petPackId: row.pet_pack_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
  for (const row of rows.ai_conversations) {
    state.conversations[row.id] = parse(row, { id: row.public_id || row.id, sessionId: row.session_id || "legacy:global", entrypoint: row.entrypoint || "legacy", petPackId: row.pet_pack_id || row.persona_id || "global", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), title: row.title || "" })
    state.messages[row.id] = []
  }
  for (const row of rows.ai_messages) {
    state.messages[row.conversation_id] ||= []
    state.messages[row.conversation_id].push(parse(row, { id: row.id, role: row.role, content: row.content, createdAt: iso(row.created_at) }))
  }
  for (const row of rows.ai_memories) state.memories[row.id] = parse(row, { id: row.id, text: row.content, scope: row.scope, petPackId: row.pet_pack_id || "", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), status: row.status })
  for (const row of rows.ai_persona_overrides) state.personaOverrides[row.pet_pack_id] = parse(row, JSON.parse(row.persona_json))
  for (const row of rows.ai_pet_utterances) {
    state.petUtterances[row.pet_pack_id] ||= []
    state.petUtterances[row.pet_pack_id].push(parse(row, { id: row.id, petPackId: row.pet_pack_id, text: row.text, source: row.source, ttlMs: row.ttl_ms, createdAt: iso(row.created_at) }))
  }
  for (const row of rows.ai_memory_jobs) state.memoryJobs[row.id] = parse(row, { id: row.id, petPackId: row.pet_pack_id, conversationId: row.conversation_id, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
  for (const row of rows.traces) state.traces[row.state_key] = parse(row, JSON.parse(row.payload_json))
  return state
}
