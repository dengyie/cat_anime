"use strict"

const assert = require("node:assert/strict")
const { test } = require("node:test")
const { createMessageHandler } = require("../../apps/desktop/src/sidecar/message-handler")

const envelope = (body, id = "actions-1") => ({ v: 1, id, at: Date.now(), body })

test("Actions replies remain bound to the request operation and result shape", async (t) => {
	const { createShellClient } = await import("../../services/backend/bridge/shell-client.js")
	const cases = [
		[{ type: "dialog.result", requestId: "actions-1", paths: null }, /unexpected Shell response type/],
		[{ type: "actions.result", operation: "remove", ok: true, result: {} }, /unexpected.*operation/i],
		[{ type: "actions.result", operation: "get", ok: true }, /no result/],
		[{ type: "actions.result", operation: "get", ok: "yes", result: {} }, /invalid ok/],
		[{ type: "actions.result", operation: "get", ok: false, error: "not structured" }, /structured error/],
		[{ type: "actions.result", operation: "get", ok: false, error: { code: "MADE_UP", message: "failed" } }, /invalid error code/],
	]
	for (const [body, pattern] of cases) {
		await t.test(JSON.stringify(body), async () => {
			const sent = []
			const client = createShellClient({ send: (message) => sent.push(message) })
			t.after(() => client.dispose())
			const pending = client.request({ type: "actions.request", operation: "get", payload: {} })
			client.receive(envelope(body, sent[0].id))
			await assert.rejects(pending, pattern)
		})
	}
})

test("Shell validates Actions requests before dispatch and returns correlated active state", async () => {
	const sent = []
	const requests = []
	const state = { defaultAction: "active-idle", actions: [{ id: "active-idle" }], triggerRuntimeDiagnostics: { decisions: [] } }
	const handler = createMessageHandler({
		send: (response) => sent.push(response),
		onActionsRequest: (request) => { requests.push(request); return state },
	})
	for (const body of [
		{ type: "actions.request", operation: "__proto__", payload: {} },
		{ type: "actions.request", operation: "get", payload: [] },
		{ type: "actions.request", operation: "get", payload: {}, execute: "arbitrary" },
	]) assert.equal(await handler.handle(envelope(body)), false)
	assert.deepEqual(requests, [])
	assert.deepEqual(sent, [])
	assert.equal(await handler.handle(envelope({ type: "actions.request", operation: "get", payload: {} })), true)
	assert.deepEqual(requests, [{ operation: "get", payload: {} }])
	assert.equal(sent[0].id, "actions-1")
	assert.deepEqual(sent[0].body, { type: "actions.result", operation: "get", ok: true, result: state })
})

test("Shell Actions errors retain domain codes and redact provider credentials", async () => {
	const sent = []
	const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"
	const handler = createMessageHandler({
		send: (response) => sent.push(response),
		onActionsRequest: () => { throw Object.assign(new Error("request failed apiKey=" + secret), { code: "CONFLICT" }) },
	})
	await handler.handle(envelope({ type: "actions.request", operation: "import", payload: { selectionId: "opaque", actionId: "wave" } }))
	assert.equal(sent[0].body.ok, false)
	assert.equal(sent[0].body.error.code, "CONFLICT")
	assert.equal(JSON.stringify(sent).includes(secret), false)
})
