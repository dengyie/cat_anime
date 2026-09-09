"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { after, before, describe, it } = require("node:test")

let dbModule
let migration

before(async () => {
	dbModule = await import("../../services/backend/store/db.js")
	migration = await import("../../services/backend/store/migrate-from-json.js")
})

function fixture() {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-json-import-"))
	fs.mkdirSync(path.join(userDataDir, "backend"), { recursive: true })
	fs.writeFileSync(path.join(userDataDir, "backend", "settings.json"), JSON.stringify({ version: 7, values: { ai: { tone: "warm" } } }))
	fs.writeFileSync(path.join(userDataDir, "ai-talk-store.json"), JSON.stringify({
		schemaVersion: 1,
		conversations: {
			"control-center:mochi:main": { id: "main", title: "Mochi", petPackId: "mochi", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:01:00.000Z" },
		},
		messages: {
			"control-center:mochi:main": [
				{ id: "m1", role: "user", content: "hello", createdAt: "2026-08-20T00:00:01.000Z" },
				{ id: "m2", role: "assistant", content: "hi", createdAt: "2026-08-20T00:00:02.000Z" },
			],
		},
	}))
	return userDataDir
}

async function openFile(userDataDir) {
	return dbModule.openDatabase({ file: path.join(userDataDir, "backend", "openpet.db") })
}

describe("T14 JSON → SQLite", () => {
	it("normalizes a legacy root plain-object settings file to backend envelope", async () => {
		const userDataDir = fixture()
		fs.unlinkSync(path.join(userDataDir, "backend", "settings.json"))
		fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ scale: 1.5, petBehavior: { grounded: true } }))
		const db = await openFile(userDataDir)
		try {
			await migration.migrateFromJson({ db, userDataDir, now: () => "2026-08-21T00:00:00.000Z" })
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, "backend", "settings.json"))), {
				version: 0,
				values: { scale: 1.5, petBehavior: { grounded: true } },
			})
		} finally {
			db.close()
			fs.rmSync(userDataDir, { recursive: true, force: true })
		}
	})

	it("keeps the newer backend envelope authoritative when a stale root file remains", async () => {
		const userDataDir = fixture()
		fs.writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ scale: 0.25 }))
		const db = await openFile(userDataDir)
		try {
			await migration.migrateFromJson({ db, userDataDir, now: () => "2026-08-21T00:00:00.000Z" })
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, "backend", "settings.json"))), { version: 7, values: { ai: { tone: "warm" } } })
			assert.equal(db.prepare("SELECT version FROM settings WHERE id = 1").get().version, 7)
		} finally {
			db.close()
			fs.rmSync(userDataDir, { recursive: true, force: true })
		}
	})

	it("备份并精确导入对话、消息与设置,第二次幂等跳过", async () => {
		const userDataDir = fixture()
		const db = await openFile(userDataDir)
		try {
			assert.equal(migration.needsJsonImport(db), true)
			const first = await migration.migrateFromJson({ db, userDataDir, now: () => "2026-08-21T01:02:03.000Z" })
			assert.deepEqual(first.imported, { conversations: 1, messages: 2, settings: 1 })
			assert.equal(fs.existsSync(first.backupDir), true)
		assert.equal(fs.existsSync(path.join(first.backupDir, "settings.json")), true)
		assert.equal(fs.existsSync(path.join(first.backupDir, "ai-talk-store.json")), true)
		assert.equal(JSON.parse(fs.readFileSync(path.join(userDataDir, "backend", "settings.json"))).version, 7)
			assert.equal(db.prepare("SELECT count(*) AS count FROM ai_conversations").get().count, 1)
			assert.equal(db.prepare("SELECT count(*) AS count FROM ai_messages").get().count, 2)
			assert.equal(db.prepare("SELECT version FROM settings WHERE id = 1").get().version, 7)
			assert.equal(migration.needsJsonImport(db), false)
			const second = await migration.migrateFromJson({ db, userDataDir, now: () => "2026-08-21T01:02:04.000Z" })
			assert.deepEqual(second, { imported: { conversations: 0, messages: 0, settings: 0 }, backupDir: null, skipped: true })
			assert.equal(fs.readdirSync(userDataDir).filter((entry) => entry.startsWith(migration.BACKUP_DIR_PREFIX)).length, 1)
		} finally {
			db.close()
			fs.rmSync(userDataDir, { recursive: true, force: true })
		}
	})

	it("损坏 JSON 也先完成真实备份并保持数据库可重跑", async () => {
		const userDataDir = fixture()
		const dbFile = path.join(userDataDir, "backend", "openpet.db")
		fs.writeFileSync(path.join(userDataDir, "ai-talk-store.json"), "{not-json")
		const db = await openFile(userDataDir)
		await assert.rejects(() => migration.migrateFromJson({ db, userDataDir, now: () => "2026-08-21T03:04:05.000Z" }), SyntaxError)
		assert.equal(fs.existsSync(dbFile), false)
		const backupDirs = fs.readdirSync(userDataDir).filter((entry) => entry.startsWith(migration.BACKUP_DIR_PREFIX))
		assert.equal(backupDirs.length, 1)
		assert.equal(fs.readFileSync(path.join(userDataDir, backupDirs[0], "ai-talk-store.json"), "utf8"), "{not-json")
		fs.rmSync(userDataDir, { recursive: true, force: true })
	})

	it("事务失败时保留备份并删除数据库,允许下次重跑", async () => {
		const userDataDir = fixture()
		const dbFile = path.join(userDataDir, "backend", "openpet.db")
		fs.writeFileSync(path.join(userDataDir, "ai-talk-store.json"), JSON.stringify({ conversations: { one: { id: "one" }, two: { id: "two" } }, messages: { one: [{ id: "same", role: "user", content: "a" }], two: [{ id: "same", role: "user", content: "b" }] } }))
		const db = await openFile(userDataDir)
		await assert.rejects(() => migration.migrateFromJson({ db, userDataDir, now: () => "2026-08-21T02:03:04.000Z", onProgress: () => { throw new Error("simulated import failure") } }), /simulated import failure/)
		assert.equal(fs.existsSync(dbFile), false)
		assert.equal(fs.readdirSync(userDataDir).filter((entry) => entry.startsWith(migration.BACKUP_DIR_PREFIX)).length, 1)
		fs.rmSync(userDataDir, { recursive: true, force: true })
	})

	it("双写持续写回旧 JSON,禁用后不再写", () => {
		const userDataDir = fixture()
		const writer = migration.createDualWriter({ userDataDir })
		writer.writeSettings({ version: 8, values: { cursor: { scale: 2 } } })
		writer.writeConversation({ key: "session:main", conversation: { id: "main", sessionId: "session" }, messages: [{ id: "m", role: "user", content: "x" }] })
		assert.equal(JSON.parse(fs.readFileSync(path.join(userDataDir, "backend", "settings.json"))).version, 8)
		assert.equal(JSON.parse(fs.readFileSync(path.join(userDataDir, "ai-talk-store.json"))).messages["session:main"].length, 1)
		assert.deepEqual(writer.stats, { conversations: 1, settings: 1 })
		writer.disable()
		assert.equal(writer.writeSettings({ version: 9, values: {} }), false)
		fs.rmSync(userDataDir, { recursive: true, force: true })
	})
})
