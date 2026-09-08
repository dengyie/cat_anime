"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")

async function fixture(t, options = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-actions-cutover-"))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const { createActionService } = await import("../../services/backend/domains/actions.js")
	return createActionService({ root, ...options })
}

test("Actions reads the active Shell view including proposals, rules and diagnostics", async (t) => {
	const expected = { defaultAction: "doro-idle", clickAction: "wave", actions: [{ id: "doro-idle" }, { id: "wave" }], triggerProposalInbox: [{ id: "proposal:1" }], triggerRules: [{ id: "rule:1" }], triggerRuntimeDiagnostics: { currentState: { actionId: "wave" }, decisions: [{ ruleId: "rule:1" }] } }
	const requests = []
	const actions = await fixture(t, { shell: { request: async (body, options) => {
		requests.push({ body, options })
		return { body: { type: "actions.result", operation: "get", ok: true, result: expected } }
	} } })
	assert.deepEqual(await actions.list(), expected)
	assert.equal(requests[0].body.type, "actions.request")
	assert.equal(requests[0].options.expectedType, "actions.result")
	assert.equal(requests[0].options.expectedOperation, "get")
})

test("Actions rejects mismatched authority responses and preserves domain errors", async (t) => {
	let response = { type: "actions.result", operation: "remove", ok: true, result: {} }
	const actions = await fixture(t, { shell: { request: async () => ({ body: response }) } })
	await assert.rejects(async () => actions.list(), (error) => error.code === "INTERNAL")
	response = { type: "actions.result", operation: "get", ok: false, error: { code: "CONFLICT", message: "Active pack changed" } }
	await assert.rejects(async () => actions.list(), (error) => error.code === "CONFLICT" && error.status === 409)
})

test("Actions queues opaque selection handles and enters finalizing before Shell import", async (t) => {
	const events = []
	let queued
	const result = { ok: true, canceled: false, result: { importedAction: { id: "wave" } }, animations: { actions: [{ id: "wave" }] } }
	const actions = await fixture(t, {
		jobs: { insert: (input) => { queued = input; return { id: "job-1" } } },
		shell: { request: async (body) => {
			events.push("shell-import")
			assert.equal(body.operation, "import")
			assert.deepEqual(body.payload, { selectionId: "selection-1", actionId: "wave", label: "Wave" })
			return { body: { type: "actions.result", operation: "import", ok: true, result } }
		} },
	})
	assert.deepEqual(await actions.importFrames({ selectionId: "selection-1", actionId: "wave", label: "Wave" }), { jobId: "job-1" })
	assert.equal(queued.kind, "actions.import-frames")
	assert.deepEqual(queued.input, { selectionId: "selection-1", actionId: "wave", label: "Wave" })
	assert.deepEqual(events, [])
	assert.deepEqual(await actions.runImportFrames({ ...queued.input, finalize: async (operation) => { events.push("finalizing"); return operation() } }), result)
	assert.deepEqual(events, ["finalizing", "shell-import"])
})

test("Actions cancellation before finalizing never crosses the Shell write boundary", async (t) => {
	let calls = 0
	const controller = new AbortController()
	controller.abort(new Error("cancelled"))
	const actions = await fixture(t, { shell: { request: async () => { calls += 1 } } })
	await assert.rejects(() => actions.runImportFrames({ selectionId: "selection-1", actionId: "wave", signal: controller.signal, finalize: (fn) => fn() }), /cancelled/)
	assert.equal(calls, 0)
})
