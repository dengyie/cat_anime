import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { createConversationsRepository, readAiRows, restoreAiRows } from "./repositories/conversations.js"

const COLLECTIONS = ["sessions", "conversations", "messages", "personaOverrides", "memories", "petUtterances", "memoryJobs", "traces"]
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function canonicalAiState(input = {}) {
  const state = { schemaVersion: input.schemaVersion || 1 }
  for (const collection of COLLECTIONS) {
    const value = input[collection] || {}
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid AI collection: ${collection}`)
    state[collection] = structuredClone(value)
  }
  for (const [key, conversation] of Object.entries(state.conversations)) {
    state.messages[key] ||= []
    if (conversation.sessionId && !state.sessions[conversation.sessionId]) {
      state.sessions[conversation.sessionId] = { id: conversation.sessionId, entrypoint: conversation.entrypoint || "control-center", petPackId: conversation.petPackId || "legacy-cat", createdAt: conversation.createdAt || "", updatedAt: conversation.updatedAt || "" }
    }
  }
  for (const key of Object.keys(state.messages)) {
    if (!state.conversations[key]) throw new Error(`AI messages have no conversation: ${key}`)
  }
  return state
}

export function countAiState(state) {
  return Object.fromEntries(COLLECTIONS.map((name) => [name, name === "messages" || name === "petUtterances"
    ? Object.values(state[name] || {}).reduce((count, rows) => count + rows.length, 0)
    : Object.keys(state[name] || {}).length]))
}

export function upgradeAiJsonStore({ db, userDataDir, logger, beforeCommit } = {}) {
  const existing = db.prepare("SELECT value_json FROM ai_store_meta WHERE key = 'jsonUpgrade'").get()
  if (existing) return { ...JSON.parse(existing.value_json), skipped: true }
  const repository = createConversationsRepository({ db })
  const source = join(userDataDir, "ai-talk-store.json")
  const backupDir = join(userDataDir, "backend", `ai-backup-${randomUUID()}`)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  if (existsSync(source)) copyFileSync(source, join(backupDir, "ai-talk-store.json"))
  const beforeRows = readAiRows(db)
  beforeRows.ai_store_meta = db.prepare("SELECT key, value_json FROM ai_store_meta WHERE key = 'schemaVersion'").all()
  writeFileSync(join(backupDir, "sqlite-ai-before.json"), JSON.stringify(beforeRows), { mode: 0o600 })
  const beforeState = repository.loadState()
  const imported = existsSync(source) ? canonicalAiState(JSON.parse(readFileSync(source, "utf8"))) : null
  let next = beforeState
  if (imported) {
    next = { ...imported }
    for (const collection of COLLECTIONS) next[collection] = { ...beforeState[collection], ...imported[collection] }
    // T14 flattened conversation IDs. Match its old rows against the source
    // before replacing them with the complete session-scoped keys.
    const legacyIds = new Map()
    for (const [key, conversation] of Object.entries(imported.conversations)) {
      const requested = conversation.id || key
      let id = requested
      let suffix = 1
      while (legacyIds.has(id)) id = `${requested}:${suffix++}`
      legacyIds.set(id, key)
    }
    for (const row of beforeRows.ai_conversations) {
      if (row.entity_json || !legacyIds.has(row.id) || imported.conversations[row.id]) continue
      delete next.conversations[row.id]
      delete next.messages[row.id]
    }
  }
  const report = db.transaction(() => {
    repository.commitState(next)
    beforeCommit?.()
    const loaded = repository.loadState()
    const counts = countAiState(next)
    if (JSON.stringify(counts) !== JSON.stringify(countAiState(loaded))) throw new Error("AI migration count mismatch")
    const value = { backupDir, counts, migratedAt: new Date().toISOString(), stateDigest: digest(loaded) }
    db.prepare("INSERT INTO ai_store_meta (key, value_json) VALUES ('jsonUpgrade', ?)").run(JSON.stringify(value))
    return value
  })
  writeFileSync(join(backupDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 })
  logger?.info?.("AI JSON upgrade completed", { counts: report.counts, backupDir })
  return { ...report, skipped: false }
}

export function rollbackAiJsonUpgrade({ db } = {}) {
  const row = db.prepare("SELECT value_json FROM ai_store_meta WHERE key = 'jsonUpgrade'").get()
  if (!row) return { restored: false }
  const report = JSON.parse(row.value_json)
  const repository = createConversationsRepository({ db })
  if (digest(repository.loadState()) !== report.stateDigest) throw new Error("AI data changed after migration; rollback would discard newer history")
  const rows = JSON.parse(readFileSync(join(report.backupDir, "sqlite-ai-before.json"), "utf8"))
  db.transaction(() => {
    restoreAiRows(db, rows)
    db.prepare("DELETE FROM ai_store_meta WHERE key = 'schemaVersion'").run()
    for (const metadata of rows.ai_store_meta || []) {
      db.prepare("INSERT INTO ai_store_meta (key, value_json) VALUES (?, ?)").run(metadata.key, metadata.value_json)
    }
    db.prepare("DELETE FROM ai_store_meta WHERE key = 'jsonUpgrade'").run()
  })
  return { restored: true, backupDir: report.backupDir }
}
