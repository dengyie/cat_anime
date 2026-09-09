"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSidecar, stopSidecar } = require("../apps/desktop/src/sidecar/spawn.js")
const { createMessageHandler } = require("../apps/desktop/src/sidecar/message-handler.js")

async function probe(resourcesDir) {
	assert.ok(process.versions.electron, "The probe must run with the packaged Electron executable")
	const entry = path.join(resourcesDir, "app.asar.unpacked/services/backend/index.js")
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-packaged-sidecar-"))
	const importedMessage = "Packaged sidecar migration and restart probe"
	fs.writeFileSync(path.join(userDataDir, "ai-talk-store.json"), JSON.stringify({
		schemaVersion: 1,
		sessions: { "control-center:probe": { id: "control-center:probe", petPackId: "probe" } },
		conversations: { "control-center:probe:main": { id: "main", sessionId: "control-center:probe", petPackId: "probe" } },
		personaOverrides: {}, memories: {}, petUtterances: {}, memoryJobs: {}, traces: {},
		messages: { "control-center:probe:main": [{ id: "probe-message", role: "user", content: importedMessage }] },
	}))
	let backend = null
	try {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			backend = await spawnSidecar({
				entry,
				initBody: {
					userDataDir, providerKeys: {}, legacyToken: null,
					appInfo: { name: "OpenPet", version: "1.0.1", packaged: true, platform: process.platform, arch: process.arch },
				},
				logger: { info: (...args) => console.error(...args), warn: console.error, error: console.error },
			})
			const handler = createMessageHandler({
				send: (envelope) => backend.child.send(envelope),
				onAiHostRequest: ({ operation }) => {
					assert.equal(operation, "context")
					return { pack: { manifest: { id: "probe", name: "Probe", ai: { persona: {} } } }, actions: [] }
				},
			})
			backend.child.on("message", (envelope) => { void handler.handle(envelope) })
			for (const route of ["/health", "/ai/config", "/ai/conversations/control-center%3Aprobe%3Amain"]) {
				const response = await fetch(backend.baseUrl + route, { headers: { authorization: `Bearer ${backend.sessionToken}` } })
				const body = await response.json()
				assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`)
				if (route.includes("/conversations/")) assert.ok(JSON.stringify(body.data).includes(importedMessage), "Imported history must survive a packaged restart")
			}
			console.log(JSON.stringify({ result: "ready", attempt: attempt + 1, startupMs: backend.startupMs, electron: process.versions.electron, node: process.versions.node }))
			assert.equal(await stopSidecar(backend.child), "exited")
			backend = null
		}
	} finally {
		if (backend) await stopSidecar(backend.child)
		fs.rmSync(userDataDir, { recursive: true, force: true })
	}
}

if (process.argv[2] === "--probe") {
	probe(path.resolve(process.argv[3])).catch((error) => { console.error(error); process.exitCode = 1 })
} else {
	const executable = process.argv[2]
	if (!executable) {
		console.error("Usage: npm run check:packaged-sidecar -- <packaged Electron executable>")
		process.exitCode = 1
	} else {
		const absoluteExecutable = path.resolve(executable)
		const resourcesDir = process.platform === "darwin"
			? path.resolve(path.dirname(absoluteExecutable), "../Resources")
			: path.join(path.dirname(absoluteExecutable), "resources")
		const result = spawnSync(absoluteExecutable, [__filename, "--probe", resourcesDir], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", timeout: 60_000,
		})
		if (result.error) console.error(result.error)
		process.exitCode = result.status ?? 1
	}
}
