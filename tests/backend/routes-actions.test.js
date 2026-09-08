"use strict"

const assert = require("node:assert/strict")
const http = require("node:http")
const { test } = require("node:test")

async function fixture(t, options = {}) {
	const [{ createRouter }, routes, { createActionService }, { jsonBody }] = await Promise.all([
		import("../../services/backend/http/router.js"),
		import("../../services/backend/routes/actions.js"),
		import("../../services/backend/domains/actions.js"),
		import("../../services/backend/http/middleware.js"),
	])
	const requests = []
	const events = []
	const queued = []
	const snapshot = { defaultAction: "active-idle", clickAction: "wave", actions: [{ id: "active-idle" }, { id: "wave" }], triggerRules: [], triggerProposalInbox: [] }
	const actions = createActionService({
		shell: { request: async (body) => {
			requests.push(body)
			await Promise.resolve()
			if (options.error) return { body: { type: "actions.result", operation: body.operation, ok: false, error: options.error } }
			return { body: { type: "actions.result", operation: body.operation, ok: true, result: body.operation === "get" ? snapshot : { ok: true, animations: snapshot } } }
		} },
		jobs: { insert: (job) => { queued.push(job); return { id: "queued-import" } } },
		emit: (name, payload) => events.push({ name, payload }),
	})
	const router = createRouter({ basePath: "/api/v1" })
	router.use(jsonBody())
	routes.registerActionRoutes(router, { actions })
	const server = http.createServer(router.handle)
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
	const request = async (route, method = "GET", body) => {
		const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/v1" + route, {
			method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
		return { status: response.status, body: await response.json() }
	}
	return { router, routes, requests, events, queued, snapshot, request }
}

test("Actions registers its 13 routes and awaits the active Shell snapshot", async (t) => {
	const ctx = await fixture(t)
	assert.deepEqual(ctx.router.routes(), ctx.routes.ACTION_ROUTES.map((entry) => {
		const [method, route] = entry.split(" ")
		return method + " /api/v1" + route
	}))
	const response = await ctx.request("/actions")
	assert.equal(response.status, 200)
	assert.deepEqual(response.body.data, ctx.snapshot)
	const saved = await ctx.request("/actions/config", "PUT", { defaultAction: "wave" })
	assert.deepEqual(saved.body.data.animations, ctx.snapshot)
	assert.deepEqual(ctx.requests[1], { type: "actions.request", operation: "save-config", payload: { defaultAction: "wave" } })
	assert.equal(ctx.events.length, 1)
	assert.equal(ctx.events[0].name, (await import("@openpet/contracts")).EVENT_ACTIONS_CHANGED)
})

test("Actions HTTP preserves opaque selections and queues import before any host write", async (t) => {
	const ctx = await fixture(t)
	await ctx.request("/actions/frames/reinspect", "POST", { selectionId: "native-selection", actionId: "jump" })
	await ctx.request("/actions/frames/selection?selectionId=native-selection", "DELETE")
	const response = await ctx.request("/actions/frames/import", "POST", { selectionId: "native-selection", actionId: "jump", label: "Jump" })
	assert.equal(response.status, 202)
	assert.deepEqual(response.body.data, { jobId: "queued-import" })
	assert.deepEqual(ctx.requests.map(({ operation, payload }) => ({ operation, payload })), [
		{ operation: "reinspect", payload: { selectionId: "native-selection", actionId: "jump" } },
		{ operation: "clear-selection", payload: { selectionId: "native-selection" } },
	])
	assert.deepEqual(ctx.queued[0].input, { selectionId: "native-selection", actionId: "jump", label: "Jump" })
	assert.deepEqual(ctx.events, [])
	const invalid = await ctx.request("/actions/frames/import", "POST", { path: "/renderer/path", actionId: "jump" })
	assert.equal(invalid.status, 400)
	assert.equal(ctx.queued.length, 1)
})

test("Actions HTTP forwards proposal and rule inputs with the host response intact", async (t) => {
	const ctx = await fixture(t)
	for (const [method, route, body, operation, payload] of [
		["POST", "/actions/triggers/preview", { actionId: "wave" }, "preview-proposal", { actionId: "wave" }],
		["POST", "/actions/triggers/proposals", { actionId: "wave" }, "submit-proposal", { actionId: "wave" }],
		["POST", "/actions/triggers/proposals/p1/accept", {}, "accept-proposal", { proposalId: "p1" }],
		["POST", "/actions/triggers/proposals/p1/reject", { reason: "Rejected" }, "reject-proposal", { proposalId: "p1", reason: "Rejected" }],
		["PATCH", "/actions/triggers/rules/r1", { status: "disabled" }, "update-rule", { ruleId: "r1", status: "disabled" }],
		["DELETE", "/actions/triggers/rules/r1", undefined, "delete-rule", { ruleId: "r1" }],
		["DELETE", "/actions/wave", undefined, "remove", { actionId: "wave" }],
	]) {
		const response = await ctx.request(route, method, body)
		assert.equal(response.status, 200, route)
		assert.deepEqual(response.body.data, { ok: true, animations: ctx.snapshot })
		assert.deepEqual(ctx.requests.at(-1), { type: "actions.request", operation, payload })
	}
})

test("Actions HTTP preserves ACTION_FRAMES_MISSING as a 400 without success events", async (t) => {
	const ctx = await fixture(t, { error: { code: "ACTION_FRAMES_MISSING", message: "No frame images" } })
	const response = await ctx.request("/actions/frames/inspect", "POST", { path: "/empty", actionId: "jump" })
	assert.equal(response.status, 400)
	assert.equal(response.body.error.code, "ACTION_FRAMES_MISSING")
	assert.deepEqual(ctx.events, [])
})
