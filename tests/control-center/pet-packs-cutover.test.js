"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { describe, it } = require("node:test")

const read = (file) => fs.readFileSync(file, "utf8")

describe("T42 Pet Packs cutover boundary", () => {
	it("uses Shell for Pet Pack Jobs without creating a sidecar pack directory", async () => {
		const requests = []
		let finalizing = false
		let finalizingCalls = 0
		const { createPetPackService } = await import("../../services/backend/domains/pet-packs.js")
		const packs = createPetPackService({
			shell: { request: async (body) => {
				assert.equal(finalizing, true, `${body.operation} crossed the Shell write boundary before finalizing`)
				requests.push(body)
				return { body: { type: "pet-packs.result", operation: body.operation, ok: true, result: { operation: body.operation } } }
			} },
		})
		const finalize = async (operation) => {
			finalizingCalls += 1
			finalizing = true
			try { return await operation() } finally { finalizing = false }
		}

		assert.deepEqual(await packs.runImport({ selectionId: "selection-1", finalize }), { operation: "import" })
		assert.deepEqual(await packs.runExport({ packId: "doro", finalize }), { operation: "export" })
		assert.equal(finalizingCalls, 2)
		assert.deepEqual(requests.map(({ operation, payload }) => ({ operation, payload })), [
			{ operation: "import", payload: { selectionId: "selection-1" } },
			{ operation: "export", payload: { packId: "doro" } },
		])
	})

	it("re-reads the Shell snapshot after Backend service recreation without local Pet Pack state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "openpet-t42-pet-packs-restart-"))
		try {
			const { createPetPackService } = await import("../../services/backend/domains/pet-packs.js")
			let activePackId = "doro"
			const requests = []
			const shell = { request: async (body) => {
				requests.push(body)
				return { body: {
					type: "pet-packs.result",
					operation: body.operation,
					ok: true,
					result: { activePackId, packs: [{ id: activePackId, active: true }] },
				} }
			} }

			const beforeRestart = createPetPackService({
				root,
				userDataDir: path.join(root, "user-data"),
				shell,
			})
			assert.equal((await beforeRestart.list()).activePackId, "doro")

			activePackId = "mochi-cat"
			const afterRestart = createPetPackService({
				root,
				userDataDir: path.join(root, "user-data"),
				shell,
			})
			assert.equal((await afterRestart.list()).activePackId, "mochi-cat")
			assert.deepEqual(requests.map(({ operation }) => operation), ["list", "list"])
			assert.equal(fs.existsSync(path.join(root, "user-data", "pet-packs")), false)
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})

	it("keeps the Control Center on the Shell PetPackService snapshot", () => {
		const hook = read("src/control-center/src/hooks/useActionsPane.ts")
		assert.match(hook, /petPackApi\.list\(\)/)
		assert.match(hook, /resolvePetPackJob/)
		assert.match(hook, /useSse\(\['pet'\]\)/)
		assert.match(hook, /nextPetPackActivationEventId/)

		for (const call of [
			"inspect",
			"clearSelection",
			"import",
			"export",
			"activate",
			"remove",
		]) assert.match(hook, new RegExp(`petPackApi\\.${call}\\(`), call)
		for (const actionsCall of ["getActions", "saveActionsConfig"]) {
			assert.match(hook, new RegExp(`actionsHttpApi\\.${actionsCall}\\(`), actionsCall)
		}
		assert.match(hook, /actionsHttpApi\.previewActionTriggerProposal\(/)
		assert.match(hook, /actionsHttpApi\.clearActionFrameSelection\(/)
		assert.doesNotMatch(hook, /api\.(getActions|saveActionsConfig|previewActionTriggerProposal|clearActionFrameSelection)\(/)
	})

	it("retires Pet Packs business IPC while retaining only the native directory picker", () => {
		const channels = [
			"PET_PACKS_INSPECT_DIRECTORY",
		]
		const preload = read("control-center-preload.js")
		const shared = read("src/shared/ipc-channels.js") + read("src/shared/ipc-channels.ts")
		for (const channel of channels) {
			assert.match(preload, new RegExp(`\\b${channel}\\b`), channel)
			assert.match(shared, new RegExp(`\\b${channel}\\b`), channel)
		}
		for (const retired of [
			"PET_PACKS_LIST", "PET_PACKS_CLEAR_SELECTION", "PET_PACKS_IMPORT", "PET_PACKS_EXPORT",
			"PET_PACKS_SET_ACTIVE", "PET_PACKS_ACTIVE_CHANGED", "PET_PACKS_REMOVE", "CONTROL_CENTER_ACTIVE_PET_PACK_CHANGED"
		]) {
			assert.doesNotMatch(preload, new RegExp(`\\b${retired}\\b`), retired)
			assert.doesNotMatch(shared, new RegExp(`\\b${retired}\\b`), retired)
		}

		assert.match(preload, /inspectPetPackDirectory:/)
		for (const method of ["listPetPacks", "clearPetPackSelection", "importPetPack", "exportPetPack", "setActivePetPack", "onActivePetPackChanged", "removePetPack"]) {
			assert.doesNotMatch(preload, new RegExp(`${method}:`), method)
		}

		const mainIpc = read("src/main/ipc.js")
		assert.match(mainIpc, /handle\(IPC\.PET_PACKS_INSPECT_DIRECTORY/)
		for (const retired of ["PET_PACKS_LIST", "PET_PACKS_CLEAR_SELECTION", "PET_PACKS_IMPORT", "PET_PACKS_EXPORT", "PET_PACKS_SET_ACTIVE", "PET_PACKS_REMOVE"]) {
			assert.doesNotMatch(mainIpc, new RegExp(`handle\\(IPC\\.${retired}`), retired)
		}
	})

	it("filters Pet Pack refreshes to activation events and suppresses duplicate event ids", async () => {
		const sse = read("src/control-center/src/hooks/useSse.ts")
		const actions = read("src/control-center/src/hooks/useActionsPane.ts")
		const ai = read("src/control-center/src/hooks/useAiPane.ts")
		const { nextPetPackActivationEventId } = await import("../../src/control-center/src/features/pet-packs/api.ts")
		assert.match(sse, /lastEventName: string \| null/)
		assert.match(sse, /event\.id === current\.lastEventId && event\.event === current\.lastEventName/)
		for (const hook of [actions, ai]) {
			assert.match(hook, /nextPetPackActivationEventId/)
			assert.match(hook, /lastEventId, petPackEvents\.lastEventName/)
		}
		assert.equal(nextPetPackActivationEventId({ lastEventId: "1", lastEventName: "pet.actions-changed" }, null), null)
		assert.equal(nextPetPackActivationEventId({ lastEventId: "2", lastEventName: "pet.pack-activated" }, null), "2")
		assert.equal(nextPetPackActivationEventId({ lastEventId: "2", lastEventName: "pet.pack-activated" }, "2"), null)
		assert.match(ai, /'petChatState' in eventPayload/)
	})

})
