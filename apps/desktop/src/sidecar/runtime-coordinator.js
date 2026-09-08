"use strict"

const { spawnSidecar: defaultSpawnSidecar, stopSidecar: defaultStopSidecar } = require("./spawn")
const { createMessageHandler: defaultCreateMessageHandler } = require("./message-handler")

function safeLog(logger, level, message, fields) {
	try {
		logger?.[level]?.(message, fields)
	} catch {
		// Logging must not affect sidecar lifecycle.
	}
}

function failureReason(error) {
	return error?.code || error?.message || "SIDECAR_UNAVAILABLE"
}

function validatePendingResponse(raw, responseType) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "response is not an object"
	if (raw.v !== 1) return `unexpected response version: ${String(raw.v)}`
	if (typeof raw.id !== "string" || raw.id.length === 0) return "response has an invalid id"
	if (!Number.isInteger(raw.at) || raw.at <= 0) return "response has an invalid timestamp"
	const body = raw.body
	if (body === null || typeof body !== "object" || Array.isArray(body) || body.type !== responseType) {
		return `unexpected sidecar response: ${body?.type || "unknown"}`
	}
	if (responseType === "settings.persist.result") {
		if (!Number.isInteger(body.version) || body.version < 0) return "settings persistence response has an invalid version"
		if (typeof body.ok !== "boolean") return "settings persistence response has an invalid ok field"
		if (!Array.isArray(body.changedPaths) || body.changedPaths.some((path) => typeof path !== "string")) {
			return "settings persistence response has invalid changedPaths"
		}
		if (body.error !== undefined && typeof body.error !== "string") return "settings persistence response has an invalid error"
		if (body.errorCode !== undefined && typeof body.errorCode !== "string") return "settings persistence response has an invalid errorCode"
	}
	return null
}

async function createDefaultInitBody({ app, getSettings, secretService }) {
	const settings = await getSettings?.()
	return {
		userDataDir: app?.getPath?.("userData"),
		providerKeys: secretService?.listProviderKeys?.() || {},
		legacyToken: settings?.localHttp?.token || null,
		localHttpConfig: {
			enabled: Boolean(settings?.localHttp?.enabled),
			host: settings?.localHttp?.host || "127.0.0.1",
			port: Number(settings?.localHttp?.port) || 0,
		},
		appInfo: {
			name: app?.getName?.() || "OpenPet",
			version: app?.getVersion?.() || "0.0.0",
			packaged: Boolean(app?.isPackaged),
			platform: process.platform,
			arch: process.arch,
		},
	}
}

function createSidecarRuntimeCoordinator(options = {}) {
	const spawnSidecar = options.spawnSidecar || defaultSpawnSidecar
	const stopSidecar = options.stopSidecar || defaultStopSidecar
	const createMessageHandler = options.createMessageHandler || defaultCreateMessageHandler
	const pidLedger = options.pidLedger || null
	const listeners = new Set()
	let state = { status: "stopped", backend: null, reason: null }
	let child = null
	let startPromise = null
	let stopPromise = null
	let generation = 0
	let requestSequence = 0
	const backendPending = new Map()
	const rejectBackendPending = (reason) => {
		for (const pending of backendPending.values()) {
			clearTimeout(pending.timer)
			pending.reject(new Error(reason))
		}
		backendPending.clear()
	}

	function publish(nextState) {
		state = nextState
		const backend = nextState.status === "ready" ? nextState.backend : null
		for (const listener of [...listeners]) {
			try { listener(backend) } catch (error) {
				safeLog(options.logger, "warn", "sidecar state listener failed", { error: String(error) })
			}
		}
	}

	function degrade(reason, expectedGeneration) {
		if (expectedGeneration !== generation || state.status === "stopped") return
		publish({ status: "degraded", backend: null, reason: reason || "SIDECAR_UNAVAILABLE" })
	}

	function start() {
		if (state.status === "ready") return Promise.resolve(state.backend)
		if (startPromise) return startPromise
		stopPromise = null
		const currentGeneration = ++generation
		publish({ status: "starting", backend: null, reason: null })
		startPromise = (async () => {
			try {
				// Sweep before launching a new child so a previous crash cannot leave
				// an older sidecar (or its descendants) running beside this session.
				try {
					await pidLedger?.sweep?.()
				} catch (error) {
					safeLog(options.logger, "warn", "sidecar orphan cleanup failed", { error: String(error) })
				}
				const initBody = typeof options.getInitBody === "function"
					? await options.getInitBody()
					: await createDefaultInitBody(options)
				let messageHandler = null
				let exitedBeforeReady = false
				let earlyExitReason = null
				const result = await spawnSidecar({
					initBody,
					logger: options.logger,
					onMessage(raw) {
					const pending = backendPending.get(raw?.id)
					if (pending) {
						backendPending.delete(raw.id)
						clearTimeout(pending.timer)
						const validationError = validatePendingResponse(raw, pending.responseType)
						if (validationError) {
							pending.reject(new Error(validationError))
						} else {
							pending.resolve(raw)
						}
							return
						}
						Promise.resolve(messageHandler?.handle?.(raw)).then((handled) => {
							if (handled && raw?.body?.type === "degraded") degrade(raw.body.reason, currentGeneration)
						}).catch((error) => {
							safeLog(options.logger, "error", "sidecar message handling failed", { error: String(error) })
						})
					},
						onExit(code) {
						exitedBeforeReady = true
						earlyExitReason = code == null ? "SIDECAR_EXITED" : `SIDECAR_EXIT_${code}`
						if (currentGeneration !== generation || state.status === "stopped") return
						child = null
						rejectBackendPending("sidecar exited")
						degrade(earlyExitReason, currentGeneration)
					},
				})
				if (currentGeneration !== generation) {
					await stopSidecar(result.child)
					return null
				}
				if (exitedBeforeReady) {
					degrade(earlyExitReason, currentGeneration)
					return null
				}
				child = result.child
				// The fork handle is authoritative; the ready envelope PID is metadata
				// supplied by the child and must not redirect ledger ownership.
				const pid = Number(result.child?.pid || result.pid) || 0
				if (pid > 0) {
					try {
						pidLedger?.register?.(pid, {
							startedAt: result.startedAt,
							processName: result.processName,
						})
					} catch (error) {
						safeLog(options.logger, "warn", "sidecar PID ledger register failed", { pid, error: String(error) })
					}
				}
				messageHandler = createMessageHandler({
					dialog: options.dialog,
					petService: options.petService,
					secretService: options.secretService,
					logger: options.logger,
					send: (message) => child?.send?.(message),
					onNotify: options.onNotify,
					onBadge: options.onBadge,
						onDashboard: options.onDashboard,
					productionService: options.productionService,
					onSettingsChanged: options.onSettingsChanged,
					onSettingsApplyRequest: options.onSettingsApplyRequest,
					onCatalogRequest: options.onCatalogRequest,
					onPetPackRequest: options.onPetPackRequest,
					onActionsRequest: options.onActionsRequest,
					})
				const backend = { baseUrl: result.baseUrl, sessionToken: result.sessionToken }
				publish({ status: "ready", backend, reason: null })
				await options.onReady?.(backend)
				return backend
			} catch (error) {
				safeLog(options.logger, "error", "sidecar startup failed", { error: String(error) })
				degrade(failureReason(error), currentGeneration)
				return null
			} finally {
				rejectBackendPending("sidecar unavailable")
				startPromise = null
			}
		})()
		return startPromise
	}

	function stop() {
		if (stopPromise) return stopPromise
		const pendingStart = startPromise
		const currentChild = child
		const currentPid = Number(currentChild?.pid) || 0
		generation += 1
		rejectBackendPending("sidecar stopped")
		child = null
		publish({ status: "stopped", backend: null, reason: null })
		stopPromise = (async () => {
			await pendingStart?.catch(() => {})
			if (currentChild) {
				await stopSidecar(currentChild)
				if (currentPid > 0) {
					try {
						pidLedger?.unregister?.(currentPid)
					} catch (error) {
						safeLog(options.logger, "warn", "sidecar PID ledger unregister failed", { pid: currentPid, error: String(error) })
					}
				}
			}
		})()
		return stopPromise
	}

	return {
		start,
		stop,
		getBackend: () => state.status === "ready" ? { ...state.backend } : null,
		getState: () => ({ ...state, backend: state.backend ? { ...state.backend } : null }),
		requestBackend(body, requestOptions = {}) {
			if (state.status !== "ready" || !child?.send) return Promise.reject(new Error("sidecar unavailable"))
			if (
				body?.type !== "settings.persist.request"
				|| !Number.isInteger(body.ifVersion)
				|| body.ifVersion < 0
				|| !body.patch
				|| typeof body.patch !== "object"
				|| Array.isArray(body.patch)
			) throw new Error("invalid backend settings persistence request")
			const id = `shell-${process.pid}-${++requestSequence}`
			const envelope = { v: 1, id, at: Date.now(), body: structuredClone(body) }
			const timeoutMs = Number.isInteger(requestOptions.timeoutMs) ? requestOptions.timeoutMs : 60_000
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					backendPending.delete(id)
					reject(new Error(`sidecar request timed out: ${body.type}`))
				}, timeoutMs)
				timer.unref?.()
				backendPending.set(id, { resolve, reject, timer, responseType: "settings.persist.result" })
				try {
					child.send(envelope, (error) => {
						if (!error) return
						backendPending.delete(id)
						clearTimeout(timer)
						reject(error)
					})
				} catch (error) {
					backendPending.delete(id)
					clearTimeout(timer)
					reject(error)
				}
			})
		},
		notifyBackend(body) {
			if (body?.type !== "pet.pack-activated" || body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) {
				throw new Error("invalid backend Pet Pack notification")
			}
			if (state.status !== "ready" || !child?.send) return false
			const envelope = {
				v: 1,
				id: `shell-${process.pid}-${++requestSequence}`,
				at: Date.now(),
				body: structuredClone(body),
			}
			try {
				child.send(envelope, (error) => {
					if (error) safeLog(options.logger, "warn", "sidecar notification failed", { type: body.type, error: String(error) })
				})
				return true
			} catch (error) {
				safeLog(options.logger, "warn", "sidecar notification failed", { type: body.type, error: String(error) })
				return false
			}
		},
		onChanged(listener) {
			if (typeof listener !== "function") throw new TypeError("listener must be a function")
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
}

module.exports = { createSidecarRuntimeCoordinator }
