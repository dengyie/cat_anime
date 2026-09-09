import path from "node:path"

import { ApiError, sendSuccess } from "../http/middleware.js"

export const LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000

const ROUTES = Object.freeze([
	["GET", "/health"],
	["GET", "/service/status"],
	["POST", "/service/enable"],
	["POST", "/service/token/rotate"],
	["GET", "/service/logs"],
	["DELETE", "/service/logs"],
	["GET", "/service/config"],
	["POST", "/service/diagnostics"],
	["GET", "/about"],
	["POST", "/about/check-updates"],
])

function routeLabel(method, routePath) {
	return method + " " + routePath
}

function unavailableHandler(label) {
	return () => {
		throw new ApiError("BACKEND_UNAVAILABLE", label + " 尚未接入对应业务域")
	}
}

function degradedGate(runtime) {
	return async (ctx, next) => {
		const allowed = ctx.routePath === "/health" || ctx.routePath === "/service" ||
			ctx.routePath?.startsWith("/service/")
		if (!runtime.degraded || allowed) {
			await next()
			return
		}
		throw new ApiError("MIGRATION_REQUIRED", "数据库不可用,后端处于降级模式", {
			status: 503,
			details: { reason: runtime.degradedReason ?? null },
			retryable: false,
		})
	}
}

function scheduleLogCleanup({ cleanup, logger, setInterval: schedule = setInterval } = {}) {
	if (typeof cleanup !== "function") return null
	const timer = schedule(() => {
		Promise.resolve(cleanup()).catch((error) => {
			logger?.warn?.("清理过期日志失败", { error: String(error) })
		})
	}, LOG_CLEANUP_INTERVAL_MS)
	timer?.unref?.()
	return timer
}

export function registerHealthRoutes({ router, runtime, deps = {}, includeBusinessRoutes = true } = {}) {
	if (!router || typeof router.register !== "function") throw new TypeError("registerHealthRoutes 需要 router")
	if (!runtime || typeof runtime !== "object") throw new TypeError("registerHealthRoutes 需要 runtime")

	router.use(degradedGate(runtime))
	const handlers = deps.handlers ?? {}
	const routes = includeBusinessRoutes ? ROUTES : ROUTES.filter(([, routePath]) => routePath === "/health")
	for (const [method, routePath] of routes) {
		const label = routeLabel(method, routePath)
		let handler = handlers[label]
		if (routePath === "/health") {
			handler = (ctx) => {
				sendSuccess(ctx, {
					status: runtime.degraded ? "degraded" : "ok",
					pid: deps.pid ?? process.pid,
					apiVersion: "v1",
					uptimeMs: (deps.now ?? Date.now)() - runtime.startedAt,
					store: runtime.db === null ? "not-opened" : runtime.db.driverName,
					secretsLoaded: runtime.secrets !== null,
				})
			}
		}
		router.register(method, routePath, handler ?? unavailableHandler(label))
	}

	return { cleanupTimer: scheduleLogCleanup(deps) }
}

function startupPaths(userDataDir) {
	if (typeof userDataDir !== "string" || userDataDir.length === 0) {
		throw new Error("init 缺少 userDataDir")
	}
	const backendDir = path.join(userDataDir, "backend")
	return {
		backendDir,
		settingsFile: path.join(backendDir, "settings.json"),
		databaseFile: path.join(backendDir, "openpet.db"),
		tmpDir: path.join(backendDir, "tmp"),
	}
}

function degradedReason(error) {
	return typeof error?.code === "string" ? error.code : "BACKEND_UNAVAILABLE"
}

export async function initializeBackendRuntime({ runtime, userDataDir, shell, logger, bind, deps } = {}) {
	if (!runtime || typeof runtime !== "object") throw new TypeError("initializeBackendRuntime 需要 runtime")
	if (typeof bind !== "function") throw new TypeError("initializeBackendRuntime 需要 bind")
	const required = ["createSettingsStore", "openDatabase", "migrate", "createJobsRepository", "createLogsRepository", "recoverJobs"]
	for (const name of required) {
		if (typeof deps?.[name] !== "function") throw new TypeError("initializeBackendRuntime 缺少 deps." + name)
	}

	let paths = null
	let recovery = null
	try {
		paths = startupPaths(userDataDir)
		// Plugin PID cleanup must happen before opening SQLite.  The ledger is a
		// standalone atomic JSON file so degraded DB startup cannot strand plugins.
		if (typeof deps.beforeStore === "function") await deps.beforeStore({ userDataDir, paths })
		runtime.settings = deps.createSettingsStore({ file: paths.settingsFile, logger })
		runtime.db = await deps.openDatabase({ file: paths.databaseFile, logger })
		// Sample before schema migration: the import gate is intentionally based on
		// an empty schema_migrations ledger, while import itself runs after migrate.
		const importNeeded = typeof deps.needsJsonImport === "function" ? deps.needsJsonImport(runtime.db) : false
		await deps.migrate({ db: runtime.db, logger })
		if (importNeeded && typeof deps.migrateFromJson === "function") {
			await deps.migrateFromJson({
				db: runtime.db,
				userDataDir,
				now: deps.now,
				logger,
				onProgress: deps.onMigrationProgress,
				force: true,
			})
		}
		if (deps.upgradeAiJsonStore) await deps.upgradeAiJsonStore({ db: runtime.db, userDataDir, logger })
		runtime.jobs = deps.createJobsRepository({ db: runtime.db })
		runtime.logs = deps.createLogsRepository({ db: runtime.db })
		recovery = await deps.recoverJobs({
			repo: runtime.jobs,
			tmpDir: paths.tmpDir,
			emit: deps.emit,
			logger,
		})
		if (typeof deps.initializePlugins === "function") {
			runtime.plugins = await deps.initializePlugins({ runtime, paths })
		}
		runtime.tmpDir = paths.tmpDir
	} catch (error) {
		runtime.degraded = true
		runtime.degradedReason = degradedReason(error)
		logger?.error?.("后端存储初始化失败,进入降级模式", {
			reason: runtime.degradedReason,
			error: String(error),
		})
		shell?.send?.({ type: "degraded", reason: runtime.degradedReason })
	}

	await bind()
	return { paths, recovery, degraded: runtime.degraded }
}

export const HEALTH_AND_SERVICE_ROUTES = Object.freeze(ROUTES.map(([method, routePath]) => routeLabel(method, routePath)))
