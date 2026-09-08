"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { spawnSidecar, stopSidecar } = require("../../apps/desktop/src/sidecar/spawn.js")
const { createMessageHandler } = require("../../apps/desktop/src/sidecar/message-handler.js")
const { createSettingsSidecarBridge } = require("../../src/main/settings-sidecar-bridge.js")
const { createSettingsHostEffect } = require("../../src/main/settings-host-effects.js")

const repoRoot = path.resolve(__dirname, "../..")

test("sidecar routes use runtime dependencies initialized before ready", async () => {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-runtime-bindings-"))
	const settingsFile = path.join(userDataDir, "backend", "settings.json")
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
	fs.writeFileSync(settingsFile, JSON.stringify({
		version: 7,
		values: { existing: { enabled: true } },
	}) + "\n")

	let backend = null
	let applyValues = null
	const persistedSecrets = []
	const catalogRequests = []
	const catalogState = {
		schemaVersion: 1, updatedAt: "2026-09-05T00:00:00.000Z", feedbackUrl: "",
		localBlocklist: { pluginIds: [], packIds: [], sha256: [] },
		catalogBlocklist: { pluginIds: [], packIds: [], sha256: [] },
		blocklist: { pluginIds: [], packIds: [], sha256: [] }, plugins: [], petPacks: [],
	}
	try {
		backend = await spawnSidecar({
			entry: path.join(repoRoot, "services/backend/index.js"),
			initBody: {
				userDataDir,
				providerKeys: { openai: "initial-provider-key-1234" },
				legacyToken: null,
				appInfo: { name: "OpenPet Host", version: "9.8.7", packaged: true, platform: "test-platform", arch: "test-arch" },
			},
			logger: { info() {}, warn() {}, error() {} },
		})
		// The integration harness is the Shell for this isolated sidecar. Keep the
		// real settings.apply request/response handshake enabled while exercising
		// the HTTP routes. Route the envelope through the real Shell handler and
		// host bridge so a backend apply never falls back to a GET.
		let hostAppliedSettings = null
		let rejectHostApply = false
		const hostBridge = createSettingsSidecarBridge({
			getBackend: () => backend,
			fetchImpl: async () => { throw new Error("unexpected settings GET") },
			petService: { getSettings: () => ({ scale: 1 }), applySettings: (settings) => settings },
			applyHostSettings: ({ settings }) => {
				if (rejectHostApply) throw new Error("native cursor helper failed")
				hostAppliedSettings = settings
				return settings
			},
		})
		const shellHandler = createMessageHandler({
			send: (envelope) => backend.child.send(envelope),
			onSettingsApplyRequest: (envelope) => hostBridge.handle(envelope),
			onPetPackRequest: ({ operation }) => {
				assert.equal(operation, "list")
				return { activePackId: "legacy-cat", packs: [] }
			},
			onActionsRequest: ({ operation }) => {
				assert.equal(operation, "get")
				return { defaultAction: "idle", clickAction: "idle", actions: [{ id: "idle" }] }
			},
			secretService: {
				setSecret: (entry) => persistedSecrets.push(entry),
				deleteSecret: (id) => persistedSecrets.push({ deleted: id }),
			},
			onCatalogRequest: async (request) => { catalogRequests.push(request); return catalogState },
		})
		backend.child.on("message", (envelope) => {
			if (envelope?.body?.type === "settings.apply.request") applyValues = envelope.body.values
			if (["settings.apply.request", "secrets.persist.request", "catalog.request", "pet-packs.request", "actions.request"].includes(envelope?.body?.type)) {
				void shellHandler.handle(envelope)
			}
		})

		const headers = {
			authorization: `Bearer ${backend.sessionToken}`,
			"content-type": "application/json",
		}
		const persistedBeforePatch = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
		const settingsResponse = await fetch(`${backend.baseUrl}/settings`, { headers })
		const settingsBody = await settingsResponse.json()
		const aboutResponse = await fetch(`${backend.baseUrl}/about`, { headers })
		const aboutBody = await aboutResponse.json()
		const patchResponse = await fetch(`${backend.baseUrl}/settings`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({
				ifVersion: persistedBeforePatch.version,
				patch: { scale: 1.1 },
			}),
		})
		const patchBody = await patchResponse.json()
		const domainStatuses = {}
		for (const route of ["/catalog", "/pet-packs", "/actions"]) {
			const response = await fetch(backend.baseUrl + route, { headers })
			domainStatuses[route] = response.status
		}
		const plaintext = "runtime-provider-secret-9876543210"
		const providerWriteResponse = await fetch(`${backend.baseUrl}/ai/providers/openai/key`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ apiKey: plaintext }),
		})
		const providerWriteBody = await providerWriteResponse.json()
		const providerReadResponse = await fetch(`${backend.baseUrl}/ai/providers/openai/key`, { headers })
		const providerDeleteResponse = await fetch(`${backend.baseUrl}/ai/providers/openai/key`, { method: "DELETE", headers })
		const providerDeleteBody = await providerDeleteResponse.json()

		assert.deepEqual({
			get: { status: settingsResponse.status, data: settingsBody.data },
			about: { status: aboutResponse.status, data: aboutBody.data },
			patch: { status: patchResponse.status, ok: patchBody.ok },
			domainStatuses,
			provider: {
				write: { status: providerWriteResponse.status, data: providerWriteBody.data },
				readStatus: providerReadResponse.status,
				remove: { status: providerDeleteResponse.status, data: providerDeleteBody.data },
			},
		}, {
			get: { status: 200, data: persistedBeforePatch },
			about: {
				status: 200,
				data: {
					name: "openpet",
					productName: "OpenPet",
					version: "9.8.7",
					packaged: true,
					platform: "test-platform",
					arch: "test-arch",
					update: {
						configured: true,
						provider: "github",
						owner: "dengyie",
						repo: "OpenPet",
						channel: "latest",
						url: "https://github.com/dengyie/OpenPet/releases",
					},
				},
			},
			patch: { status: 200, ok: true },
			domainStatuses: { "/catalog": 200, "/pet-packs": 200, "/actions": 200 },
			provider: {
				write: { status: 200, data: { configured: true, maskedTail: "…3210" } },
				readStatus: 404,
				remove: { status: 200, data: { configured: false, maskedTail: "" } },
			},
		})
		assert.doesNotMatch(JSON.stringify(providerWriteBody), /runtime-provider-secret|987654/)
		assert.deepEqual(persistedSecrets, [
			{ id: "openai", value: plaintext, label: "openai", kind: "provider" },
			{ deleted: "openai" },
		])

		const persistedAfterPatch = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
		assert.equal(persistedAfterPatch.values.scale, 1.1)
		assert.equal(persistedAfterPatch.version, persistedBeforePatch.version + 1)
		assert.deepEqual(applyValues, { scale: 1.1 })
		assert.equal(hostAppliedSettings.scale, 1.1)
		assert.deepEqual(catalogRequests, [{ operation: "listCatalog" }])

		rejectHostApply = true
		const rejectedPatch = await fetch(`${backend.baseUrl}/settings`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ ifVersion: persistedAfterPatch.version, patch: { scale: 1.2 } }),
		})
		assert.equal(rejectedPatch.status, 503)
		assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).values.scale, 1.1)
	} finally {
		if (backend?.child) await stopSidecar(backend.child, { graceMs: 5_000 })
		fs.rmSync(userDataDir, { recursive: true, force: true })
	}
})

test("catalog install becomes non-cancelable before the Shell-owned side effect", { timeout: 10_000 }, async () => {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-catalog-finalizing-"))
	let backend = null
	let releaseInstall = () => {}
	let markInstallStarted = () => {}
	const installReleased = new Promise((resolve) => { releaseInstall = resolve })
	const installStarted = new Promise((resolve) => { markInstallStarted = resolve })
	const catalog = {
		schemaVersion: 1, updatedAt: "2026-09-05T00:00:00.000Z", feedbackUrl: "",
		localBlocklist: { pluginIds: [], packIds: [], sha256: [] },
		catalogBlocklist: { pluginIds: [], packIds: [], sha256: [] },
		blocklist: { pluginIds: [], packIds: [], sha256: [] }, plugins: [], petPacks: [],
	}
	try {
		backend = await spawnSidecar({
			entry: path.join(repoRoot, "services/backend/index.js"),
			initBody: { userDataDir, providerKeys: {}, legacyToken: null, appInfo: { name: "OpenPet Host", version: "9.8.7", packaged: true, platform: "test-platform", arch: "test-arch" } },
			logger: { info() {}, warn() {}, error() {} },
		})
		const shellHandler = createMessageHandler({
			send: (envelope) => backend.child.send(envelope),
			onCatalogRequest: async (request) => {
				assert.deepEqual(request, { operation: "installSelection", selectionId: "selection-1" })
				markInstallStarted(); await installReleased
				return { ok: true, kind: "plugin", itemId: "focus-timer", catalog }
			},
		})
		backend.child.on("message", (envelope) => {
			if (envelope?.body?.type === "catalog.request") void shellHandler.handle(envelope)
		})
		const headers = { authorization: `Bearer ${backend.sessionToken}`, "content-type": "application/json" }
		const queuedResponse = await fetch(`${backend.baseUrl}/catalog/install`, { method: "POST", headers, body: JSON.stringify({ selectionId: "selection-1" }) })
		assert.equal(queuedResponse.status, 202)
		const { jobId } = (await queuedResponse.json()).data
		await installStarted
		const runningJob = (await (await fetch(`${backend.baseUrl}/jobs/${encodeURIComponent(jobId)}`, { headers })).json()).data
		assert.equal(runningJob.progress.phase, "finalizing")
		assert.equal(runningJob.cancelable, false)
		const cancelResponse = await fetch(`${backend.baseUrl}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers, body: "{}" })
		assert.equal(cancelResponse.status, 423)
		assert.equal((await cancelResponse.json()).error.code, "JOB_NOT_CANCELABLE")
		releaseInstall()
		let completed = null
		for (let attempt = 0; attempt < 100; attempt += 1) {
			completed = (await (await fetch(`${backend.baseUrl}/jobs/${encodeURIComponent(jobId)}`, { headers })).json()).data
			if (completed.status === "succeeded") break
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		assert.equal(completed.status, "succeeded")
		assert.equal(completed.result.itemId, "focus-timer")
	} finally {
		releaseInstall()
		if (backend?.child) await stopSidecar(backend.child, { graceMs: 5_000 })
		fs.rmSync(userDataDir, { recursive: true, force: true })
	}
})

test("backend-originated home enable settles after Shell persists its normalized anchor", async () => {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-settings-anchor-"))
	let backend = null
	try {
		backend = await spawnSidecar({
			entry: path.join(repoRoot, "services/backend/index.js"),
			initBody: { userDataDir, providerKeys: {}, legacyToken: null },
			logger: { info() {}, warn() {}, error() {} },
		})

		let currentSettings = { petBehavior: { home: { enabled: false, radius: 120, anchor: null } } }
		const petService = {
			getSettings: () => structuredClone(currentSettings),
			applySettings: (settings) => {
				currentSettings = structuredClone(settings)
				return structuredClone(currentSettings)
			},
		}
		let bridge
		let requestSequence = 0
		const pendingRequests = new Map()
		const persistedRequests = []
		const requestBackend = (body) => new Promise((resolve, reject) => {
			const id = `shell-test-${++requestSequence}`
			persistedRequests.push(body)
			pendingRequests.set(id, { resolve, reject })
			backend.child.send({ v: 1, id, at: Date.now(), body })
		})
		const applyHostSettings = createSettingsHostEffect({
			getPetWindow: () => ({ isDestroyed: () => false, getBounds: () => ({ x: 10, y: 20, width: 80, height: 90 }) }),
			petService,
			petMovementPolicy: { createHomeAnchorFromWindow: () => ({ displayId: "display-1", x: 50, y: 65 }) },
			persistNormalization: (input) => bridge.persistNormalization(input),
		})
		bridge = createSettingsSidecarBridge({
			getBackend: () => backend,
			requestBackend,
			petService,
			applyHostSettings,
		})
		const shellHandler = createMessageHandler({
			send: (envelope) => backend.child.send(envelope),
			onSettingsApplyRequest: (envelope) => bridge.handle(envelope),
		})
		backend.child.on("message", (envelope) => {
			if (pendingRequests.has(envelope?.id)) {
				pendingRequests.get(envelope.id).resolve(envelope)
				pendingRequests.delete(envelope.id)
				return
			}
			if (["settings.apply.request", "settings.persist.result"].includes(envelope?.body?.type)) {
				void shellHandler.handle(envelope)
			}
		})

		const before = await (await fetch(`${backend.baseUrl}/settings`, { headers: { authorization: `Bearer ${backend.sessionToken}` } })).json()
		const patchPromise = fetch(`${backend.baseUrl}/settings`, {
			method: "PATCH",
			headers: { authorization: `Bearer ${backend.sessionToken}`, "content-type": "application/json" },
			body: JSON.stringify({ ifVersion: before.data.version, patch: { "petBehavior.home.enabled": true } }),
		})
		const response = await Promise.race([
			patchPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("settings PATCH deadlocked during anchor normalization")), 500)),
		])
		assert.equal(response.status, 200)
		assert.deepEqual(persistedRequests, [{ "type": "settings.persist.request", ifVersion: before.data.version + 1, patch: { "petBehavior.home.anchor": { displayId: "display-1", x: 50, y: 65 } } }])
	} finally {
		if (backend?.child) await stopSidecar(backend.child, { graceMs: 5_000 })
		fs.rmSync(userDataDir, { recursive: true, force: true })
	}
})

test("async home anchor normalization failures are observable after host apply settles", async () => {
	let currentSettings = { petBehavior: { home: { enabled: false, radius: 120, anchor: null } } }
	let normalizationError = null
	const applyHostSettings = createSettingsHostEffect({
		getPetWindow: () => ({ isDestroyed: () => false, getBounds: () => ({ x: 10, y: 20, width: 80, height: 90 }) }),
		petService: {
			getSettings: () => structuredClone(currentSettings),
			applySettings: (settings) => {
				currentSettings = structuredClone(settings)
				return structuredClone(currentSettings)
			},
		},
		petMovementPolicy: { createHomeAnchorFromWindow: () => ({ displayId: "display-1", x: 50, y: 65 }) },
		persistNormalization: async () => { throw new Error("backend unavailable") },
		onNormalizationError: (error) => { normalizationError = error },
	})

	const previousSettings = structuredClone(currentSettings)
	const result = await applyHostSettings({
		settings: { petBehavior: { home: { enabled: true, radius: 120, anchor: null } } },
		previousSettings,
		version: 1,
		awaitNormalization: false,
	})
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(result.petBehavior.home.anchor, { displayId: "display-1", x: 50, y: 65 })
	assert.equal(normalizationError?.message, "backend unavailable")
})
