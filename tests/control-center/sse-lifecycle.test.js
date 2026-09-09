const assert = require("node:assert/strict")
const { test } = require("node:test")
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

async function harness(t, fetchImpl) {
	const { SseManager } = await import("../../src/control-center/src/hooks/useSse.ts")
	const manager = new SseManager()
	const timers = new Map()
	manager.configure({
		getBackend: () => ({ baseUrl: "http://127.0.0.1:1234/api/v1", sessionToken: "test" }),
		fetchImpl,
		setTimeout: (callback, ms) => { const id = {}; timers.set(id, { callback, ms }); return id },
		clearTimeout: (id) => timers.delete(id),
	})
	t.after(() => manager.stop())
	return { manager, timers }
}

test("SSE rapid unsubscribe and resubscribe keeps one connection and releases readers", async (t) => {
	let active = 0
	let maxActive = 0
	const bodies = []
	const { manager } = await harness(t, async () => {
		active++
		maxActive = Math.max(maxActive, active)
		const body = new ReadableStream({ start(controller) { bodies.push(controller) }, cancel() { active-- } })
		return new Response(body, { headers: { "content-type": "text/event-stream" } })
	})
	t.after(() => { for (const body of bodies) { try { body.close() } catch {} } })
	const first = manager.subscribe(["jobs"], () => {}, () => {})
	await settle()
	first()
	const second = manager.subscribe(["jobs"], () => {}, () => {})
	await settle()
	second()
	await settle()
	assert.equal(maxActive, 1)
	assert.equal(active, 0)
})

test("SSE clean EOF uses reconnect backoff and stop cancels its timer", async (t) => {
	let calls = 0
	const { manager, timers } = await harness(t, async (_url, { signal }) => {
		calls++
		if (calls > 1) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
		return new Response(new ReadableStream({ start(controller) { controller.close() } }), { headers: { "content-type": "text/event-stream" } })
	})
	const stop = manager.subscribe(["jobs"], () => {}, () => {})
	await settle()
	assert.equal(calls, 1)
	assert.ok([...timers.values()].some(({ ms }) => ms > 0 && ms < 30_000))
	stop()
	await settle()
	assert.equal(timers.size, 0)
})

test("SSE runtime configuration wakes a subscription waiting for the backend", async (t) => {
	let backend = null
	let calls = 0
	const timers = new Map()
	const { SseManager } = await import("../../src/control-center/src/hooks/useSse.ts")
	const manager = new SseManager()
	manager.configure({
		getBackend: () => backend,
		fetchImpl: async () => {
			calls++
			return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
		},
		setTimeout: (callback, ms) => { const id = {}; timers.set(id, { callback, ms }); return id },
		clearTimeout: (id) => timers.delete(id),
	})
	t.after(() => manager.stop())
	const stop = manager.subscribe(["jobs"], () => {}, () => {})
	await settle()
	assert.equal(calls, 0)

	backend = { baseUrl: "http://127.0.0.1:1234/api/v1", sessionToken: "test" }
	manager.configure({})
	await settle()
	assert.equal(calls, 1)
	stop()
})
