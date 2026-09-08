// OpenPet 后端 sidecar 入口
//
// 由 Shell(Electron 主进程)通过 child_process.fork 启动 —— ADR-002 / ADR-004。
// 启动顺序见 README「启动顺序(与 spike 1 有意不同)」。
//
// 本文件只做编排。业务路由从 M2 起注册在 routes/ 下,现在只有 /health。

import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EVENT_BACKEND_SHUTTING_DOWN, EVENT_PET_PACK_ACTIVATED, SETTINGS_CANONICAL_PATHS, SETTINGS_TRUSTED_PATHS } from "@openpet/contracts"

import { createRouter } from "./http/router.js"
import {
	accessLog,
	bearerAuth,
	cors,
	createAccessLogBuffer,
	errorBoundary,
	jsonBody,
	loopbackOnly,
	requestId,
} from "./http/middleware.js"
import { createShellClient } from "./bridge/shell-client.js"
import { createPluginRuntimeServer } from "./bridge/plugin-runtime-server.js"
import { createPluginCommandServer } from "./bridge/plugin-command-server.js"
import { createProviderKeyStore } from "./secrets/provider-keys.js"
import { createSettingsStore } from "./domains/settings.js"
import { createAboutService } from "./domains/about.js"
import { createLocalHttpManager } from "./domains/local-http.js"
import { createPetPackService } from "./domains/pet-packs.js"
import { createActionService } from "./domains/actions.js"
import { createCatalogService } from "./domains/catalog.js"
import { createInitializedPluginService } from "./domains/plugins/index.js"
import { createProcessLedger } from "./domains/plugins/process-ledger.js"
import { createEventHub } from "./events/hub.js"
import { recoverJobs } from "./jobs/recovery.js"
import { createQueue } from "./jobs/queue.js"
import { createRunner } from "./jobs/runner.js"
import { createJobDispatcher } from "./jobs/dispatcher.js"
import { registerEventRoutes } from "./routes/events.js"
import { initializeBackendRuntime, registerHealthRoutes } from "./routes/health.js"
import { createSettingsMutationAuthority, createSettingsMutationCoordinator, parsePatch, registerSettingsRoutes } from "./routes/settings.js"
import { registerAboutRoutes } from "./routes/about.js"
import { registerServiceRoutes } from "./routes/service.js"
import { registerPetPackRoutes } from "./routes/pet-packs.js"
import { registerActionRoutes } from "./routes/actions.js"
import { registerCatalogRoutes } from "./routes/catalog.js"
import { registerJobRoutes } from "./routes/jobs.js"
import { registerPluginRoutes } from "./routes/plugins.js"
import { registerAiSecretRoutes } from "./routes/ai.js"
import { registerAiRoutes } from "./routes/ai.js"
import { createAiService } from "./domains/ai/image-generation.js"
import { openDatabase } from "./store/db.js"
import { migrate } from "./store/migrate.js"
import { migrateFromJson, needsJsonImport } from "./store/migrate-from-json.js"
import { createJobsRepository } from "./store/repositories/jobs.js"
import { createLogsRepository } from "./store/repositories/logs.js"
import { createPluginJobHandlers, createImageJobHandlers } from "./jobs/handlers/index.js"
const require = createRequire(import.meta.url)
const { normalizeNetworkRequest, requestPluginNetwork } = require("../../src/main/services/plugin-network-client.js")

const packageJson = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"))

const INIT_TIMEOUT_MS = 10_000
const SHUTDOWN_GRACE_MS = 5_000

function readSettingsPath(values, path) {
	let current = values
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined
		current = current[segment]
	}
	return current
}

function writeSettingsPath(values, path, value) {
	const segments = path.split(".")
	let current = values
	for (const segment of segments.slice(0, -1)) {
		if (current[segment] === null || typeof current[segment] !== "object" || Array.isArray(current[segment])) current[segment] = {}
		current = current[segment]
	}
	current[segments.at(-1)] = structuredClone(value)
}

function hostEffectValues(values, paths) {
	const result = {}
	for (const path of SETTINGS_CANONICAL_PATHS) {
		if (!paths.includes(path)) continue
		const value = readSettingsPath(values, path)
		if (value !== undefined) writeSettingsPath(result, path, value)
	}
	return result
}

const EXIT_NO_IPC = 64
const EXIT_INIT_TIMEOUT = 65
const EXIT_HTTP_FAILED = 66
const EXIT_UNCAUGHT = 70

// ⚠️ 这两行必须在任何 await 之前执行。
// ESM 的顶层 await 会推迟模块求值,而 Shell 在 fork 返回后就可能立刻发 init;
// 先挂监听并缓存,才不会丢掉握手的第一条消息。
const inbox = []
let deliver = (raw) => {
	inbox.push(raw)
}
process.on("message", (raw) => deliver(raw))

const logger = createLogger()

function createLogger() {
	// 结构化日志走 stderr,stdout 留给将来可能的二进制/流式输出。
	// Shell 侧把两个流都转发进 app-log-service。
	let sanitize = (value) => value
	const safe = (value) => {
		try {
			return sanitize(value)
		} catch {
			return "[log-sanitization-failed]"
		}
	}
	const write = (level, message, fields) => {
		const sanitizedFields = safe(fields ?? {})
		const line = {
			at: new Date().toISOString(),
			level,
			message: safe(message),
			...(sanitizedFields && typeof sanitizedFields === "object" && !Array.isArray(sanitizedFields) ? sanitizedFields : {}),
		}
		process.stderr.write(JSON.stringify(line) + "\n")
	}
	return {
		info: (message, fields) => write("info", message, fields),
		warn: (message, fields) => write("warn", message, fields),
		error: (message, fields) => write("error", message, fields),
		setSanitizer: (next) => { sanitize = typeof next === "function" ? next : (value) => value },
	}
}

if (typeof process.send !== "function") {
	logger.error("backend 必须由 Shell fork 启动,当前缺少 IPC 通道", {
		hint: "调试用法见 services/backend/README.md「独立运行」",
	})
	process.exit(EXIT_NO_IPC)
}

const shell = createShellClient({
	send: (envelope) => process.send(envelope),
	exit: (code) => process.exit(code),
	logger,
})

// ⚠️ 顺序敏感,三步不能调:
//   1. 先注册 init 的等待者
//   2. 再把 deliver 指向 shellClient
//   3. 最后排空 inbox
// 若把排空提到注册之前,已经到达的 init 会在 pending/waiters/handlers 都为空时
// 进入 receive(),被静默丢弃,后端随后等 10 秒超时退出。
const initPromise = shell.waitFor("init", { timeoutMs: INIT_TIMEOUT_MS })

deliver = (raw) => shell.receive(raw)
for (const raw of inbox.splice(0)) shell.receive(raw)

const runtime = {
	sessionToken: randomBytes(32).toString("hex"),
	startedAt: Date.now(),
	// ADR-010:密钥由 Shell 在 init 里一次性注入,只存在内存,不落盘、不出响应体。
	secrets: null,
	userDataDir: null,
	// ADR-009:/api/pet/* 与 /mcp 沿用旧 token,由 init 带入;没带就等于关掉这两个入口。
	legacyToken: null,
	appInfo: null,
	petState: null,
	degraded: false,
	degradedReason: null,
	db: null,
	settings: null,
	jobs: null,
	logs: null,
	service: null,
	catalog: null,
	petPacks: null,
	actions: null,
	plugins: null,
	commandServer: null,
	about: null,
	queue: null,
	runner: null,
	enqueueJob: null,
	ai: null,
}

const initEnvelope = await initPromise.catch((error) => {
	logger.error("等待 Shell 的 init 超时,退出", { timeoutMs: INIT_TIMEOUT_MS, error: String(error) })
	process.exit(EXIT_INIT_TIMEOUT)
	return null
})

runtime.secrets = createProviderKeyStore({
	providerKeys: initEnvelope.body.providerKeys ?? {},
	persist: async ({ providerId, value }) => {
		const reply = await shell.request(
			{ type: "secrets.persist.request", providerId, value },
			{ expectedType: "secrets.persist.result" },
		)
		if (reply.body.providerId !== providerId) throw new Error("Shell secret persistence response provider mismatch")
		if (reply.body.ok !== true) throw new Error(reply.body.error || "Shell secret persistence failed")
	},
	logger,
})
logger.setSanitizer(runtime.secrets.sanitizeLogValue)
// The store cloned providerKeys into closure memory. Drop the init envelope's
// plaintext reference so ordinary diagnostics cannot retain a second copy.
delete initEnvelope.body.providerKeys
delete initEnvelope.body.secrets
runtime.userDataDir = initEnvelope.body.userDataDir ?? null
runtime.legacyToken = initEnvelope.body.legacyToken ?? null
runtime.appInfo = initEnvelope.body.appInfo ?? {}
const legacyLocalHttpConfig = initEnvelope.body.localHttpConfig ?? { enabled: false, host: "127.0.0.1", port: 0 }

const accessLogs = createAccessLogBuffer({ max: 200 })
const router = createRouter({ basePath: "/api/v1" })
// ADR-015:事件总线是唯一的失效通知来源。SSE 订阅、设置变更、Job/恢复钩子都走它。
const eventHub = createEventHub({ logger })
runtime.events = eventHub
shell.on(EVENT_PET_PACK_ACTIVATED, (envelope) => {
	eventHub.publish(EVENT_PET_PACK_ACTIVATED, envelope.body.payload)
})

router.use(requestId())
router.use(errorBoundary({ logger }))
router.use(accessLog({ buffer: accessLogs, logger, appendHttp: (entry) => runtime.logs?.appendHttp?.(entry) }))
router.use(loopbackOnly())
router.use(cors())
router.use(
	bearerAuth({
		getSessionToken: () => runtime.sessionToken,
	}),
)
router.use(jsonBody())

// 03 篇 §4.1。注意 /health 也在 bearerAuth 之后 —— 未鉴权一律 401,不设例外。
registerHealthRoutes({
	router,
	runtime,
	includeBusinessRoutes: false,
	deps: { logger, cleanup: () => runtime.logs?.cleanup?.() },
})

// Routes are assembled before storage initialization, so resolve the store
// from runtime when each request runs.
const runtimeSettingsStore = {
	read: (...args) => runtime.settings.read(...args),
	patch: (...args) => runtime.settings.patch(...args),
}
const settingsMutationCoordinator = createSettingsMutationCoordinator({
	emit: (name, payload) => {
		eventHub.publish(name, payload)
		if (name === "settings.changed") shell.send({ type: "settings.changed", paths: payload.paths, version: payload.version })
	},
})
const settingsMutationAuthority = createSettingsMutationAuthority({ store: runtimeSettingsStore, coordinator: settingsMutationCoordinator })
registerSettingsRoutes({
	router,
	store: runtimeSettingsStore,
	mutationCoordinator: settingsMutationCoordinator,
	mutationAuthority: settingsMutationAuthority,
	awaitHostApply: async ({ paths, version }) => {
		const snapshot = runtime.settings.read()
		const reply = await shell.request({ type: "settings.apply.request", paths, version, values: hostEffectValues(snapshot.values, paths) })
		if (reply?.body?.ok !== true) throw new Error(reply?.body?.error || "Shell settings host effect failed")
		return reply
	},
	emit: (name, payload) => {
		eventHub.publish(name, payload)
		if (name === "settings.changed") shell.send({ type: "settings.changed", paths: payload.paths, version: payload.version })
	},
})
runtime.about = createAboutService({ pkg: packageJson, runtime: runtime.appInfo })
registerAboutRoutes(router, {
	about: runtime.about,
	jobs: { insert: (input) => {
		if (!runtime.enqueueJob) throw new Error("Job service unavailable")
		return runtime.enqueueJob(input)
	} },
})
runtime.service = createLocalHttpManager({
	settings: runtime.settings,
	secrets: { localHttpToken: runtime.legacyToken },
	shell,
	petState: () => runtime.petState,
	logger,
})
if (legacyLocalHttpConfig.enabled) {
	try {
		await runtime.service.start(legacyLocalHttpConfig)
	} catch (error) {
		logger.error("MCP HTTP server startup failed", { error: String(error) })
	}
}
registerServiceRoutes(router, { manager: runtime.service })
registerAiSecretRoutes(router, { secrets: runtime.secrets })
registerAiRoutes(router, { jobs: { insert: (input) => {
		if (!runtime.enqueueJob) throw new Error("Job service unavailable")
		return runtime.enqueueJob(input)
	} } })
runtime.catalog = createCatalogService({
	root: join(dirname(fileURLToPath(import.meta.url)), "../.."),
	db: runtime.db,
	logger,
	shell,
	emit: (name, payload) => eventHub.publish(name, payload),
})
registerCatalogRoutes(router, {
	catalog: runtime.catalog,
	jobs: { insert: (input) => runtime.enqueueJob?.(input) },
})
runtime.petPacks = createPetPackService({
	shell,
	jobs: { insert: (input) => runtime.enqueueJob?.(input) },
})
registerPetPackRoutes(router, { packs: runtime.petPacks })
runtime.actions = createActionService({
	shell,
	jobs: { insert: (input) => runtime.enqueueJob?.(input) },
	emit: (name, payload) => eventHub.publish(name, payload),
})
registerActionRoutes(router, { actions: runtime.actions })

registerEventRoutes({ router, hub: eventHub })

const server = createServer((req, res) => {
	void router.handle(req, res)
})

server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
// SSE 是长连接,不能让 Node 按固定时长掐断请求。
server.requestTimeout = 0

server.on("error", (error) => {
	logger.error("HTTP server 出错", { error: String(error) })
	shell.send({ type: "degraded", reason: "http-server-error" })
	process.exit(EXIT_HTTP_FAILED)
})

await initializeBackendRuntime({
	runtime,
	userDataDir: runtime.userDataDir,
	shell,
	logger,
	deps: {
		beforeStore: () => createProcessLedger({ userDataDir: runtime.userDataDir, logger }).sweep(),
		createSettingsStore,
		openDatabase,
		migrate,
		migrateFromJson,
		needsJsonImport,
		createJobsRepository,
		createLogsRepository,
		recoverJobs: (options) => recoverJobs({ ...options, requeueRecovered: false }),
		initializePlugins: () => {
			let runtimeBridgeServer
			const processLedger = createProcessLedger({ userDataDir: runtime.userDataDir, logger })
			const pluginFacade = {
				get: (id) => runtime.plugins?.get?.(id),
				definition: (id) => runtime.plugins?.definition?.(id),
				config: (id) => runtime.plugins?.config?.(id),
				runtimeDirs: (id) => runtime.plugins?.runtimeDirs?.(id),
				appendLog: (entry) => runtime.plugins?.appendLog?.(entry),
				submitTriggerProposal: (pluginId, payload) => runtime.actions.submitProposal({ ...payload, sourcePluginId: pluginId }),
				handleCommandCapability: (pluginId, capability, payload, options) => runtimeBridgeServer.handleCapability(pluginId, capability, payload, options),
			}
				runtimeBridgeServer = createPluginRuntimeServer({
					shell,
					plugins: pluginFacade,
					settings: runtime.settings,
				jobs: { insert: (input) => runtime.enqueueJob(input) },
				logs: { appendPlugin: (entry) => runtime.plugins.appendLog(entry) },
				network: {
					fetch: (plugin, payload, { signal } = {}) => {
						const manifest = plugin?.manifest ?? plugin
						const { url, request } = normalizeNetworkRequest(manifest, payload)
						return requestPluginNetwork({ manifest, url, request, signal })
					},
				},
				logger,
			})
			const commandServer = createPluginCommandServer({
				plugins: pluginFacade,
				jobs: { insert: (input) => runtime.enqueueJob(input) },
				processLedger,
				logger,
			})
			runtime.commandServer = commandServer
			return createInitializedPluginService({
				db: runtime.db,
				jobs: runtime.jobs,
				logs: runtime.logs,
				bridge: shell,
				dialog: shell,
				root: join(dirname(fileURLToPath(import.meta.url)), "../.."),
				userDataDir: runtime.userDataDir,
				settings: runtime.settings,
				mutationAuthority: settingsMutationAuthority,
				logger,
				emit: (name, payload) => eventHub.publish(name, payload),
				runtimeBridgeServer,
				commandServer,
				processLedger,
			})
		},
	},
	bind: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
})

if (!runtime.degraded && runtime.jobs) {
	runtime.ai = createAiService({ settings: runtime.settings, secrets: runtime.secrets, fetchImpl: globalThis.fetch, logger, userDataDir: runtime.userDataDir })
	runtime.queue = createQueue({ repo: runtime.jobs, logger })
	runtime.runner = createRunner({
		repo: runtime.jobs,
		queue: runtime.queue,
		logger,
		emit: (name, payload) => eventHub.publish(name, payload),
		tmpRoot: runtime.tmpDir ?? join(runtime.userDataDir, "backend", "tmp"),
		handlers: {
			"about.check-updates": async ({ report }) => { report({ phase: "checking", percent: 25 }); return runtime.about.checkUpdates() },
			"catalog.install": async ({ job, report, signal, finalize }) => {
				report({ phase: "installing", percent: 25 })
				if (signal.aborted) throw signal.reason ?? new Error("Job canceled")
				return finalize(() => runtime.catalog.installSelection(job.input?.selectionId))
			},
			"pet-pack.import": async ({ job, report, signal, finalize }) => runtime.petPacks.runImport({ ...job.input, signal, report, finalize }),
			"pet-pack.export": async ({ job, report, signal, finalize }) => runtime.petPacks.runExport({ ...job.input, signal, report, finalize }),
			"actions.import-frames": async ({ job, report, signal, finalize }) => runtime.actions.runImportFrames({ ...job.input, signal, report, finalize }),
			...createPluginJobHandlers({
				db: runtime.db,
				plugins: runtime.plugins,
				logger,
			}),
			...createImageJobHandlers({ ai: runtime.ai }),
		},
	})
	runtime.enqueueJob = createJobDispatcher({
		queue: runtime.queue,
		runner: runtime.runner,
		publish: (name, payload) => eventHub.publish(name, payload),
		logger,
	})
	// Recovery already persisted queued jobs. Enqueue by id so the queue does
	// not attempt to insert an existing SQLite row a second time.
	for (const job of runtime.jobs.list({ status: "queued", limit: 1_000 })) runtime.queue.enqueue(job.id)
	while (true) {
		const next = runtime.queue.next()
		if (!next) break
		void runtime.runner.run(next).catch((error) => logger.error("恢复 Job 执行失败", { jobId: next.id, error: String(error) }))
	}
} else {
	runtime.enqueueJob = () => { throw new Error("Job service unavailable") }
}

registerJobRoutes(router, { jobs: runtime.jobs ?? { byId: () => null }, runner: runtime.runner, dispatcher: runtime.enqueueJob })
// Plugin domain initializes after the HTTP listener is assembled. Keep route
// handlers bound to the current runtime service instead of the initial null.
const pluginRouteFacade = new Proxy({}, {
	get: (_target, property) => {
		if (property === "enqueueJob") return runtime.enqueueJob
		const service = runtime.plugins
		const value = service?.[property]
		return typeof value === "function" ? value.bind(service) : value
	},
})
registerPluginRoutes(router, { plugins: pluginRouteFacade })

const address = server.address()

shell.send({
	type: "ready",
	port: address.port,
	// 03 篇 §7 规则 5:apiVersion 是字符串 "v1",不是数字 1。
	apiVersion: "v1",
	pid: process.pid,
	sessionToken: runtime.sessionToken,
	startupMs: Date.now() - runtime.startedAt,
})

logger.info("backend ready", {
	port: address.port,
	pid: process.pid,
	startupMs: Date.now() - runtime.startedAt,
	routes: router.routes().length,
})

shell.on("shutdown", () => {
	void shutdown("shell-request", 0)
})

shell.on("pet.stateSnapshot", (envelope) => {
	// ADR-003:PetService 留在主进程,后端只持有一份只读快照。
	runtime.petState = envelope.body.state ?? null
})

shell.on("power.suspend", () => {
	logger.info("收到 power.suspend")
	// M3:在这里暂停 Job 队列取新任务,已 running 的按 04 篇 §2.6 走 interrupted。
})

shell.on("power.resume", () => {
	logger.info("收到 power.resume")
	// M3:恢复队列并触发一次 system.jobs-recovered。
})

// Host-normalized settings are persisted only across the private process
// boundary. Renderer-originated HTTP PATCH requests cannot impersonate this.
shell.on("settings.persist.request", (envelope) => {
	void settingsMutationCoordinator.runTrusted(async () => {
		const body = envelope.body
		let result
		try {
			const request = parsePatch({ ifVersion: body.ifVersion, patch: body.patch }, { trusted: true })
			if (Object.keys(request.patch).some((path) => !SETTINGS_TRUSTED_PATHS.includes(path))) {
				throw new Error("trusted settings persistence path is not allowed")
			}
			const mutation = settingsMutationAuthority.patch(request, { publish: false })
			result = { version: mutation.version, ok: true, changedPaths: mutation.changedPaths }
			if (mutation.changedPaths.length > 0) {
				settingsMutationCoordinator.publish(EVENT_SETTINGS_CHANGED, { paths: mutation.changedPaths, version: mutation.version })
			}
		} catch (error) {
			const snapshot = runtime.settings.read()
			result = {
				version: snapshot.version,
				ok: false,
				changedPaths: [],
				error: error?.message || String(error),
				errorCode: error?.code || "INTERNAL",
			}
		}
		shell.reply(envelope.id, { type: "settings.persist.result", ...result })
	})
})

let shuttingDown = false

async function shutdown(reason, code) {
	if (shuttingDown) return
	shuttingDown = true
	logger.info("开始关闭", { reason })

	// 兜底:宽限期内没关干净就硬退,避免 Shell 那边等到超时再 SIGKILL。
	const hardExit = setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS)
	hardExit.unref()

	// 03 篇 §5:关闭前通知订阅方,让前端切掉本地缓存并准备重连。
	eventHub.publish(EVENT_BACKEND_SHUTTING_DOWN, { reason })
	eventHub.closeAll()
	await runtime.plugins?.stopAll?.()
	try {
		await runtime.plugins?.closeLogs?.()
	} catch (error) {
		logger.error("插件日志关闭失败", { error: String(error) })
	}
	await runtime.plugins?.runtimeBridgeServer?.close?.()
	await runtime.commandServer?.close?.()
	try {
		await runtime.service?.stop?.()
	} catch (error) {
		logger.error("MCP HTTP server shutdown failed", { error: String(error) })
	}
	await runtime.runner?.shutdown?.()
	runtime.queue?.stop?.()
	await new Promise((resolve) => server.close(resolve))
	if (runtime.db !== null) runtime.db.close()
	shell.dispose()

	clearTimeout(hardExit)
	process.exit(code)
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0))
process.on("SIGINT", () => void shutdown("SIGINT", 0))

process.on("uncaughtException", (error) => {
	logger.error("未捕获异常", { error: String(error), stack: error?.stack })
	void shutdown("uncaughtException", EXIT_UNCAUGHT)
})

process.on("unhandledRejection", (reason) => {
	// 不退进程:单个请求的 promise 崩了不该带走整个后端。
	logger.error("未处理的 rejection", { reason: String(reason) })
})
