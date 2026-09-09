"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { describe, it } = require("node:test")

const {
	BACKEND_TO_SHELL_TYPES: SHELL_BACKEND_TO_SHELL_TYPES,
	createMessageHandler,
} = require("../../apps/desktop/src/sidecar/message-handler.js")

const EXPECTED_BACKEND_TO_SHELL_TYPES = [
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
	"ai.state",
	"ai.host.request",
]

function envelope(type, body = {}) {
	return {
		v: 1,
		id: `test-${type}`,
		at: Date.now(),
		body: { type, ...body },
	}
}

function contractBackendToShellTypes() {
	const source = fs.readFileSync(path.join(__dirname, "../../packages/contracts/src/bridge.ts"), "utf8")
	const start = source.indexOf("export const backendToShellSchema")
	const end = source.indexOf("export type BackendToShell", start)
	assert.notEqual(start, -1, "backendToShellSchema must exist in packages/contracts")
	assert.notEqual(end, -1, "BackendToShell type must follow backendToShellSchema")
	return [...source.slice(start, end).matchAll(/type: z\.literal\("([^"]+)"\)/g)].map((match) => match[1])
}

	describe("T28 reverse-channel allowlist", () => {
	it("keeps the Backend and Shell allowlists exactly aligned with the 19 contract types", async () => {
		const backendSchema = await import("../../services/backend/bridge/message-schema.js")

		assert.deepEqual(contractBackendToShellTypes(), EXPECTED_BACKEND_TO_SHELL_TYPES)
		assert.deepEqual(backendSchema.BACKEND_TO_SHELL_TYPES, EXPECTED_BACKEND_TO_SHELL_TYPES)
		assert.deepEqual(SHELL_BACKEND_TO_SHELL_TYPES, EXPECTED_BACKEND_TO_SHELL_TYPES)
		assert.equal(new Set(SHELL_BACKEND_TO_SHELL_TYPES).size, 19)
	})

	it("drops malformed and non-allowlisted envelopes and logs each rejection", async () => {
		const warnings = []
		const calls = []
		const handler = createMessageHandler({
			send() {},
			petService: { say: (...args) => calls.push(args) },
			logger: { warn: (message, fields) => warnings.push({ message, fields }) },
		})

		assert.equal(await handler.handle(envelope("shell.executePath", { path: "/tmp/owned" })), false)
		assert.equal(await handler.handle({ ...envelope("pet.say", { text: "ignored" }), v: 2 }), false)
		assert.equal(await handler.handle({ ...envelope("pet.say", { text: "ignored" }), id: "" }), false)
		assert.equal(await handler.handle({ ...envelope("pet.say", { text: "ignored" }), at: "now" }), false)
		assert.deepEqual(calls, [])
		assert.equal(warnings.length, 4)
		assert.deepEqual(warnings.map((entry) => entry.fields?.reason), [
			"unknown-type",
			"version-mismatch",
			"bad-id",
			"bad-at",
		])
	})

	it("executes only the three allowlisted pet commands and returns their exact result", async () => {
		const replies = []
		const calls = []
		const handler = createMessageHandler({
			send: (reply) => replies.push(reply),
			petService: {
				say: (payload) => { calls.push(["say", payload]); return payload },
				playAction: (payload) => { calls.push(["playAction", payload]); return payload },
				setEvent: (payload) => { calls.push(["setEvent", payload]); return payload },
			},
		})
		assert.equal(await handler.handle(envelope("pet.command.request", {
			operation: "setEvent",
			payload: { type: "status", message: "working", ttlMs: 900, source: "http" },
		})), true)
		assert.deepEqual(calls, [["setEvent", { type: "status", message: "working", ttlMs: 900, source: "http" }]])
		assert.deepEqual(replies[0].body, {
			type: "pet.command.result",
			ok: true,
			result: { type: "status", message: "working", ttlMs: 900, source: "http" },
		})
	})

	it("passes only pluginId to the dashboard opener and ignores all backend window parameters", async () => {
		const dashboards = []
		const handler = createMessageHandler({
			send() {},
			onDashboard: (request) => dashboards.push(request),
		})

		assert.equal(await handler.handle(envelope("window.openPluginDashboard", {
			pluginId: "focus-timer",
			url: "file:///tmp/owned.html",
			preload: "/tmp/owned-preload.js",
			webPreferences: { nodeIntegration: true, sandbox: false },
			path: "/tmp/owned.html",
		})), true)

		assert.deepEqual(dashboards, [{ pluginId: "focus-timer" }])
	})

	it("delivers settings.changed as paths and version only", async () => {
		const notifications = []
		const handler = createMessageHandler({ send() {}, onSettingsChanged: (payload) => notifications.push(payload) })
		assert.equal(await handler.handle(envelope("settings.changed", { paths: ["scale"], version: 4, values: { apiKey: "secret" } })), true)
		assert.deepEqual(notifications, [{ paths: ["scale"], version: 4 }])
	})

	it("answers settings.apply.request with the same envelope id after Shell effects settle", async () => {
		const replies = []
		const applied = []
		const handler = createMessageHandler({
			send: (reply) => replies.push(reply),
			onSettingsApplyRequest: async (payload) => { applied.push(payload) }
		})
		assert.equal(await handler.handle(envelope("settings.apply.request", { paths: ["scale"], version: 4, values: { scale: 1.2 } })), true)
		assert.equal(applied.length, 1)
		assert.deepEqual(applied[0].body, { type: "settings.apply.request", paths: ["scale"], version: 4, values: { scale: 1.2 } })
		assert.equal(applied[0].id, "test-settings.apply.request")
		assert.deepEqual(replies, [{ v: 1, id: "test-settings.apply.request", body: { type: "settings.apply.result", version: 4, ok: true } }].map((reply) => ({ ...reply, at: replies[0]?.at })))
	})

	it("fails closed when no settings host-effect handler is wired", async () => {
		const replies = []
		const handler = createMessageHandler({ send: (reply) => replies.push(reply) })
		assert.equal(await handler.handle(envelope("settings.apply.request", { paths: ["scale"], version: 4 })), true)
		assert.equal(replies[0].body.ok, false)
		assert.match(replies[0].body.error, /host effect unavailable/)
	})

	it("persists provider-key writes in the Shell and replies without echoing plaintext", async () => {
		const replies = []
		const writes = []
		const secretService = {
			setSecret: (entry) => writes.push(entry),
			deleteSecret: (id) => writes.push({ deleted: id }),
		}
		const handler = createMessageHandler({ send: (reply) => replies.push(reply), secretService })
		const plaintext = "bridge-provider-secret-123456"

		assert.equal(await handler.handle(envelope("secrets.persist.request", { providerId: "openai", value: plaintext })), true)
		assert.deepEqual(writes, [{ id: "openai", value: plaintext, label: "openai", kind: "provider" }])
		assert.deepEqual(replies[0].body, { type: "secrets.persist.result", providerId: "openai", ok: true })
		assert.doesNotMatch(JSON.stringify(replies), /bridge-provider-secret/)

		assert.equal(await handler.handle(envelope("secrets.persist.request", { providerId: "openai", value: null })), true)
		assert.deepEqual(writes.at(-1), { deleted: "openai" })
		assert.deepEqual(replies.at(-1).body, { type: "secrets.persist.result", providerId: "openai", ok: true })
	})

	it("redacts a provider key when Shell persistence fails and rejects extra request fields", async () => {
		const replies = []
		const errors = []
		const plaintext = "opaque-shell-provider-secret"
		const handler = createMessageHandler({
			send: (reply) => replies.push(reply),
			secretService: { setSecret: () => { throw new Error(`disk failed for ${plaintext}`) } },
			logger: { error: (message, fields) => errors.push({ message, fields }) },
		})

		assert.equal(await handler.handle(envelope("secrets.persist.request", { providerId: "custom", value: plaintext })), true)
		assert.equal(replies[0].body.ok, false)
		assert.doesNotMatch(JSON.stringify({ replies, errors }), /opaque-shell-provider-secret/)
		assert.equal(await handler.handle(envelope("secrets.persist.request", { providerId: "custom", value: plaintext, readBack: true })), false)
	})

	it("answers a validated catalog.request with the correlated catalog.result", async () => {
		const replies = []
		const requests = []
		const handler = createMessageHandler({
			send: (reply) => replies.push(reply),
			onCatalogRequest: async (request) => { requests.push(request); return { selectionId: "selection-1" } },
		})
		assert.equal(await handler.handle(envelope("catalog.request", {
			request: { operation: "prepareInstall", kind: "plugin", itemId: "focus-timer" },
		})), true)
		assert.deepEqual(requests, [{ operation: "prepareInstall", kind: "plugin", itemId: "focus-timer" }])
		assert.equal(replies[0].id, "test-catalog.request")
		assert.deepEqual(replies[0].body, { type: "catalog.result", ok: true, result: { selectionId: "selection-1" } })
	})

	it("rejects catalog bridge operations and fields outside the frozen allowlist", async () => {
		const calls = []
		const warnings = []
		const handler = createMessageHandler({
			send() {},
			onCatalogRequest: (request) => calls.push(request),
			logger: { warn: (_message, fields) => warnings.push(fields) },
		})
		assert.equal(await handler.handle(envelope("catalog.request", { request: { operation: "executePath", path: "/tmp/owned" } })), false)
		assert.equal(await handler.handle(envelope("catalog.request", {
			request: { operation: "installSelection", selectionId: "selection-1", path: "/tmp/owned" },
		})), false)
		assert.deepEqual(calls, [])
		assert.deepEqual(warnings.map(({ reason }) => reason), ["bad-body", "bad-body"])
	})
})
