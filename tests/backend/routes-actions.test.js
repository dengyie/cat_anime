"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { describe, it } = require("node:test")

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "openpet-t19-"))

describe("T19 actions", () => {
	it("registers the documented 13 routes and emits actions changed", async () => {
		const [{ createRouter }, routes, { createActionService }, contracts] = await Promise.all([
			import("../../services/backend/http/router.js"), import("../../services/backend/routes/actions.js"), import("../../services/backend/domains/actions.js"), import("@openpet/contracts"),
		])
		const root = temp(); fs.mkdirSync(path.join(root, "cat_anime"), { recursive: true }); fs.writeFileSync(path.join(root, "cat_anime", "animations.json"), JSON.stringify({ defaultAction: "idle", clickAction: "idle", actions: [{ id: "idle", label: "Idle", kind: "idle", sprite: "sprites/idle.png" }], triggerProposalInbox: [], triggerRules: [] }))
		const events = []; const actions = createActionService({ root, emit: (name) => events.push(name) }); const router = createRouter({ basePath: "/api/v1" }); routes.registerActionRoutes(router, { actions })
		assert.deepEqual(router.routes(), routes.ACTION_ROUTES.map((entry) => { const [method, route] = entry.split(" "); return `${method} /api/v1${route}` }))
		actions.update("idle", { label: "Idle" }); assert.deepEqual(events, [contracts.EVENT_ACTIONS_CHANGED])
	})

	it("uses ACTION_FRAMES_MISSING for an empty folder", async () => {
		const { createActionService } = await import("../../services/backend/domains/actions.js")
		const folder = temp(); const root = temp();
		await assert.rejects(() => createActionService({ root }).inspect(folder), (error) => error.code === "ACTION_FRAMES_MISSING" && error.status === 400)
	})
})
