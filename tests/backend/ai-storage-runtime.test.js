"use strict"
const assert = require("node:assert/strict")
const { test } = require("node:test")
const { createAiTalkStore, createEmptyState } = require("../../src/main/services/ai-talk-store.js")
const { createAiService } = require("../../src/main/services/ai-service.js")

test("T47 talk store commits through its repository without a JSON path", () => {
	let saved = createEmptyState()
	let commits = 0
	const repository = {
		loadState: () => structuredClone(saved),
		commitState(next) { saved = structuredClone(next); commits += 1 },
	}
	const store = createAiTalkStore({ repository })
	const handle = store.ensureMainConversation({ petPackId: "cat" })
	store.appendMessages(handle.sessionId, handle.conversationId, [{ role: "user", content: "remember me" }])
	assert.equal(commits, 2)
	const reloaded = createAiTalkStore({ repository })
	assert.equal(reloaded.getMessages(handle.sessionId, handle.conversationId)[0].content, "remember me")
})

test("T47 a failed repository commit restores the last persisted view", () => {
	let saved = createEmptyState()
	let fail = false
	const repository = {
		loadState: () => structuredClone(saved),
		commitState(next) { if (fail) throw new Error("disk full"); saved = structuredClone(next) },
	}
	const store = createAiTalkStore({ repository })
	const handle = store.ensureMainConversation({ petPackId: "cat" })
	fail = true
	assert.throws(() => store.appendMessages(handle.sessionId, "main", [{ role: "user", content: "uncommitted" }]), /disk full/)
	assert.deepEqual(store.getMessages(handle.sessionId, "main"), [])
})

test("T47 provider history uses the supplied repository and never writes settings history", () => {
	let conversations = { "control-center": [{ role: "user", content: "old message" }] }
	let settingsWrites = 0
	const service = createAiService({
		settingsService: { get: () => ({ ai: {} }), update() { settingsWrites += 1 } },
		secretService: { getSecretValue: () => "" },
		conversationStore: { load: () => structuredClone(conversations), save(next) { conversations = structuredClone(next) } },
	})
	assert.equal(service.getConversation("control-center")[0].content, "old message")
	service.clearConversation("control-center")
	assert.deepEqual(conversations, {})
	assert.equal(settingsWrites, 0)
})
