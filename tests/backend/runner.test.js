"use strict"

const assert = require("node:assert/strict")
const { before, describe, it } = require("node:test")

let ApiError
let createJobsRepository
let createQueue
let createRunner
let migrate
let openDatabase
let constants

before(async () => {
	;({ ApiError } = await import("../../services/backend/http/middleware.js"))
	;({ createJobsRepository } = await import("../../services/backend/store/repositories/jobs.js"))
	;({ createQueue } = await import("../../services/backend/jobs/queue.js"))
	;({ createRunner, ...constants } = await import("../../services/backend/jobs/runner.js"))
	;({ migrate } = await import("../../services/backend/store/migrate.js"))
	;({ openDatabase } = await import("../../services/backend/store/db.js"))
})

function deferred() {
	let resolve
	let reject
	const promise = new Promise((res, rej) => { resolve = res; reject = rej })
	return { promise, resolve, reject }
}

async function eventually(check) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const value = check()
		if (value) return value
		await new Promise((resolve) => setImmediate(resolve))
	}
	throw new Error("condition was not reached")
}

async function withRunner(handlers, run, options = {}) {
	const db = await openDatabase({ file: ":memory:" })
	try {
		migrate({ db })
		let now = 1_000
		const repo = createJobsRepository({ db, now: () => now++ })
		const queue = createQueue({ repo, now: () => now++, queueTimeoutMs: 60_000 })
		const runner = createRunner({
			repo,
			queue,
			handlers,
			delay: options.delay ?? (async () => {}),
			signalTree: options.signalTree,
			isRunning: options.isRunning,
			shutdownGraceMs: options.shutdownGraceMs ?? 1,
		})
		return await run({ queue, repo, runner })
	} finally {
		db.close()
	}
}

function enqueue(queue, id, kind, input = {}) {
	queue.enqueue({ id, kind, input })
}

describe("Job runner · finalizing and cancellation", () => {
	it("marks finalizing before the writer and rejects cancellation with 423", async () => {
		const writer = deferred()
		await withRunner({
			"image.generate": async ({ finalize }) => finalize(async () => {
				await writer.promise
				return "written"
			}),
		}, async ({ queue, repo, runner }) => {
			enqueue(queue, "finalizing-job", "image.generate")
			const running = runner.run()
			await eventually(() => repo.byId("finalizing-job").progress?.phase === "finalizing")

			await assert.rejects(
				runner.cancel("finalizing-job"),
				(error) => error.code === "JOB_NOT_CANCELABLE" && error.status === 423,
			)
			writer.resolve()
			assert.equal((await running).status, "succeeded")
		})
	})

	it("aborts provider work and terminates a registered process tree TERM then KILL", async () => {
		const signals = []
		await withRunner({
			"plugin.command": async ({ registerProcess, signal }) => {
				registerProcess({ pid: 4321, exitCode: null })
				await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
			},
		}, async ({ queue, repo, runner }) => {
			enqueue(queue, "cancel-provider", "plugin.command")
			const running = runner.run()
			await eventually(() => repo.byId("cancel-provider").status === "running")
			const canceled = await runner.cancel("cancel-provider")
			await running

			assert.equal(canceled.status, "canceled")
			assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
		}, {
			signalTree: (_processHandle, signal) => signals.push(signal),
			isRunning: () => true,
		})
	})
})

describe("Job runner · retry policy", () => {
	it("redacts structured error secrets before persisted Jobs are returned publicly", async () => {
		await withRunner({
			"creator.export": async () => {
				throw new ApiError("VALIDATION_FAILED", "provider rejected Authorization: Bearer public-secret-123", {
					status: 400,
					details: {
						apiKey: { nested: "api-key-secret" },
						password: "password-secret",
						authorization: "Bearer authorization-secret",
						clientSecret: ["client-secret", { deeper: "still-secret" }],
						credential: { value: "credential-secret" },
						authToken: { raw: "auth-token-secret" },
						message: "apiKey=inline-secret password: quoted-secret Authorization: Bearer x",
						safe: "monkey passwordPolicy tokenCount",
					},
				})
			},
		}, async ({ queue, repo, runner }) => {
			enqueue(queue, "sanitized-error", "creator.export")
			const result = await runner.run()
			const persisted = repo.byId("sanitized-error")
			const listed = repo.list().find((job) => job.id === "sanitized-error")
			for (const job of [result, persisted, listed]) {
				assert.equal(job.error.message, "provider rejected Authorization=[redacted-secret]")
				assert.deepEqual(job.error.details, {
					"[redacted-key]": "[redacted-secret]",
					"[redacted-key-2]": "[redacted-secret]",
					"[redacted-key-3]": "[redacted-secret]",
					"[redacted-key-4]": "[redacted-secret]",
					"[redacted-key-5]": "[redacted-secret]",
					"[redacted-key-6]": "[redacted-secret]",
					message: "apiKey=[redacted-secret] password=[redacted-secret] Authorization=[redacted-secret]",
					safe: "monkey passwordPolicy tokenCount",
				})
				assert.doesNotMatch(JSON.stringify(job), /api-key-secret|password-secret|authorization-secret|client-secret|still-secret|credential-secret|auth-token-secret|inline-secret|quoted-secret|Bearer x/)
			}
		})
	})

	it("retries 429/5xx failures within maxAttempts using repository transitions", async () => {
		for (const status of [429, 503]) {
			let calls = 0
			await withRunner({
				"image.generate": async () => {
					calls += 1
					if (calls === 1) throw new ApiError("PROVIDER_ERROR", "temporary", { status })
					return { ok: true }
				},
			}, async ({ queue, repo, runner }) => {
				const jobId = `retry-${status}`
				enqueue(queue, jobId, "image.generate")
				const result = await runner.run()
				assert.equal(result.status, "succeeded")
				assert.equal(repo.byId(jobId).attempt, 2)
				assert.equal(calls, 2)
			})
		}
	})

	it("does not retry creator.export because its maxAttempts is one", async () => {
		let calls = 0
		await withRunner({
			"creator.export": async () => {
				calls += 1
				throw new ApiError("INTERNAL", "failed", { status: 500 })
			},
		}, async ({ queue, runner }) => {
			enqueue(queue, "export-job", "creator.export")
			const result = await runner.run()
			assert.equal(result.status, "failed")
			assert.equal(result.attempt, 1)
			assert.equal(calls, 1)
		})
	})

	it("does not retry non-429 4xx errors", async () => {
		let calls = 0
		await withRunner({
			"image.generate": async () => {
				calls += 1
				throw new ApiError("VALIDATION_FAILED", "bad input", { status: 400 })
			},
		}, async ({ queue, runner }) => {
			enqueue(queue, "validation-job", "image.generate")
			const result = await runner.run()
			assert.equal(result.status, "failed")
			assert.equal(result.attempt, 1)
			assert.equal(calls, 1)
		})
	})
})

describe("Job runner · shutdown", () => {
	it("stops accepting work and marks unfinished running jobs interrupted", async () => {
		await withRunner({
			"plugin.command": async ({ signal }) => {
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
			},
		}, async ({ queue, repo, runner }) => {
			enqueue(queue, "shutdown-job", "plugin.command")
			const running = runner.run()
			await eventually(() => repo.byId("shutdown-job").status === "running")
			const result = await runner.shutdown()
			await running

			assert.deepEqual(result.interrupted, ["shutdown-job"])
			assert.equal(repo.byId("shutdown-job").status, "interrupted")
			assert.equal(repo.byId("shutdown-job").error.code, "BACKEND_RESTARTED")
			assert.throws(() => runner.run(), (error) => error.code === "BACKEND_UNAVAILABLE")
		})
	})

	it("exports the frozen termination and shutdown grace constants", () => {
		assert.equal(constants.SIGKILL_DELAY_MS, 2_000)
		assert.equal(constants.SHUTDOWN_GRACE_MS, 5_000)
	})
})

describe('Job runner · ownership and late completion', () => {
  it('does not execute the same running Job twice', async () => {
    const gate = deferred()
    let executions = 0
    await withRunner({ 'image.generate': async () => { executions++; await gate.promise; return 'done' } }, async ({ queue, repo, runner }) => {
      enqueue(queue, 'single-owner', 'image.generate')
      const first = runner.run()
      const second = Promise.resolve().then(() => runner.run(repo.byId('single-owner')))
      const settled = Promise.allSettled([first, second])
      gate.resolve()
      await settled
      assert.equal(executions, 1)
      assert.equal(repo.byId('single-owner').status, 'succeeded')
    })
  })

  it('a canceled provider cannot enter finalizing and write a late artifact', async () => {
    const gate = deferred()
    let writes = 0
    await withRunner({ 'image.generate': async ({ finalize, report }) => {
      await gate.promise
      report({ phase: 'rendering', percent: 90 })
      return finalize(() => { writes++; return 'late artifact' })
    } }, async ({ queue, repo, runner }) => {
      enqueue(queue, 'late-result', 'image.generate')
      const running = runner.run()
      await runner.cancel('late-result')
      gate.resolve()
      await running
      assert.equal(writes, 0)
      assert.equal(repo.byId('late-result').status, 'canceled')
      assert.equal(repo.byId('late-result').progress, null)
    })
  })

  it('missing handler failure dispatches the next waiting Job', async () => {
    await withRunner({ 'image.generate': async () => 'done' }, async ({ queue, repo, runner }) => {
      enqueue(queue, 'missing', 'image.validate')
      enqueue(queue, 'next-valid', 'image.generate')
      await assert.rejects(runner.run(), /handler/)
      await eventually(() => repo.byId('next-valid').status === 'succeeded')
      assert.equal(queue.stats().running, 0)
    })
  })
})
