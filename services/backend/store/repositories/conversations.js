import { AI_TABLES, decodeConversationRows, projectConversationState } from "./conversation-rows.js"

const primaryKey = (table) => table === "ai_persona_overrides" ? "pet_pack_id" : "id"
const predicate = (table) => table === "traces" ? " WHERE owner = 'ai-talk'" : ""

export function readAiRows(db) {
  return Object.fromEntries(AI_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table}${predicate(table)} ORDER BY ${table === "ai_messages" || table === "ai_pet_utterances" ? "ordinal, rowid" : "rowid"}`).all()]))
}

const collections = Object.freeze({
  sessions: ["ai_sessions", "id"], conversations: ["ai_conversations", "id"],
  messages: ["ai_messages", "conversation_id"], memories: ["ai_memories", "id"],
  personaOverrides: ["ai_persona_overrides", "pet_pack_id"],
  petUtterances: ["ai_pet_utterances", "pet_pack_id"], memoryJobs: ["ai_memory_jobs", "id"],
  traces: ["traces", "state_key"],
})

export function createConversationsRepository({ db } = {}) {
  if (!db?.transaction || !db?.prepare) throw new TypeError("Conversation repository requires the database driver")
  // The SQL shapes are fixed by the table projection, so this cache is bounded.
  const statements = new Map()
  const prepare = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql))
    return statements.get(sql)
  }
  const loadState = () => {
    const metadata = prepare("SELECT value_json FROM ai_store_meta WHERE key = 'schemaVersion'").get()
    return decodeConversationRows(readAiRows({ prepare }), metadata ? JSON.parse(metadata.value_json) : 1)
  }
  const commit = (state, scope) => {
    const selected = scope ? { schemaVersion: state.schemaVersion } : state
    const tables = scope ? Object.keys(scope).map((name) => {
      if (!Object.hasOwn(collections, name)) throw new TypeError(`Unknown AI collection: ${name}`)
      const keys = scope[name]
      if (keys !== null && (!Array.isArray(keys) || keys.some((key) => typeof key !== "string"))) throw new TypeError("AI changed keys must be a string array or null")
      selected[name] = keys === null ? state[name] : Object.fromEntries(keys.filter((key) => Object.hasOwn(state[name], key)).map((key) => [key, state[name][key]]))
      return collections[name][0]
    }) : AI_TABLES
    const projected = projectConversationState(selected)
    return db.transaction(() => {
      const previous = scope ? Object.fromEntries(Object.entries(scope).map(([name, keys]) => {
        const [table, column] = collections[name]
        const rows = keys === null
          ? prepare(`SELECT * FROM ${table}${predicate(table)}`).all()
          : [...new Set(keys)].flatMap((key) => prepare(`SELECT * FROM ${table} WHERE ${column} = ?${table === "traces" ? " AND owner = 'ai-talk'" : ""}`).all(key))
        return [table, rows]
      })) : readAiRows({ prepare })
      let changes = 0
      // The fixed table order preserves foreign-key ordering, even if scope
      // properties were supplied in another order.
      const orderedTables = AI_TABLES.filter((table) => tables.includes(table))
      for (const table of [...orderedTables].reverse()) {
        const key = primaryKey(table)
        const retained = new Set(projected[table].map((row) => row[key]))
        for (const row of previous[table]) {
          if (!retained.has(row[key])) changes += Number(prepare(`DELETE FROM ${table} WHERE ${key} = ?${table === "traces" ? " AND owner = 'ai-talk'" : ""}`).run(row[key]).changes)
        }
      }
      for (const table of orderedTables) {
        const key = primaryKey(table)
        const existing = new Map(previous[table].map((row) => [row[key], row]))
        for (const row of projected[table]) {
          const before = existing.get(row[key])
          const columns = Object.keys(row)
          if (before && columns.every((column) => before[column] === row[column])) continue
          const sql = before
            ? `UPDATE ${table} SET ${columns.filter((column) => column !== key).map((column) => `${column} = ?`).join(", ")} WHERE ${key} = ?`
            : `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
          const values = before ? [...columns.filter((column) => column !== key).map((column) => row[column]), row[key]] : Object.values(row)
          changes += Number(prepare(sql).run(...values).changes)
        }
      }
      prepare("INSERT INTO ai_store_meta (key, value_json) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json WHERE value_json <> excluded.value_json").run(JSON.stringify(state.schemaVersion ?? 1))
      return { changes }
    })
  }
  return { loadState, commitState: (state) => commit(state), commitChanges: (state, changes) => commit(state, changes) }
}

export function restoreAiRows(db, rows) {
  db.transaction(() => {
    for (const table of [...AI_TABLES].reverse()) db.exec(`DELETE FROM ${table}${predicate(table)}`)
    for (const table of AI_TABLES) {
      for (const row of rows[table]) {
        const columns = Object.keys(row)
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row))
      }
    }
  })
}
