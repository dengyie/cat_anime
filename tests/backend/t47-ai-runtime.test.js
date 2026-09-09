"use strict"
const assert = require("node:assert/strict")
const { test } = require("node:test")
const { createAiTalkStore, createEmptyState } = require("../../src/main/services/ai-talk-store.js")
const { createAiService } = require("../../src/main/services/ai-service.js")

function memoryRepository(initial = createEmptyState()) {
  let persisted = structuredClone(initial)
  let fail = false
  return {
    loadState: () => structuredClone(persisted),
    commitState: (state) => {
      if (fail) throw new Error("disk full")
      persisted = structuredClone(state)
    },
    setFailure: (next) => { fail = next },
  }
}

test("T47 talk store persists through its repository without a JSON path", () => {
  const repository = memoryRepository()
  const store = createAiTalkStore({ repository })
  const handle = store.ensureMainConversation({ petPackId: "cat" })
  store.appendMessages(handle.sessionId, handle.conversationId, [{ id: "m1", role: "user", content: "hello", metadata: { origin: "import" } }])
  const reopened = createAiTalkStore({ repository })
  assert.equal(reopened.getMessages("control-center:cat", "main")[0].content, "hello")
  assert.deepEqual(repository.loadState().messages["control-center:cat:main"][0].metadata, { origin: "import" })
})

test("T47 a failed repository commit leaves the live store at its last committed state", () => {
  const repository = memoryRepository()
  const store = createAiTalkStore({ repository })
  store.ensureMainConversation({ petPackId: "cat" })
  const before = store.getState()
  repository.setFailure(true)
  assert.throws(() => store.appendMessages("control-center:cat", "main", [{ role: "user", content: "not committed" }]), /disk full/)
  assert.deepEqual(store.getState(), before)
})

test("T47 provider history uses injected storage and never writes settings history", () => {
  let writes = 0
  let conversations = { imported: [{ role: "user", content: "persisted" }] }
  const provider = createAiService({
    settingsService: { get: () => ({ ai: {} }), update: () => { writes++ } },
    secretService: { getSecretValue: () => "" },
    conversationStore: { load: () => structuredClone(conversations), save: (next) => { conversations = structuredClone(next) } },
  })
  assert.equal(provider.getConversation("imported")[0].content, "persisted")
  provider.clearConversation("imported")
  assert.deepEqual(conversations, {})
  assert.equal(writes, 0)
})
