export const IMPLEMENTED_API_ROUTES = Object.freeze([
	...AI_RUNTIME_ROUTES,
	"GET /health",
	"GET /service/status",
	"POST /service/enable",
	"POST /service/token/rotate",
	"POST /service/token/revoke-sessions",
	"GET /service/logs",
	"DELETE /service/logs",
	"GET /service/config",
	"PUT /service/config",
	"POST /service/diagnostics",
	"PUT /ai/providers/:id/key",
	"DELETE /ai/providers/:id/key",
	"POST /ai/images/generate",
	"GET /about",
	"POST /about/check-updates",
	"GET /settings",
	"PATCH /settings",
	"POST /settings/cursor/import",
	"POST /settings/preview-scale",
	"GET /settings/schema",
	"GET /actions",
	"POST /actions/frames/inspect",
	"POST /actions/frames/reinspect",
	"POST /actions/frames/import",
	"DELETE /actions/frames/selection",
	"PUT /actions/config",
	"DELETE /actions/:id",
	"POST /actions/triggers/preview",
	"POST /actions/triggers/proposals",
	"POST /actions/triggers/proposals/:id/accept",
	"POST /actions/triggers/proposals/:id/reject",
	"PATCH /actions/triggers/rules/:id",
	"DELETE /actions/triggers/rules/:id",
	"GET /pet-packs",
	"POST /pet-packs/import",
	"POST /pet-packs/:id/activate",
	"DELETE /pet-packs/:id",
	"POST /pet-packs/:id/export",
	"GET /pet-packs/:id/manifest",
	"POST /pet-packs/validate",
	"GET /catalog",
	"POST /catalog/refresh",
	"GET /catalog/:id",
	"POST /catalog/prepare",
	"POST /catalog/install",
	"POST /catalog/clear-selection",
	"POST /catalog/blocklist",
	"DELETE /catalog/blocklist/:id",
	"GET /catalog/installed",
	"POST /catalog/source",
	"GET /jobs",
	"GET /jobs/:id",
	"POST /jobs/:id/cancel",
	"POST /jobs/:id/retry",
	"GET /jobs/:id/events",
	"DELETE /jobs/completed",
	"GET /plugins",
	"GET /plugins/:id",
	"POST /plugins/install",
	"POST /plugins/install/github",
	"DELETE /plugins/:id",
	"POST /plugins/:id/enable",
	"POST /plugins/:id/start",
	"POST /plugins/:id/stop",
	"POST /plugins/:id/restart",
	"GET /plugins/:id/status",
	"GET /plugins/:id/logs",
	"DELETE /plugins/:id/logs",
	"POST /plugins/:id/commands/:cmd",
	"GET /plugins/:id/permissions",
	"PUT /plugins/:id/permissions",
	"POST /plugins/:id/native-approval",
	"POST /plugins/validate",
	"POST /plugins/sync-bundled",
	"GET /plugins/:id/config",
	"PUT /plugins/:id/config",
])

const noop = () => ({})
const service = new Proxy({}, { get: () => noop })
const actions = new Proxy({}, { get: () => noop })
const packs = new Proxy({}, { get: () => noop })
const catalog = new Proxy({}, { get: () => noop })
const plugins = new Proxy({}, { get: () => noop })

export function registeredImplementedRoutes() {
	const router = createRouter({ basePath: "/api/v1" })
	registerHealthRoutes({ router, runtime: { degraded: false, startedAt: 0, db: null, secrets: null }, includeBusinessRoutes: false })
	registerServiceRoutes(router, { manager: service })
	registerAiSecretRoutes(router, { secrets: service })
	registerAiRoutes(router, { jobs: { insert: noop } })
	registerAiRuntimeRoutes(router, { getDomain: () => service })
	registerAboutRoutes(router, { about: { info: noop }, jobs: { insert: noop } })
	registerSettingsRoutes({ router, store: { read: noop, patch: () => ({ version: 0, changedPaths: [] }) } })
	registerActionRoutes(router, { actions })
	registerPetPackRoutes(router, { packs })
	registerCatalogRoutes(router, { catalog, jobs: { insert: noop } })
	registerJobRoutes(router, { jobs: { byId: noop }, runner: { cancel: noop }, dispatcher: { resume: noop } })
	registerPluginRoutes(router, { plugins })
	return router.routes().map((route) => route.replace(" /api/v1/", " /"))
}
import { createRouter } from "../http/router.js"
import { registerAboutRoutes } from "./about.js"
import { registerActionRoutes } from "./actions.js"
import { registerCatalogRoutes } from "./catalog.js"
import { registerHealthRoutes } from "./health.js"
import { registerJobRoutes } from "./jobs.js"
import { registerPetPackRoutes } from "./pet-packs.js"
import { registerServiceRoutes } from "./service.js"
import { registerSettingsRoutes } from "./settings.js"
import { registerPluginRoutes } from "./plugins.js"
import { registerAiSecretRoutes, registerAiRoutes } from "./ai.js"
import { AI_RUNTIME_ROUTES, registerAiRuntimeRoutes } from "./ai-runtime.js"
