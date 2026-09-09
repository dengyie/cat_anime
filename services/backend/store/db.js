// ADR-014:node:sqlite + 一层极薄的 driver 接口。
//
// driver 存在的唯一目的是退路成本:若 spike 6 红(node:sqlite 不可用或需 flag),
// 只需在本文件里换一个实现(better-sqlite3),repositories/ 与 jobs/ 一行不改。
// 所以这个接口故意只有 5 个方法,不抽象成 ORM。

import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export const NODE_SQLITE_UNAVAILABLE = "NODE_SQLITE_UNAVAILABLE"

// ADR-006:WAL。synchronous=NORMAL 在 WAL 下已足够(崩溃不丢已提交事务,
// 只在断电时可能丢最后几个事务),换来的写入延迟降一个数量级。
export const DEFAULT_PRAGMAS = Object.freeze([
	"journal_mode = WAL",
	"synchronous = NORMAL",
	"foreign_keys = ON",
	"busy_timeout = 5000",
])

// ADR-007:后端是唯一写者。这个 Set 只能挡住本进程内的重复打开 ——
// 跟进程外的竞争靠的是「只有 sidecar 持有这个文件」这个约定本身。
const openFiles = new Set()

/**
 * 打开(必要时创建)一个 SQLite 数据库。
 *
 * 用 await import 而不是顶层 import:node:sqlite 在部分 Node 构建里需要
 * --experimental-sqlite。顶层 import 会让整个后端卡在模块求值阶段,连一句
 * 可读的错误都给不出来。
 */
export async function openDatabase({ file, pragmas = DEFAULT_PRAGMAS, logger } = {}) {
	if (typeof file !== "string" || file.length === 0) throw new Error("openDatabase 需要 file 路径")
	if (openFiles.has(file)) throw new Error("违反单写者原则(ADR-007):" + file + " 已在本进程打开")

	let DatabaseSync
	try {
		const sqlite = await import("node:sqlite")
		DatabaseSync = sqlite.DatabaseSync
	} catch (cause) {
		const error = new Error(
			"node:sqlite 不可用。ADR-014 的前提未成立:先跑 spike 6" +
				"(spike/06-node-sqlite/probe-sqlite.js)确认是不可用还是需要 --experimental-sqlite;" +
				"若确实不可用,按 ADR-014 切到 better-sqlite3 退路 —— 只需换本文件的 driver 实现",
		)
		error.code = NODE_SQLITE_UNAVAILABLE
		error.cause = cause
		throw error
	}

	if (typeof DatabaseSync !== "function") {
		const error = new Error("node:sqlite 已加载但没有导出 DatabaseSync")
		error.code = NODE_SQLITE_UNAVAILABLE
		throw error
	}

	mkdirSync(dirname(file), { recursive: true })
	// Recheck after the async module load, using the physical path: concurrent
	// calls and symlink aliases must not open two writers in this process.
	const resolved = resolve(file)
	const fileKey = file === ":memory:" ? file
		: existsSync(resolved) ? realpathSync(resolved) : join(realpathSync(dirname(resolved)), basename(resolved))
	if (openFiles.has(fileKey)) throw new Error("违反单写者原则(ADR-007):" + file + " 已在本进程打开")
	const raw = new DatabaseSync(file)
	try {
		for (const pragma of pragmas) raw.exec("PRAGMA " + pragma + ";")
	} catch (error) {
		raw.close()
		throw error
	}
	openFiles.add(fileKey)
	logger?.info?.("SQLite 已打开", { file, pragmas })

	return createDriver({ raw, file, fileKey, logger })
}

function createDriver({ raw, file, fileKey, logger }) {
	let depth = 0
	let closed = false

	const assertOpen = () => {
		if (closed) throw new Error("数据库已关闭: " + file)
	}

	const driver = {
		driverName: "node:sqlite",
		file,

		exec(sql) {
			assertOpen()
			raw.exec(sql)
		},

		prepare(sql) {
			assertOpen()
			const statement = raw.prepare(sql)
			return {
				get: (...params) => statement.get(...params),
				all: (...params) => statement.all(...params),
				run: (...params) => statement.run(...params),
			}
		},

		/**
		 * 外层走 BEGIN IMMEDIATE(立刻拿写锁,避开 SQLITE_BUSY 升级失败),
		 * 内层走 SAVEPOINT,因此可安全嵌套。
		 *
		 * ⚠️ fn 必须是**同步**的。node:sqlite 本身是同步 API,传 async 函数会在
		 * await 处让出事件循环,COMMIT 就提到了业务完成之前 —— 静默丢数据。
		 * 这里主动报错而不是容忍。
		 */
		transaction(fn) {
			assertOpen()
			const entryDepth = depth
			const isOuter = entryDepth === 0
			const savepoint = "sp_" + entryDepth
			raw.exec(isOuter ? "BEGIN IMMEDIATE;" : "SAVEPOINT " + savepoint + ";")
			depth += 1
			try {
				const result = fn(driver)
				if (result !== null && typeof result?.then === "function") {
					throw new Error("transaction(fn) 只接受同步回调,不能传 async 函数")
				}
				raw.exec(isOuter ? "COMMIT;" : "RELEASE " + savepoint + ";")
				return result
			} catch (error) {
				try {
					raw.exec(isOuter ? "ROLLBACK;" : "ROLLBACK TO " + savepoint + "; RELEASE " + savepoint + ";")
				} catch (rollbackError) {
					logger?.error?.("回滚失败", { file, error: String(rollbackError) })
				}
				throw error
			} finally {
				// COMMIT can fail too (for example, deferred foreign keys). Restore
				// depth once, regardless of whether fn or COMMIT threw.
				depth = entryDepth
			}
		},

		pragma(name) {
			assertOpen()
			return raw.prepare("PRAGMA " + name + ";").get()
		},

		close() {
			if (closed) return
			raw.close()
			closed = true
			openFiles.delete(fileKey)
			logger?.info?.("SQLite 已关闭", { file })
		},
	}

	return driver
}
