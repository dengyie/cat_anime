"use strict"

const assert = require("node:assert/strict")
const { before, describe, it } = require("node:test")

const EXPECTED_TABLES = [
	"ai_conversations",
	"ai_memories",
	"ai_memory_jobs",
	"ai_messages",
	"ai_persona_overrides",
	"ai_pet_utterances",
	"ai_sessions",
	"ai_store_meta",
	"http_access_logs",
	"job_events",
	"jobs",
	"plugin_logs",
	"schema_migrations",
	"traces",
]

let migrateModule
let openDatabase

before(async () => {
	migrateModule = await import("../../services/backend/store/migrate.js")
	;({ openDatabase } = await import("../../services/backend/store/db.js"))
})

async function withDatabase(run) {
	const db = await openDatabase({ file: ":memory:" })
	try {
		return await run(db)
	} finally {
		db.close()
	}
}

describe("迁移运行器 · 文件与校验和", () => {
	it("按版本列出迁移,代码 schema 版本与最高文件版本一致", () => {
		const migrations = migrateModule.listMigrationFiles()
		assert.deepEqual(migrations.map(({ version }) => version), [1, 2])
		assert.deepEqual(migrations.map(({ file }) => file), ["001_init.sql", "002_ai_talk.sql"])
		assert.equal(migrateModule.CODE_SCHEMA_VERSION, 2)
	})

	it("checksumOf 返回 SHA-256 hex", () => {
		assert.equal(
			migrateModule.checksumOf("openpet"),
			"301b7310596415fdcc4d23e523ff2e6014e0fece972c0da90c4f01befc690f6b",
		)
	})
})

describe("迁移运行器 · 应用", () => {
	it("首次应用 001,第二次幂等且 9 张表均存在", async () => {
		await withDatabase(async (db) => {
			const first = migrateModule.migrate({ db })
			assert.deepEqual(first, { from: 0, to: 2, applied: [1, 2] })

			const second = migrateModule.migrate({ db })
			assert.deepEqual(second, { from: 2, to: 2, applied: [] })

			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all()
				.map(({ name }) => name)
			assert.deepEqual(tables, EXPECTED_TABLES)

			const versions = migrateModule.appliedVersions(db)
				assert.equal(versions.length, 2)
				assert.deepEqual(versions.map((version) => version.version), [1, 2])
				assert.equal(versions[1].checksum, migrateModule.listMigrationFiles()[1].checksum)
				assert.equal(Number.isInteger(versions[1].applied_at), true)
		})
	})

	it("已应用迁移的 checksum 被篡改时抛 INTERNAL", async () => {
		await withDatabase(async (db) => {
			migrateModule.migrate({ db })
			db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run("tampered", 1)

			assert.throws(
				() => migrateModule.migrate({ db }),
				(error) => {
					assert.equal(error.name, "ApiError")
					assert.equal(error.code, "INTERNAL")
					assert.equal(error.status, 500)
					assert.equal(error.details.version, 1)
					return true
				},
			)
		})
	})

	it("库版本高于代码版本时抛 MIGRATION_REQUIRED / 503", async () => {
		await withDatabase(async (db) => {
			migrateModule.migrate({ db })
			db.prepare(
				"INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
			).run(99, Date.now(), "future")

			assert.throws(
				() => migrateModule.migrate({ db }),
				(error) => {
					assert.equal(error.name, "ApiError")
					assert.equal(error.code, "MIGRATION_REQUIRED")
					assert.equal(error.status, 503)
						assert.deepEqual(error.details, { databaseVersion: 99, codeSchemaVersion: 2 })
					return true
				},
			)
		})
	})
})
