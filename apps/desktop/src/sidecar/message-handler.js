"use strict"

const { sanitizeLogText } = require("../../../../src/main/services/log-safety")

const BRIDGE_PROTOCOL_VERSION = 1
const CATALOG_BLOCKLIST_TYPES = new Set(["pluginId", "packId", "sha256"])

function exactKeys(value, keys) {
	const actual = Object.keys(value).sort()
	const expected = [...keys].sort()
	return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function nonEmptyString(value) { return typeof value === "string" && value.trim().length > 0 }

function normalizeCatalogRequest(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.operation !== "string") return null
	switch (value.operation) {
		case "listCatalog": return exactKeys(value, ["operation"]) ? { operation: value.operation } : null
		case "prepareInstall":
			return exactKeys(value, ["operation", "kind", "itemId"]) && ["plugin", "pet-pack"].includes(value.kind) && nonEmptyString(value.itemId)
				? { operation: value.operation, kind: value.kind, itemId: value.itemId } : null
		case "installSelection":
		case "clearSelection":
			return exactKeys(value, ["operation", "selectionId"]) && nonEmptyString(value.selectionId)
				? { operation: value.operation, selectionId: value.selectionId } : null
		case "addBlocklistEntry":
		case "removeBlocklistEntry":
			return exactKeys(value, ["operation", "type", "value"]) && CATALOG_BLOCKLIST_TYPES.has(value.type) && nonEmptyString(value.value)
				? { operation: value.operation, type: value.type, value: value.value } : null
		default: return null
	}
}

// Keep this list frozen in the Shell as well as in the backend bridge client.
// A backend message is untrusted input at this boundary: only these explicitly
// capabilities may reach Electron/PetService.
const BACKEND_TO_SHELL_TYPES = Object.freeze([
	"actions.request",
	"pet.command.request",
	"pet.say",
	"pet.playAction",
	"pet.event",
	"window.openPluginDashboard",
	"notify",
	"tray.setBadge",
	"ready",
	"degraded",
	"dialog.request",
	"settings.changed",
	"settings.apply.request",
	"settings.persist.result",
	"secrets.persist.request",
	"catalog.request",
	"pet-packs.request",
])

const PET_PACK_OPERATIONS = Object.freeze([
	"list",
	"manifest",
	"validate",
	"clear-selection",
	"import",
	"export",
	"activate",
	"remove",
])
let contractErrorCodesPromise = null

async function normalizePetPackErrorCode(value) {
	if (typeof value !== "string") return "INTERNAL"
	contractErrorCodesPromise ??= import("@openpet/contracts").then(({ ERROR_CODES }) => new Set(ERROR_CODES))
	try {
		return (await contractErrorCodesPromise).has(value) ? value : "INTERNAL"
	} catch {
		return "INTERNAL"
	}
}

function log(logger, level, message, fields) {
	try {
		logger?.[level]?.(message, fields)
	} catch {
		// A logger must never take down the Shell message loop.
	}
}

function dialogProperties(mode) {
	return mode === "directory" ? ["openDirectory"] : ["openFile"]
}

function fail(reason, detail) {
	return { ok: false, reason, detail: detail ?? null }
}

function parseEnvelope(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("not-object")
	if (raw.v !== BRIDGE_PROTOCOL_VERSION) return fail("version-mismatch", raw.v)
	if (typeof raw.id !== "string" || raw.id.length === 0) return fail("bad-id", raw.id)
	if (!Number.isInteger(raw.at) || raw.at <= 0) return fail("bad-at", raw.at)
	const body = raw.body
	let normalizedBody = body
	if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.type !== "string") {
		return fail("bad-body")
	}
	if (!BACKEND_TO_SHELL_TYPES.includes(body.type)) return fail("unknown-type", body.type)

	switch (body.type) {
		case "actions.request":
			if (typeof body.operation !== "string" || body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) return fail("bad-body", "actions.request")
			break
		case "pet.command.request":
			if (!["say", "playAction", "setEvent"].includes(body.operation) || body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) return fail("bad-body", "pet.command.request")
			break
		case "pet.say":
			if (typeof body.text !== "string") return fail("bad-body", "pet.say.text")
			if (body.durationMs !== undefined && (!Number.isInteger(body.durationMs) || body.durationMs <= 0)) return fail("bad-body", "pet.say.durationMs")
			break
		case "pet.playAction":
			if (typeof body.actionId !== "string" || (body.loop !== undefined && typeof body.loop !== "boolean")) return fail("bad-body", "pet.playAction")
			break
		case "pet.event":
			if (typeof body.name !== "string") return fail("bad-body", "pet.event.name")
			break
		case "window.openPluginDashboard":
			if (typeof body.pluginId !== "string" || body.pluginId.length === 0) return fail("bad-body", "window.openPluginDashboard.pluginId")
			break
		case "notify":
			if (!["info", "warn", "error"].includes(body.level) || typeof body.message !== "string") return fail("bad-body", "notify")
			break
		case "tray.setBadge":
			if (!Number.isInteger(body.count) || body.count < 0) return fail("bad-body", "tray.setBadge.count")
			break
		case "ready":
			if (!Number.isInteger(body.port) || body.port <= 0 || body.apiVersion !== "v1" || !Number.isInteger(body.pid) || body.pid <= 0) return fail("bad-body", "ready")
			break
		case "degraded":
			if (typeof body.reason !== "string") return fail("bad-body", "degraded.reason")
			break
		case "settings.changed":
			if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string") || !Number.isInteger(body.version) || body.version < 0) return fail("bad-body", "settings.changed")
			break
		case "settings.apply.request":
			if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string") || !Number.isInteger(body.version) || body.version < 0 || (body.values !== undefined && (body.values === null || typeof body.values !== "object" || Array.isArray(body.values)))) return fail("bad-body", "settings.apply.request")
			break
		case "pet-packs.request":
			if (!PET_PACK_OPERATIONS.includes(body.operation) || body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) return fail("bad-body", "pet-packs.request")
			break
		case "dialog.request":
			if (typeof body.requestId !== "string" || !["file", "directory"].includes(body.mode)) return fail("bad-body", "dialog.request")
			break
		case "secrets.persist.request":
			if (typeof body.providerId !== "string" || body.providerId.trim().length === 0) return fail("bad-body", "secrets.persist.request.providerId")
			if (body.value !== null && (typeof body.value !== "string" || body.value.trim().length === 0)) return fail("bad-body", "secrets.persist.request.value")
			if (Object.keys(body).some((key) => !["type", "providerId", "value"].includes(key))) return fail("bad-body", "secrets.persist.request.fields")
			break
		case "catalog.request": {
			const request = normalizeCatalogRequest(body.request)
			if (!exactKeys(body, ["type", "request"]) || !request) return fail("bad-body", "catalog.request")
			normalizedBody = { type: body.type, request }
			break
		}
	}

	return { ok: true, envelope: { v: raw.v, id: raw.id, at: raw.at, body: normalizedBody } }
}

function createMessageHandler({ dialog, petService, secretService, logger, send, onNotify, onBadge, onDashboard, onSettingsChanged, onSettingsApplyRequest, onCatalogRequest, onPetPackRequest, onActionsRequest, productionService } = {}) {
	if (typeof send !== "function") throw new TypeError("createMessageHandler 需要 send")

	async function handle(raw) {
		const parsed = parseEnvelope(raw)
		if (!parsed.ok) {
			log(logger, "warn", "丢弃无效的 sidecar 消息", { reason: parsed.reason, detail: parsed.detail })
			return false
		}
		const { body } = parsed.envelope

		try {
			switch (body.type) {
				case "pet-packs.request": {
					let responseBody
					try {
						if (typeof onPetPackRequest !== "function") {
							throw Object.assign(new Error("Shell Pet Pack authority unavailable"), { code: "BACKEND_UNAVAILABLE" })
						}
						const result = await onPetPackRequest({
							operation: body.operation,
							payload: structuredClone(body.payload),
						})
						responseBody = { type: "pet-packs.result", operation: body.operation, ok: true, result }
					} catch (error) {
						responseBody = {
							type: "pet-packs.result",
							operation: body.operation,
							ok: false,
							error: {
								code: await normalizePetPackErrorCode(error?.code),
								message: error?.message || String(error),
							},
						}
					}
					send({ v: BRIDGE_PROTOCOL_VERSION, id: raw.id, at: Date.now(), body: responseBody })
					return true
				}
				case "actions.request": {
					const { actionsRequestSchema } = await import("@openpet/contracts")
					const request = actionsRequestSchema.safeParse(body)
					if (!request.success) {
						log(logger, "warn", "invalid Actions bridge request", { operation: body.operation })
						return false
					}
					let responseBody
					try {
						if (typeof onActionsRequest !== "function") throw Object.assign(new Error("Shell Actions authority unavailable"), { code: "BACKEND_UNAVAILABLE" })
						const result = await onActionsRequest({ operation: request.data.operation, payload: structuredClone(request.data.payload) })
						responseBody = { type: "actions.result", operation: body.operation, ok: true, result }
					} catch (error) {
						responseBody = { type: "actions.result", operation: body.operation, ok: false, error: {
							code: await normalizePetPackErrorCode(error?.code),
							message: sanitizeLogText(error?.message || String(error)),
						} }
					}
					send({ v: BRIDGE_PROTOCOL_VERSION, id: raw.id, at: Date.now(), body: responseBody })
					return true
				}
				case "pet.command.request": {
					let result
					try {
						if (body.operation === "say") result = await petService?.say?.({
							text: body.payload.text,
							ttlMs: body.payload.ttlMs,
							source: body.payload.source,
							sourceSurface: body.payload.sourceSurface,
							requestId: body.payload.requestId,
						})
						else if (body.operation === "playAction") result = await petService?.playAction?.({
							actionId: body.payload.actionId,
							source: body.payload.source,
						})
						else if (body.operation === "setEvent") result = await petService?.setEvent?.({
							type: body.payload.type,
							message: body.payload.message,
							ttlMs: body.payload.ttlMs,
							source: body.payload.source,
						})
						send({ v: BRIDGE_PROTOCOL_VERSION, id: raw.id, at: Date.now(), body: { type: "pet.command.result", ok: true, result } })
					} catch (error) {
						send({ v: BRIDGE_PROTOCOL_VERSION, id: raw.id, at: Date.now(), body: { type: "pet.command.result", ok: false, error: sanitizeLogText(error?.message || String(error)) } })
					}
					return true
				}
				case "plugin.production.request": {
					if (typeof productionService !== "function") throw new Error("Plugin production service unavailable")
					const result = await productionService(body)
					send({ v: BRIDGE_PROTOCOL_VERSION, id: raw.id, at: Date.now(), body: { type: "plugin.production.result", requestId: raw.id, result } })
					return true
				}
				case "pet.say":
					petService?.say?.({ text: body.text, durationMs: body.durationMs, source: "backend" })
					return true
				case "pet.playAction":
					petService?.playAction?.({ actionId: body.actionId, loop: body.loop, source: "backend" })
					return true
				case "pet.event":
					petService?.setEvent?.({ event: body.name, payload: body.payload, source: "backend" })
					return true
				case "notify":
					onNotify?.(body)
					return true
				case "tray.setBadge":
					onBadge?.(body.count)
					return true
				case "window.openPluginDashboard":
					// Shell owns all BrowserWindow options. The backend may identify the
					// plugin only; URL/preload/webPreferences/path are deliberately dropped.
					onDashboard?.({ pluginId: body.pluginId })
					return true
				case "ready":
				case "degraded":
					return true
				case "settings.changed":
					onSettingsChanged?.({ paths: [...body.paths], version: body.version })
					return true
				case "settings.apply.request": {
					let result
					try {
						if (typeof onSettingsApplyRequest !== "function") throw new Error("Shell settings host effect unavailable")
						await onSettingsApplyRequest({
							v: parsed.envelope.v,
							id: parsed.envelope.id,
							at: parsed.envelope.at,
							body: {
								type: body.type,
								paths: [...body.paths],
								version: body.version,
								...(body.values === undefined ? {} : { values: structuredClone(body.values) }),
							},
						})
						result = { ok: true }
					} catch (error) {
						result = { ok: false, error: error?.message || String(error) }
					}
					send({ v: BRIDGE_PROTOCOL_VERSION, id: raw.id, at: Date.now(), body: { type: "settings.apply.result", version: body.version, ...result } })
					return true
				}
				case "secrets.persist.request": {
					const providerId = body.providerId.trim()
					let result
					try {
						if (!secretService) throw new Error("Shell secret service unavailable")
						if (body.value === null) {
							if (typeof secretService.deleteSecret !== "function") throw new Error("Shell secret deletion unavailable")
							await secretService.deleteSecret(providerId)
						} else {
							if (typeof secretService.setSecret !== "function") throw new Error("Shell secret persistence unavailable")
							await secretService.setSecret({ id: providerId, value: body.value, label: providerId, kind: "provider" })
						}
						result = { ok: true }
					} catch (error) {
						log(logger, "error", "Provider key persistence failed", {
							providerId,
							error: sanitizeLogText(error?.message || String(error), { secretValues: [body.value] }),
						})
						result = { ok: false, error: "Provider key persistence failed" }
					}
					send({
						v: BRIDGE_PROTOCOL_VERSION,
						id: raw.id,
						at: Date.now(),
						body: { type: "secrets.persist.result", providerId, ...result },
					})
					return true
				}
				case "catalog.request": {
					let response
					try {
						if (typeof onCatalogRequest !== "function") throw new Error("Shell Catalog service unavailable")
						response = { ok: true, result: await onCatalogRequest(body.request) }
					} catch (error) { response = { ok: false, error: error?.message || String(error) } }
					send({ v: BRIDGE_PROTOCOL_VERSION, id: raw.id, at: Date.now(), body: { type: "catalog.result", ...response } })
					return true
				}
				case "dialog.request": {
					if (typeof dialog?.showOpenDialog !== "function") throw new Error("Shell dialog 不可用")
					const result = await dialog.showOpenDialog({ properties: dialogProperties(body.mode) })
					const paths = result?.canceled ? null : (Array.isArray(result?.filePaths) ? result.filePaths : [])
					send({
						v: BRIDGE_PROTOCOL_VERSION,
						id: raw.id,
						at: Date.now(),
						body: { type: "dialog.result", requestId: body.requestId, paths },
					})
					return true
				}
				default:
					// parseEnvelope's immutable allowlist makes this unreachable.
					return false
			}
		} catch (error) {
			log(logger, "error", "处理 sidecar 消息失败", { type: body.type, error: String(error) })
			return false
		}
	}

	return { handle }
}

module.exports = { BACKEND_TO_SHELL_TYPES, createMessageHandler, parseEnvelope }
