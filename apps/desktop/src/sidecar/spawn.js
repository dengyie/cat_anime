"use strict"

// Shell 侧的 sidecar 启动器。
//
// 故意写成 CommonJS:仓库根目前没有 "type": "module",主进程(main.js、
// src/main/**)仍然是 CJS,这个文件要能被它们直接 require。子进程那边是 ESM 不
// 矛盾 —— fork 后子进程按自己最近的 package.json 解析模块类型,
// 而 services/backend/package.json 声明了 "type": "module"。
//
// ADR-002 / ADR-004 / ADR-011。

const { fork } = require("node:child_process")
const path = require("node:path")

const SIDECAR_RELATIVE_ENTRY = "services/backend/index.js"
const READY_TIMEOUT_MS = 10000
const SHUTDOWN_GRACE_MS = 5000
const EXIT_CODE_VERSION_MISMATCH = 78
const MAX_VERSION_MISMATCH_RELAUNCHES = 2
const BRIDGE_PROTOCOL_VERSION = 1

/**
 * ESM resolves the entry and its dependency graph from the unpacked tree.
 * Keep package.json's asarUnpack list aligned with backend runtime imports.
 */
function resolveSidecarEntry(app) {
	if (!app || typeof app.getAppPath !== "function") {
		throw new Error("resolveSidecarEntry 需要 Electron 的 app 对象")
	}
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "app.asar.unpacked", SIDECAR_RELATIVE_ENTRY)
	}
	return path.join(app.getAppPath(), SIDECAR_RELATIVE_ENTRY)
}

function launch(options) {
	const entry = options.entry
	const logger = options.logger

	return new Promise((resolve, reject) => {
		const child = fork(entry, [], {
			cwd: path.dirname(entry),
			// ELECTRON_RUN_AS_NODE=1:让 Electron 二进制以纯 Node 模式跑这个脚本,
			// 不开 GPU、不建窗口、不加载 Electron 的内置模块。
			env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }, options.env || {}),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			// advanced:结构化克隆而不是 JSON,Date / Map / Buffer 能原样过去。
			serialization: "advanced",
		})

		let settled = false

		const finish = (fn, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			fn(value)
		}

		const timer = setTimeout(() => {
			if (logger) logger.error("sidecar 在 " + READY_TIMEOUT_MS + "ms 内没有发出 ready")
			child.kill("SIGKILL")
			const error = new Error("SIDECAR_READY_TIMEOUT")
			error.code = "SIDECAR_READY_TIMEOUT"
			finish(reject, error)
		}, READY_TIMEOUT_MS)
		if (timer.unref) timer.unref()

		if (child.stdout) {
			child.stdout.on("data", (chunk) => {
				if (logger) logger.info("[sidecar] " + String(chunk).trimEnd())
			})
		}
		if (child.stderr) {
			// 后端的结构化日志走 stderr,这里不是错误通道。
			child.stderr.on("data", (chunk) => {
				if (logger) logger.info("[sidecar] " + String(chunk).trimEnd())
			})
		}

		child.on("message", (raw) => {
			if (!raw || typeof raw !== "object" || raw.v !== BRIDGE_PROTOCOL_VERSION) {
				if (logger) logger.error("sidecar 发来的信封版本不符,杀掉并重拉", { received: raw && raw.v })
				child.kill("SIGKILL")
				const error = new Error("SIDECAR_VERSION_MISMATCH")
				error.code = "SIDECAR_VERSION_MISMATCH"
				finish(reject, error)
				return
			}

			const body = raw.body
			if (!settled && body && body.type === "ready") {
				finish(resolve, { child: child, ready: body })
				return
			}
			if (options.onMessage) options.onMessage(raw)
		})

		child.on("error", (error) => {
			if (logger) logger.error("fork sidecar 失败", { error: String(error) })
			finish(reject, error)
		})

		child.on("exit", (code, signal) => {
			if (!settled) {
				const error = new Error("sidecar 在就绪前退出: code=" + code + " signal=" + signal)
				error.code = code === EXIT_CODE_VERSION_MISMATCH ? "SIDECAR_VERSION_MISMATCH" : "SIDECAR_EARLY_EXIT"
				error.exitCode = code
				finish(reject, error)
			}
			if (options.onExit) options.onExit(code, signal)
		})

		// init 先行:后端拿到 init 才绑端口。理由见 services/backend/README.md。
		// ADR-010:providerKeys 在这里一次性注入,Shell 是唯一能调 safeStorage 的一侧。
		child.send({
			v: BRIDGE_PROTOCOL_VERSION,
			id: "shell-init-1",
			at: Date.now(),
			body: Object.assign({ type: "init" }, options.initBody || {}),
		})
	})
}

/**
 * 启动 sidecar。版本不符最多重拉 MAX_VERSION_MISMATCH_RELAUNCHES 次(ADR-011)。
 *
 * 重拉只针对版本不符。ready 超时、早死、fork 失败一律不重试 —— 这些通常是
 * 确定性故障(路径错、模块加载失败),重试只会把冷启动拖到 30 秒。
 * 谁重试都不行时由调用方进降级态(06 篇 R12、前端的 degraded 告警条)。
 */
async function spawnSidecar(options) {
	const opts = options || {}
	const entry = opts.entry || resolveSidecarEntry(opts.app)
	const logger = opts.logger
	const launchSidecar = opts.launch || launch

	let attempt = 0
	let lastError = null

	while (attempt <= MAX_VERSION_MISMATCH_RELAUNCHES) {
		attempt += 1
		try {
			let accepted = false
			const started = await launchSidecar({
				entry: entry,
				env: opts.env,
				initBody: opts.initBody,
				logger: logger,
				onMessage: opts.onMessage,
				onExit(code, signal) {
					if (accepted) opts.onExit?.(code, signal)
				},
			})
			accepted = true
			const ready = started.ready
			if (logger) {
				logger.info("sidecar ready", {
					port: ready.port,
					pid: ready.pid,
					apiVersion: ready.apiVersion,
					startupMs: ready.startupMs,
					attempt: attempt,
				})
			}
			return {
				child: started.child,
				port: ready.port,
				sessionToken: ready.sessionToken,
				apiVersion: ready.apiVersion,
				pid: ready.pid,
				startupMs: ready.startupMs,
				attempt: attempt,
				processName: path.basename(process.execPath),
				baseUrl: "http://127.0.0.1:" + ready.port + "/api/v1",
			}
		} catch (error) {
			lastError = error
			const retryable = error && error.code === "SIDECAR_VERSION_MISMATCH"
			if (!retryable || attempt > MAX_VERSION_MISMATCH_RELAUNCHES) break
			if (logger) logger.warn("版本不符,重拉 sidecar", { attempt: attempt })
		}
	}

	const failure = new Error("sidecar 启动失败: " + String(lastError && lastError.message))
	failure.code = (lastError && lastError.code) || "SIDECAR_SPAWN_FAILED"
	failure.cause = lastError
	failure.attempts = attempt
	throw failure
}

/**
 * 优雅停止:先发 shutdown,宽限期内没退就 SIGKILL。
 * 对应 04 篇 §1.4 的孤儿进程问题(R2) —— 完整的 pids.json 清理在 M3。
 */
function stopSidecar(child, options) {
	const graceMs = (options && options.graceMs) || SHUTDOWN_GRACE_MS
	return new Promise((resolve) => {
		if (!child || child.exitCode !== null || child.killed) {
			resolve("already-stopped")
			return
		}

		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve("killed")
		}, graceMs)
		if (timer.unref) timer.unref()

		child.once("exit", () => {
			clearTimeout(timer)
			resolve("exited")
		})

		try {
			child.send({
				v: BRIDGE_PROTOCOL_VERSION,
				id: "shell-shutdown-1",
				at: Date.now(),
				body: { type: "shutdown" },
			})
		} catch (error) {
			// 通道已断,直接等超时路径 SIGKILL。
		}
	})
}

module.exports = {
	spawnSidecar: spawnSidecar,
	stopSidecar: stopSidecar,
	resolveSidecarEntry: resolveSidecarEntry,
	SIDECAR_RELATIVE_ENTRY: SIDECAR_RELATIVE_ENTRY,
	READY_TIMEOUT_MS: READY_TIMEOUT_MS,
	EXIT_CODE_VERSION_MISMATCH: EXIT_CODE_VERSION_MISMATCH,
	MAX_VERSION_MISMATCH_RELAUNCHES: MAX_VERSION_MISMATCH_RELAUNCHES,
}
