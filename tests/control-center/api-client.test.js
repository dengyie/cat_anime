"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { before, describe, it } = require("node:test")

let clientModule
let contracts
let queryClientModule
let settingsApiModule
let transportModule

before(async () => {
	;[clientModule, contracts, queryClientModule, settingsApiModule, transportModule] = await Promise.all([
		import("../../src/control-center/src/api/client.ts"),
		import("../../src/shared/browser-contracts.ts"),
		import("../../src/control-center/src/app/queryClient.ts"),
		import("../../src/control-center/src/features/settings/api.ts"),
		import("../../src/control-center/src/api/transport.ts"),
	])
})

function success(data, requestId = "r_test") {
	return { ok: true, data, meta: { requestId } }
}

describe("T21 QueryClient policy", () => {
	it("uses the ADR-015 global defaults", () => {
		const defaults = queryClientModule.createQueryClient().getDefaultOptions().queries
		assert.equal(defaults.staleTime, Infinity)
		assert.equal(defaults.refetchOnWindowFocus, false)
		assert.equal(defaults.refetchOnReconnect, false)
		assert.equal(defaults.retry, false)
	})
})

describe("T21 API client contract boundary", () => {
	it("adds request metadata and unwraps a contract-validated success", async () => {
		let request
		const transport = transportModule.createMockTransport({ handlers: [(input) => {
			request = input
			return success({ version: 2, values: { "pet.scale": 1.25 } })
		}] })
		const api = settingsApiModule.createSettingsApi(clientModule.createApiClient(transport))

		assert.deepEqual(await api.get(), { version: 2, values: { "pet.scale": 1.25 } })
		assert.equal(request.method, "GET")
		assert.equal(request.headers.get(contracts.HEADER.client), "control-center")
		assert.match(request.headers.get(contracts.HEADER.requestId), /^r_/)
	})

	it("validates request DTOs from contracts and assigns write idempotency keys", async () => {
		let request
		const transport = transportModule.createMockTransport({ handlers: [(input) => {
			request = input
			return success({ version: 3, changedPaths: ["pet.scale"] })
		}] })
		const api = settingsApiModule.createSettingsApi(clientModule.createApiClient(transport))

		await api.patch({ ifVersion: 2, patch: { "pet.scale": 1.5 } })
		assert.equal(request.method, "PATCH")
		assert.deepEqual(JSON.parse(request.body), { ifVersion: 2, patch: { "pet.scale": 1.5 } })
		assert.match(request.headers.get(contracts.HEADER.idempotencyKey), /^i_/)
		await assert.rejects(
			api.patch({ ifVersion: -1, patch: {} }),
			(error) => error?.name === "ValiError" && error.issues.length > 0,
		)
	})

	it("throws the typed contract error instead of matching messages", async () => {
		const transport = transportModule.createMockTransport({ handlers: [() => ({
			ok: false,
			error: {
				code: "CONFLICT",
				message: "版本冲突",
				details: { currentVersion: 4 },
				retryable: false,
				requestId: "r_conflict",
			},
		})] })
		const api = settingsApiModule.createSettingsApi(clientModule.createApiClient(transport))

		await assert.rejects(api.get(), (error) => {
			assert.equal(error instanceof clientModule.ApiError, true)
			assert.equal(error.code, "CONFLICT")
			assert.equal(error.retryable, false)
			assert.equal(error.requestId, "r_conflict")
			assert.deepEqual(error.details, { currentVersion: 4 })
			return true
		})
	})

	it("preserves pre-dispatch transport evidence on the typed error", async () => {
		const transport = transportModule.createMockTransport({ handlers: [() => {
			throw new transportModule.TransportError(new Error("backend not ready"), false)
		}] })
		const api = settingsApiModule.createSettingsApi(clientModule.createApiClient(transport))

		await assert.rejects(api.get(), (error) => {
			assert.equal(error instanceof clientModule.ApiError, true)
			assert.equal(error.code, "BACKEND_UNAVAILABLE")
			assert.equal(error.dispatched, false)
			return true
		})
	})

	it("retries an idempotent retryable request at most twice", async () => {
		let attempts = 0
		const transport = transportModule.createMockTransport({ handlers: [() => {
			attempts += 1
			if (attempts <= clientModule.MAX_RETRIES) {
				return {
					ok: false,
					error: {
						code: "BACKEND_UNAVAILABLE",
						message: "后端启动中",
						retryable: true,
						requestId: `r_retry_${attempts}`,
					},
				}
			}
			return success({ version: 1, values: {} })
		}] })
		const api = settingsApiModule.createSettingsApi(clientModule.createApiClient(transport))

		assert.deepEqual(await api.get(), { version: 1, values: {} })
		assert.equal(attempts, 3)
	})

	it("rejects success payloads that violate the response schema", async () => {
		const transport = transportModule.createMockTransport({ handlers: [() => success({
			version: -1,
			values: {},
		})] })
		const api = settingsApiModule.createSettingsApi(clientModule.createApiClient(transport))

		await assert.rejects(api.get(), (error) => (
			error.code === "INTERNAL" && error.retryable === false
		))
	})
})

describe("ADR-015 useQuery boundary", () => {
	it("allows useQuery only in pane-level feature hooks", () => {
		const sourceRoot = path.join(__dirname, "../../src/control-center/src")
		const violations = []
		const queryClientConstructors = []
		const pollingViolations = []
		const visit = (directory) => {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				const file = path.join(directory, entry.name)
				if (entry.isDirectory()) {
					visit(file)
					continue
				}
				if (!/\.[jt]sx?$/.test(entry.name)) continue
				const source = fs.readFileSync(file, "utf8")
				const relative = path.relative(sourceRoot, file).split(path.sep).join("/")
				if (/\bnew\s+QueryClient\s*\(/.test(source)) queryClientConstructors.push(relative)
				if (/\brefetchInterval\b/.test(source)) pollingViolations.push(relative)
				if (/\buseQuery\b/.test(source) && !/^features\/[^/]+\/hooks\/use[^/]*Pane\.[jt]sx?$/.test(relative)) {
					violations.push(relative)
				}
			}
		}
		visit(sourceRoot)
		assert.deepEqual(violations, [])
		assert.deepEqual(queryClientConstructors, ["app/queryClient.ts"])
		assert.deepEqual(pollingViolations, [])
	})
})
