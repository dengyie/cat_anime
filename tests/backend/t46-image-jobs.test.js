"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")

const { createAiService } = require("../../services/backend/domains/ai/image-generation.js")

function tempDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test("T46 image route enqueues without awaiting generation", async () => {
	const { registerAiRoutes } = await import("../../services/backend/routes/ai.js")
	let handler
	registerAiRoutes({ post: (_path, next) => { handler = next } }, {
		jobs: { insert: (input) => ({ id: input.id }) },
	})
	const response = { writableEnded: false, writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
	const started = performance.now()
	await handler({ body: { prompt: "a cat", output: { dataDir: "/tmp/openpet", dataRelativeDir: "images" } }, requestId: "t46", startedAt: started, res: response })
	assert.equal(response.status, 202)
	assert.match(response.body.data.jobId, /^image-generate:/)
	assert.ok(performance.now() - started < 3_000)
})

test("T46 image handler makes finalization the cancellation boundary", async () => {
	const { run } = await import("../../services/backend/jobs/handlers/image-generate.js")
	let committed = false
	let finalized = false
	const result = await run({ prompt: "x" }, {
		ai: { prepareGeneratedImage: async () => ({ artifact: true }), commitGeneratedImage: async () => { committed = true; return { ok: true } } },
		signal: new AbortController().signal,
		progress: () => {},
		tmpDir: "/tmp/job",
		finalize: async (writer) => { finalized = true; return writer() },
	})
	assert.deepEqual(result, { ok: true })
	assert.equal(finalized, true)
	assert.equal(committed, true)
})

test("T46 runner publishes image progress as SSE-compatible job events", async () => {
	const [{ createJobsRepository }, { createQueue }, { createRunner }, { migrate }, { openDatabase }] = await Promise.all([
		import("../../services/backend/store/repositories/jobs.js"),
		import("../../services/backend/jobs/queue.js"),
		import("../../services/backend/jobs/runner.js"),
		import("../../services/backend/store/migrate.js"),
		import("../../services/backend/store/db.js"),
	])
	const db = await openDatabase({ file: ":memory:" })
	try {
		migrate({ db })
		const repo = createJobsRepository({ db })
		const queue = createQueue({ repo, tickMs: 60_000 })
		const frames = []
		const runner = createRunner({
			repo,
			queue,
			progress: ({ onEmit }) => ({ report: onEmit, flush: () => {}, reset: () => {} }),
			emit: (name, payload) => { if (name === "job.progress") frames.push({ name, payload }) },
			handlers: { "image.generate": async ({ report, finalize }) => { report({ phase: "generating", percent: 20 }); return finalize(() => ({ ok: true })) } },
		})
		queue.enqueue({ id: "sse-image", kind: "image.generate", input: {} })
		await runner.run(queue.next())
		assert.deepEqual(frames.map(({ name }) => name), ["job.progress", "job.progress"])
		assert.deepEqual(frames.map(({ payload }) => payload.phase), ["generating", "finalizing"])
		assert.ok(frames.every(({ payload }) => payload.jobId === "sse-image" && payload.kind === "image.generate"))
		queue.stop()
	} finally {
		db.close()
	}
})

test("T42 actions import job enters the runner and emits SSE lifecycle events", async () => {
	const [{ createJobsRepository }, { createQueue }, { createRunner }, { migrate }, { openDatabase }] = await Promise.all([
		import("../../services/backend/store/repositories/jobs.js"),
		import("../../services/backend/jobs/queue.js"),
		import("../../services/backend/jobs/runner.js"),
		import("../../services/backend/store/migrate.js"),
		import("../../services/backend/store/db.js"),
	])
	const db = await openDatabase({ file: ":memory:" })
	try {
		migrate({ db })
		const repo = createJobsRepository({ db })
		const queue = createQueue({ repo, tickMs: 60_000 })
		const events = []
		const calls = []
		const runner = createRunner({
			repo,
			queue,
			progress: ({ onEmit }) => ({ report: onEmit, flush: () => {}, reset: () => {} }),
			emit: (name, payload) => events.push({ name, payload }),
			handlers: {
				"actions.import-frames": async ({ job, report, signal }) => {
					calls.push(job.input)
					assert.equal(signal.aborted, false)
					report({ phase: "generating", percent: 25, message: "Generating action sprites" })
					return { actionId: job.input.actionId, imported: true }
				},
			},
		})
		const inserted = repo.insert({
			id: "actions-import-frames:wave:1",
			kind: "actions.import-frames",
			input: { path: "/tmp/frames", actionId: "wave", label: "Wave" },
			resourceKey: "actions:wave",
		})
		queue.enqueue(inserted.id)
		const finished = await runner.run(queue.next())
		assert.equal(finished.status, "succeeded")
		assert.deepEqual(calls, [{ path: "/tmp/frames", actionId: "wave", label: "Wave" }])
		assert.deepEqual(events.map(({ name }) => name), ["job.progress", "job.succeeded"])
		assert.equal(events[0].payload.jobId, inserted.id)
		assert.equal(events[0].payload.kind, "actions.import-frames")
		assert.equal(events[0].payload.phase, "generating")
		assert.equal(events[1].payload.result.actionId, "wave")
		queue.stop()
	} finally {
		db.close()
	}
})

test("T46 image commit rejects symlink escapes and rolls back partial multi-file staging", async () => {
	const root = tempDir("openpet-t46-data-")
	const tmp = tempDir("openpet-t46-tmp-")
	const outside = tempDir("openpet-t46-outside-")
	const ai = createAiService({
		settings: { read: () => ({ version: 1, values: { models: { imageGeneration: {} } } }), patch: () => ({}) },
		secrets: { get: () => "" },
		userDataDir: root,
	})
	try {
		fs.mkdirSync(path.join(tmp, "outputs"), { recursive: true })
		fs.writeFileSync(path.join(tmp, "outputs", "one.png"), "one")
		await assert.rejects(
			ai.commitGeneratedImage({ tmpDir: tmp, destination: { dataDir: root, dataRelativeDir: "images" }, result: { outputs: [{ dataRelativePath: "outputs/one.png" }, { dataRelativePath: "outputs/missing.png" }] } }),
		)
		assert.equal(fs.existsSync(path.join(root, "images")), false)

		fs.symlinkSync(outside, path.join(root, "escaped"), "dir")
		await assert.rejects(
			ai.commitGeneratedImage({ tmpDir: tmp, destination: { dataDir: root, dataRelativeDir: "escaped" }, result: { outputs: [{ dataRelativePath: "outputs/one.png" }] } }),
		)
		assert.equal(fs.readdirSync(outside).length, 0)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
		fs.rmSync(tmp, { recursive: true, force: true })
		fs.rmSync(outside, { recursive: true, force: true })
	}
})

test("T46 maps the canonical image secret ref to its provider key without fallback leakage", () => {
	const calls = []
	const ai = createAiService({
		settings: { read: () => ({ version: 1, values: { models: { imageGeneration: { apiKeyRef: "secret:model.image.openai.apiKey" } } } }), patch: () => ({}) },
		secrets: { get: (id) => { calls.push(id); return id === "openai" ? "image-secret" : "wrong-secret" } },
	})
	assert.equal(ai.getConfig().hasApiKey, true)
	assert.ok(calls.length >= 1)
	assert.ok(calls.every((id) => id === "openai"))
})
