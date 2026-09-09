import {
	copyFileSync,
	 existsSync,
	 mkdirSync,
	 readFileSync,
	 rmSync,
	 unlinkSync,
	writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { migrate } from "./migrate.js"
import { createConversationsRepository } from "./repositories/conversations.js"
import { canonicalAiState, countAiState } from "./upgrade-ai-json.js"

export const BACKUP_DIR_PREFIX = "backup-"
export const DUAL_WRITE_KINDS = Object.freeze(["conversations", "settings"])

const IMPORT_META_DDL = `
CREATE TABLE IF NOT EXISTS json_import_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  imported_at INTEGER NOT NULL,
  backup_dir TEXT NOT NULL
);`

const SETTINGS_DDL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  values_json TEXT NOT NULL
);`

function clone(value) {
	return structuredClone(value)
}

function readJson(file, fallback) {
	if (!existsSync(file)) return fallback
	const value = JSON.parse(readFileSync(file, "utf8"))
	return value && typeof value === "object" ? value : fallback
}

// Legacy root settings.json was a plain host settings object. The backend
// store is now the active authority and always persists its versioned shape.
export function normalizeLegacySettings(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
	if (Number.isInteger(raw.version) && raw.version >= 0 && raw.values && typeof raw.values === "object" && !Array.isArray(raw.values)) {
		return { version: raw.version, values: raw.values }
	}
	return { version: 0, values: raw }
}

function sourcePaths(userDataDir) {
	const rootSettings = join(userDataDir, "settings.json")
	const backendSettings = join(userDataDir, "backend", "settings.json")
	return {
		// backend/settings.json is the active authority after T41. A leftover
		// legacy root file must never shadow a newer backend envelope.
		settings: existsSync(backendSettings) ? backendSettings : rootSettings,
		settingsTarget: backendSettings,
		conversationStore: join(userDataDir, "ai-talk-store.json"),
	}
}

function hasTable(db, table) {
	try {
		return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
	} catch {
		return false
	}
}

/** schema_migrations is intentionally sampled before migrate() during startup. */
export function needsJsonImport(db) {
	if (!db || !hasTable(db, "schema_migrations")) return true
	const count = db.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count ?? 0
	return Number(count) === 0
}

function timestampValue(now) {
	const value = typeof now === "function" ? now() : now
	const date = value instanceof Date ? value : new Date(value ?? Date.now())
	return Number.isFinite(date.getTime()) ? date.getTime() : Date.now()
}

function isoOrMillis(value, fallback) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
	const parsed = Date.parse(String(value ?? ""))
	return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeId(value, fallback) {
	const normalized = typeof value === "string" ? value.trim() : ""
	return normalized || fallback
}

function conversationIdentity(key, conversation) {
	const publicId = normalizeId(conversation?.id, String(key || "main").split(":").at(-1) || "main")
	const entrypoint = normalizeId(conversation?.entrypoint, String(key || "").split(":")[0] || "control-center")
	const petPackId = normalizeId(conversation?.petPackId ?? conversation?.personaPackId, "legacy-cat")
	const sessionId = normalizeId(conversation?.sessionId, `${entrypoint}:${petPackId}`)
	return { publicId, entrypoint, petPackId, sessionId, key: `${sessionId}:${publicId}` }
}

function jsonError(message, details = {}) {
	const error = new Error(message)
	error.code = "JSON_IMPORT_FAILED"
	error.details = details
	return error
}

function backupLegacyFiles({ paths, userDataDir, now }) {
	const timestamp = String(timestampValue(now)).replace(/[^0-9]/g, "")
	let backupDir = join(userDataDir, `${BACKUP_DIR_PREFIX}${timestamp}`)
	let suffix = 1
	while (existsSync(backupDir)) backupDir = join(userDataDir, `${BACKUP_DIR_PREFIX}${timestamp}-${suffix++}`)
	mkdirSync(backupDir, { recursive: false })
	for (const [name, file] of [["settings.json", paths.settings], ["ai-talk-store.json", paths.conversationStore]]) {
		if (existsSync(file)) copyFileSync(file, join(backupDir, name))
	}
	return backupDir
}

function removeDatabaseFiles(db) {
	const file = db?.file
	try { db?.close?.() } catch { /* best effort; the original error is more useful */ }
	if (typeof file !== "string" || file === ":memory:") return
	for (const suffix of ["", "-wal", "-shm"]) {
		try { unlinkSync(file + suffix) } catch (error) { if (error?.code !== "ENOENT") rmSync(file + suffix, { force: true }) }
	}
}

function importRows({ db, settings, store, onProgress }) {
	db.exec(SETTINGS_DDL + IMPORT_META_DDL)
	const state = canonicalAiState(store)
	createConversationsRepository({ db }).commitState(state)
	let settingsCount = 0
	if (settings) {
		db.prepare("INSERT INTO settings (id, version, values_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, values_json = excluded.values_json").run(settings.version, JSON.stringify(settings.values))
		settingsCount = 1
	}
	const counts = countAiState(state)
	onProgress?.({ phase: "imported", percent: 100 })
	return { conversations: counts.conversations, messages: counts.messages, settings: settingsCount }
}

export async function migrateFromJson({ db, userDataDir, now = () => Date.now(), logger, onProgress, force = false } = {}) {
	if (!db || typeof userDataDir !== "string" || !userDataDir) throw new TypeError("migrateFromJson 需要 db 与 userDataDir")
	if (!force && !needsJsonImport(db)) return { imported: { conversations: 0, messages: 0, settings: 0 }, backupDir: null, skipped: true }

	const paths = sourcePaths(userDataDir)
	const backupDir = backupLegacyFiles({ paths, userDataDir, now })
	try {
		const store = readJson(paths.conversationStore, {})
		const settings = normalizeLegacySettings(readJson(paths.settings, null))
		migrate({ db, logger })
		const imported = db.transaction(() => {
			const counts = importRows({ db, settings, store, now, onProgress })
			const actual = {
				conversations: db.prepare("SELECT count(*) AS count FROM ai_conversations").get().count,
				messages: db.prepare("SELECT count(*) AS count FROM ai_messages").get().count,
				settings: db.prepare("SELECT count(*) AS count FROM settings").get().count,
			}
			for (const kind of ["conversations", "messages", "settings"]) {
				if (Number(actual[kind]) !== Number(counts[kind])) throw jsonError("JSON 导入记录数对账失败", { kind, expected: counts[kind], actual: actual[kind] })
			}
			db.prepare("INSERT INTO json_import_meta (id, imported_at, backup_dir) VALUES (1, ?, ?)").run(timestampValue(now), backupDir)
			return counts
		})
		// T10 still reads backend/settings.json. Copy a legacy root settings file
		// into that canonical location only after the SQLite transaction commits.
		if (settings && paths.settings !== paths.settingsTarget) writeJson(paths.settingsTarget, settings)
		logger?.info?.("JSON 数据迁移完成", { backupDir, imported })
		return { imported, backupDir, skipped: false }
	} catch (error) {
		logger?.error?.("JSON 数据迁移失败", { backupDir, error: String(error) })
		removeDatabaseFiles(db)
		throw error
	}
}

function writeJson(file, value) {
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export function createDualWriter({ userDataDir, logger } = {}) {
	if (typeof userDataDir !== "string" || !userDataDir) throw new TypeError("createDualWriter 需要 userDataDir")
	const storePath = join(userDataDir, "ai-talk-store.json")
	const settingsPath = join(userDataDir, "backend", "settings.json")
	let enabled = true
	const stats = { conversations: 0, settings: 0 }
	const readStore = () => readJson(storePath, { schemaVersion: 1, sessions: {}, conversations: {}, messages: {}, personaOverrides: {}, memories: {}, petUtterances: {}, memoryJobs: {}, traces: {} })
	const writeConversation = (input = {}) => {
		if (!enabled) return false
		const state = readStore()
		const conversation = input.conversation ?? input
		const key = input.key ?? (conversation.sessionId ? `${conversation.sessionId}:${conversation.id}` : conversation.id)
		if (!key) throw new Error("双写对话缺少 key")
		state.conversations[key] = clone(conversation)
		if (Array.isArray(input.messages)) state.messages[key] = clone(input.messages)
		writeJson(storePath, state)
		stats.conversations += 1
		return true
	}
	const writeSettings = (settings) => {
		if (!enabled) return false
		writeJson(settingsPath, clone(settings))
		stats.settings += 1
		return true
	}
	const disable = () => { enabled = false }
	return { writeConversation, writeSettings, disable, stats }
}
