const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function setup(t) {
  const { openDatabase } = await import('../../services/backend/store/db.js')
  const { migrate } = await import('../../services/backend/store/migrate.js')
  const { createConversationsRepository } = await import('../../services/backend/store/repositories/conversations.js')
  const db = await openDatabase({ file: ':memory:' })
  migrate({ db })
  t.after(() => db.close())
  return { db, repository: createConversationsRepository({ db }) }
}

function fixture() {
  const at = '2026-08-21T00:00:00.000Z'
  return {
    schemaVersion: 1,
    sessions: { 'cc:cat': { id: 'cc:cat', petPackId: 'cat', createdAt: at }, 'im:cat': { id: 'im:cat', petPackId: 'cat', createdAt: at } },
    conversations: { 'cc:cat:main': { id: 'main', sessionId: 'cc:cat', createdAt: at, metadata: { test: true } }, 'im:cat:main': { id: 'main', sessionId: 'im:cat', createdAt: at } },
    messages: { 'cc:cat:main': [{ id: 'duplicate', role: 'user', content: 'first', createdAt: at, metadata: { channel: 'cc' } }, { id: 'earlier', role: 'assistant', content: 'second', createdAt: '2020-01-01T00:00:00.000Z' }], 'im:cat:main': [{ id: 'duplicate', role: 'user', content: 'other', createdAt: at }] },
    memories: Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`m${i}`, { id: `m${i}`, text: `memory-${i}`, createdAt: at, status: i < 120 ? 'active' : 'superseded', metadata: { retained: true } }])),
    personaOverrides: { cat: { tone: 'warm', likes: ['tea'] } },
    petUtterances: { cat: [{ id: 'u1', text: 'hi', createdAt: at }] },
    memoryJobs: { job: { id: 'job', status: 'pending', createdAt: at, sourceMessageIds: ['duplicate'] } },
    traces: { trace: { id: 'trace', type: 'ai-talk-chat', createdAt: at, memoryIdsInjected: ['m1'], partialReplyChars: 12, metadata: { safe: true } } },
  }
}

test('SQLite preserves all eight AI collections, original message order, metadata and inactive memories', async (t) => {
  const { repository } = await setup(t)
  const state = fixture()
  repository.commitState(state)
  assert.deepEqual(repository.loadState(), state)
  assert.equal(repository.commitState(state).changes, 0)
  state.messages['cc:cat:main'].push({ id: 'new', role: 'user', content: 'third' })
  assert.equal(repository.commitState(state).changes, 1)
  assert.deepEqual(repository.loadState(), state)
})

test('SQLite isolates AI trace ownership and rolls back deletions and inserts on failure', async (t) => {
  const { db, repository } = await setup(t)
  db.prepare("INSERT INTO traces (id, kind, payload_json, at) VALUES ('unrelated', 'plugin', '{}', 1)").run()
  const state = fixture()
  repository.commitState(state)
  const broken = structuredClone(state)
  delete broken.memories.m0
  broken.messages['cc:cat:main'].push({ role: 'user', content: null })
  assert.throws(() => repository.commitState(broken), /NOT NULL/)
  assert.deepEqual(repository.loadState(), state)
  assert.equal(db.prepare("SELECT kind FROM traces WHERE id = 'unrelated'").get().kind, 'plugin')
  state.traces = {}
  repository.commitState(state)
  assert.equal(db.prepare('SELECT count(*) AS n FROM traces').get().n, 1)
})

test('Existing T14 AI history upgrades with a backup, counts, idempotence and isolated rollback', async (t) => {
  const { db, repository } = await setup(t)
  const { upgradeAiJsonStore, rollbackAiJsonUpgrade, countAiState } = await import('../../services/backend/store/upgrade-ai-json.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpet-ai-upgrade-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = fixture()
  source.schemaVersion = 2
  fs.writeFileSync(path.join(dir, 'ai-talk-store.json'), JSON.stringify(source))
  db.prepare("INSERT INTO ai_conversations (id, created_at, updated_at) VALUES ('main', 1, 1)").run()
  db.prepare("INSERT INTO ai_messages (id, conversation_id, role, content, created_at) VALUES ('old', 'main', 'user', 'stale', 1)").run()
  db.prepare("INSERT INTO ai_conversations (id, created_at, updated_at) VALUES ('main:1', 1, 1)").run()
  db.prepare("INSERT INTO ai_messages (id, conversation_id, role, content, created_at) VALUES ('old:1', 'main:1', 'user', 'second stale', 1)").run()
  db.prepare("INSERT INTO jobs (id, kind, status, input_json, created_at) VALUES ('job-kept', 'test', 'succeeded', '{}', 1)").run()
  db.prepare("INSERT INTO traces (id, kind, payload_json, at) VALUES ('trace-kept', 'plugin', '{}', 1)").run()
  const before = repository.loadState()
  assert.throws(() => upgradeAiJsonStore({ db, userDataDir: dir, beforeCommit: () => { throw new Error('disk full') } }), /disk full/)
  assert.deepEqual(repository.loadState(), before)
  const report = upgradeAiJsonStore({ db, userDataDir: dir })
  assert.deepEqual(report.counts, countAiState(source))
  assert.deepEqual(repository.loadState(), source)
  assert.equal(fs.readFileSync(path.join(report.backupDir, 'ai-talk-store.json'), 'utf8'), JSON.stringify(source))
  assert.equal(upgradeAiJsonStore({ db, userDataDir: dir }).skipped, true)
  assert.equal(rollbackAiJsonUpgrade({ db }).restored, true)
  assert.deepEqual(repository.loadState(), before)
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1)
  assert.equal(db.prepare("SELECT count(*) AS n FROM traces WHERE id = 'trace-kept'").get().n, 1)
  assert.equal(fs.existsSync(path.join(dir, 'ai-talk-store.json')), true)
})

test('AI rollback refuses to discard history written after migration', async (t) => {
  const { db, repository } = await setup(t)
  const { upgradeAiJsonStore, rollbackAiJsonUpgrade } = await import('../../services/backend/store/upgrade-ai-json.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpet-ai-rollback-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  upgradeAiJsonStore({ db, userDataDir: dir })
  repository.commitState(fixture())
  assert.throws(() => rollbackAiJsonUpgrade({ db }), /newer history/)
  assert.deepEqual(repository.loadState(), fixture())
})
