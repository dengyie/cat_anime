"use strict"

const assert = require("node:assert/strict")
const { afterEach, before, describe, it } = require("node:test")

let backendClient
let configureBackendClient
let pluginHttpApi
let z

before(async () => {
	;([{ backendClient, configureBackendClient }, { pluginHttpApi }, z] = await Promise.all([
		import("../../src/control-center/src/api/backend-client.ts"),
		import("../../src/control-center/src/features/plugins/api.ts"),
		import("valibot"),
	]))
})

afterEach(() => configureBackendClient())

function success(data, status = 200) {
	return new Response(JSON.stringify({ ok: true, data, meta: { requestId: "r_backend_client" } }), {
		status,
		headers: { "content-type": "application/json" },
	})
}

describe("T32 shared backend client", () => {
	it("queues before readiness and flushes when the backend becomes available", async () => {
		let backend = null
		const calls = []
		const getBackend = () => backend
		const fetchImpl = async (url, init) => {
			calls.push({ url: String(url), init })
			return success({ ready: true })
		}
		configureBackendClient({ getBackend, fetchImpl })

		const pending = backendClient.request({
			method: "GET",
			path: "/health",
			responseSchema: z.object({ ready: z.boolean() }),
		})
		await Promise.resolve()
		assert.equal(calls.length, 0)

		backend = { baseUrl: "http://127.0.0.1:4321/api/v1", sessionToken: "ready-token" }
		configureBackendClient({ getBackend, fetchImpl })
		assert.deepEqual(await pending, { ready: true })
		assert.equal(calls.length, 1)
		assert.equal(calls[0].url, "http://127.0.0.1:4321/api/v1/health")
		assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer ready-token")
	})

	it("adds write metadata, uses the Job timeout, and unwraps a 202 response", async () => {
		const calls = []
		const timeouts = []
		const originalTimeout = AbortSignal.timeout
		AbortSignal.timeout = (milliseconds) => {
			timeouts.push(milliseconds)
			return new AbortController().signal
		}
		try {
			configureBackendClient({
				getBackend: () => ({ baseUrl: "http://127.0.0.1:4321/api/v1", sessionToken: "session-token" }),
				fetchImpl: async (url, init) => {
					calls.push({ url: String(url), init })
					return success({ jobId: "plugin.command:1" }, 202)
				},
			})

			assert.deepEqual(await pluginHttpApi.command("demo", "run", { value: 1 }), { jobId: "plugin.command:1" })
			assert.deepEqual(timeouts, [30_000])
			assert.equal(calls.length, 1)
			const headers = new Headers(calls[0].init.headers)
			assert.equal(headers.get("authorization"), "Bearer session-token")
			assert.match(headers.get("x-request-id"), /^r_/)
			assert.equal(headers.get("x-client"), "control-center")
			assert.match(headers.get("idempotency-key"), /^i_/)
			assert.equal(headers.get("content-type"), "application/json")
			assert.deepEqual(JSON.parse(calls[0].init.body), { value: 1 })
		} finally {
			AbortSignal.timeout = originalTimeout
		}
	})

	it("does not retry non-idempotent Job writes after a transport failure", async () => {
		let attempts = 0
		configureBackendClient({
			getBackend: () => ({ baseUrl: "http://127.0.0.1:4321/api/v1", sessionToken: "session-token" }),
			fetchImpl: async () => {
				attempts += 1
				throw new Error("connection lost")
			},
		})

		await assert.rejects(
			pluginHttpApi.command("demo", "run", {}),
			(error) => error.code === "BACKEND_UNAVAILABLE",
		)
		assert.equal(attempts, 1)
	})

	it("marks a transport failure as dispatched once the HTTP send starts", async () => {
		configureBackendClient({
			getBackend: () => ({ baseUrl: "http://127.0.0.1:4321/api/v1", sessionToken: "session-token" }),
			fetchImpl: async () => {
				throw new Error("connection lost after dispatch")
			},
		})

		await assert.rejects(
			pluginHttpApi.command("demo", "run", {}),
			(error) => error.code === "BACKEND_UNAVAILABLE" && error.dispatched === true,
		)
	})

	it("marks a backend error response as dispatched", async () => {
		configureBackendClient({
			getBackend: () => ({ baseUrl: "http://127.0.0.1:4321/api/v1", sessionToken: "session-token" }),
			fetchImpl: async () => new Response(JSON.stringify({
				ok: false,
				error: {
					code: "BACKEND_UNAVAILABLE",
					message: "backend shutting down",
					retryable: true,
					requestId: "r_server_error",
				},
			}), { status: 503, headers: { "content-type": "application/json" } }),
		})

		await assert.rejects(
			pluginHttpApi.command("demo", "run", {}),
			(error) => error.code === "BACKEND_UNAVAILABLE" && error.dispatched === true,
		)
	})
})
