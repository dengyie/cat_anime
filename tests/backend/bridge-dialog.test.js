"use strict"

const assert = require("node:assert/strict")
const { before, describe, it } = require("node:test")

let bridge
let shellClient
const shellMessageHandler = require("../../apps/desktop/src/sidecar/message-handler")

before(async () => {
	bridge = await import("../../services/backend/bridge/message-schema.js")
	shellClient = await import("../../services/backend/bridge/shell-client.js")
})

function resultEnvelope(id, paths) {
	return bridge.createEnvelope(
		{
			type: "dialog.result",
			requestId: id,
			paths,
		},
		{ id },
	)
}

describe("dialog.request bridge", () => {
	it("backend whitelist contains exactly the 17 contract message types", () => {
		assert.equal(bridge.BACKEND_TO_SHELL_TYPES.length, 17)
		assert.equal(new Set(bridge.BACKEND_TO_SHELL_TYPES).size, 17)
		assert.equal(bridge.BACKEND_TO_SHELL_TYPES.includes("dialog.request"), true)
		assert.equal(bridge.BACKEND_TO_SHELL_TYPES.includes("catalog.request"), true)
		assert.equal(bridge.BACKEND_TO_SHELL_TYPES.includes("pet-packs.request"), true)
		assert.equal(bridge.SHELL_TO_BACKEND_TYPES.length, 14, "settings, secrets, Catalog, Pet Pack, Actions and pet command host results are part of the bridge contract")
	})

	it("request and dialog.result correlate with the same envelope id", async () => {
		const sent = []
		const client = shellClient.createShellClient({ send: (envelope) => sent.push(envelope) })

		const responsePromise = client.request({ type: "dialog.request", mode: "directory" })
		assert.equal(sent.length, 1)
		assert.equal(sent[0].body.requestId, sent[0].id)
		assert.equal(sent[0].body.mode, "directory")

		client.receive(resultEnvelope(sent[0].id, ["/tmp/openpet"]))
		const response = await responsePromise
		assert.equal(response.id, sent[0].id)
		assert.deepEqual(response.body.paths, ["/tmp/openpet"])
		client.dispose()
	})

	it("times out after 60 seconds with PROVIDER_TIMEOUT / 504", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] })
		const sent = []
		const client = shellClient.createShellClient({ send: (envelope) => sent.push(envelope) })
		const responsePromise = client.request({ type: "dialog.request", mode: "file" })

		t.mock.timers.tick(bridge.DIALOG_RESULT_TIMEOUT_MS)
		await assert.rejects(responsePromise, (error) => {
			assert.equal(error.code, "PROVIDER_TIMEOUT")
			assert.equal(error.status, 504)
			assert.equal(error.retryable, true)
			assert.equal(error.details.envelopeId, sent[0].id)
			return true
		})
		client.dispose()
	})

	it("treats paths: null as a successful cancellation result", async () => {
		const sent = []
		const client = shellClient.createShellClient({ send: (envelope) => sent.push(envelope) })
		const responsePromise = client.request({ type: "dialog.request", mode: "file" })

		client.receive(resultEnvelope(sent[0].id, null))
		const response = await responsePromise
		assert.equal(response.body.requestId, sent[0].id)
		assert.equal(response.body.paths, null)
		client.dispose()
	})

	it("rejects a same-id response with the wrong type for settings host effects", async () => {
		const sent = []
		const client = shellClient.createShellClient({ send: (envelope) => sent.push(envelope) })
		const responsePromise = client.request({ type: "settings.apply.request", paths: ["scale"], version: 4, values: { scale: 1.2 } })

		client.receive(resultEnvelope(sent[0].id, null))
		await assert.rejects(responsePromise, /unexpected Shell response type: expected settings\.apply\.result, got dialog\.result/)
		client.dispose()
	})

	it("accepts a valid settings host-effect response with the correlated id", async () => {
		const sent = []
		const client = shellClient.createShellClient({ send: (envelope) => sent.push(envelope) })
		const responsePromise = client.request({ type: "settings.apply.request", paths: ["scale"], version: 4, values: { scale: 1.2 } })

		client.receive(bridge.createEnvelope({ type: "settings.apply.result", version: 4, ok: true }, { id: sent[0].id }))
		const response = await responsePromise
		assert.equal(response.id, sent[0].id)
		assert.deepEqual(response.body, { type: "settings.apply.result", version: 4, ok: true })
		client.dispose()
	})

	it("binds secret persistence to a strict response that cannot echo plaintext", async () => {
		const sent = []
		const client = shellClient.createShellClient({ send: (envelope) => sent.push(envelope) })
		const responsePromise = client.request({ type: "secrets.persist.request", providerId: "openai", value: "provider-secret" })

		client.receive(bridge.createEnvelope({
			type: "secrets.persist.result",
			providerId: "openai",
			ok: true,
			value: "provider-secret",
		}, { id: sent[0].id }))

		await assert.rejects(responsePromise, /unexpected fields/)
		client.dispose()
	})

	it("binds catalog requests to catalog.result and rejects an invalid success body", async () => {
		const sent = []
		const client = shellClient.createShellClient({ send: (envelope) => sent.push(envelope) })
		const responsePromise = client.request({ type: "catalog.request", request: { operation: "listCatalog" } })

		client.receive(bridge.createEnvelope({ type: "catalog.result", ok: true }, { id: sent[0].id }))
		await assert.rejects(responsePromise, /catalog\.result has no result/)
		client.dispose()
	})

	it("requires envelope at to be a positive integer in backend and Shell parsers", () => {
		for (const at of [0, -1, 1.5]) {
			const raw = bridge.createEnvelope({ type: "ready", port: 3210, apiVersion: "v1", pid: 42 }, { at })
			assert.equal(bridge.parseEnvelope(raw).ok, false, `backend accepted at=${at}`)
			assert.equal(shellMessageHandler.parseEnvelope(raw).ok, false, `Shell accepted at=${at}`)
		}
	})

	it("keeps Shell allowlist mechanically aligned with the contract", async () => {
		const contracts = await import("@openpet/contracts")
		assert.deepEqual(bridge.BACKEND_TO_SHELL_TYPES, contracts.backendToShellSchema.options.map((option) => option.shape.type.value))
	})

	it("rejects in-flight requests when the Shell client is disposed", async () => {
		const client = shellClient.createShellClient({ send: () => {} })
		const pending = client.request({ type: "dialog.request", mode: "file" })
		client.dispose()
		const settled = await Promise.race([
			pending.then(() => false, () => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 25)),
		])
		assert.equal(settled, true)
	})
})
