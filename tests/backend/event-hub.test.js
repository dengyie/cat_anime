"use strict"

const assert = require("node:assert/strict")
const { describe, it } = require("node:test")

describe("T11 event hub", async () => {
	const { createEventHub, MAX_BUFFERED_FRAMES } = await import("../../services/backend/events/hub.js")
 const contracts = await import("@openpet/contracts")

	it("filters topics and always delivers system events", () => {
		const sink = { writes: [], write(value) { this.writes.push(value); return true }, end() {} }
		const hub = createEventHub({ heartbeatMs: 60_000 })
		hub.subscribe({ topics: ["jobs"], sink })
		hub.publish("settings.changed", { paths: ["pet.scale"], version: 1 })
		hub.publish("job.created", { jobId: "j1" })
		hub.publish("backend.degraded", { reason: "test" })
		assert.equal(sink.writes.filter((value) => value.includes("event:")).length, 2)
		assert.match(sink.writes.at(-1), /event: backend\.degraded/)
	})

	it("bounds a paused client and emits a dropped notice after drain", () => {
		let drain
		const sink = {
			writes: [],
			blocked: true,
			write(value) { this.writes.push(value); return !this.blocked },
			once(event, callback) { if (event === "drain") drain = callback },
			end() {},
		}
		const hub = createEventHub({ heartbeatMs: 60_000 })
		hub.subscribe({ topics: ["logs"], sink })
		for (let index = 0; index < MAX_BUFFERED_FRAMES + 5; index += 1) hub.publish("log.appended", { index })
		assert.equal(hub.stats().clients, 1)
		sink.blocked = false
		drain()
		assert.match(sink.writes.join(""), /event: system\.events-dropped/)
	})

	it("contracts expose the complete event directory", () => {
		assert.equal(contracts.EVENT_NAMES.length, 21)
		assert.equal(new Set(contracts.EVENT_NAMES).size, 21)
		for (const name of contracts.EVENT_NAMES) assert.ok(contracts.SSE_TOPICS.includes(contracts.EVENT_TOPIC[name]))
	})

	it("sends heartbeats on the configured interval", () => {
		let tick
		const sink = { writes: [], write(value) { this.writes.push(value); return true }, end() {} }
		const hub = createEventHub({
			heartbeatMs: 15_000,
			setInterval(callback, ms) { assert.equal(ms, 15_000); tick = callback; return 1 },
			clearInterval() {},
		})
		hub.subscribe({ topics: ["jobs"], sink })
		tick()
		assert.equal(sink.writes.at(-1), ": ping\n\n")
	})

	it("pauses heartbeats under backpressure and releases stalled clients", () => {
		const { EventEmitter } = require("node:events")
		const sink = new EventEmitter()
		let writes = 0
		let destroyed = false
		sink.write = () => { writes++; return false }
		sink.destroy = () => { destroyed = true }
		let tick
		let now = 0
		const hub = createEventHub({ now: () => now, setInterval: (fn) => { tick = fn; return 1 }, clearInterval() {} })
		hub.subscribe({ topics: ["jobs"], sink })
		hub.publish("job.created", { jobId: "blocked" })
		for (let index = 0; index < 20; index++) tick()
		assert.equal(writes, 1)
		assert.equal(sink.listenerCount("drain"), 1)
		now = 45_001
		tick()
		assert.equal(hub.stats().clients, 0)
		assert.equal(sink.listenerCount("drain"), 0)
		assert.equal(destroyed, true)
	})
})
