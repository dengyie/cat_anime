const assert = require('node:assert/strict')
const { test } = require('node:test')

async function setup(t) {
  const { openDatabase } = await import('../../services/backend/store/db.js')
  const { migrate } = await import('../../services/backend/store/migrate.js')
  const { createConversationsRepository } = await import('../../services/backend/store/repositories/conversations.js')
  const { createAiTalkStore, createEmptyState } = await import('../../services/backend/domains/ai/talk-store.js')
  const db = await openDatabase({ file: ':memory:' })
  migrate({ db })
  t.after(() => db.close())
  let rowsRead = 0
  const measured = { ...db, prepare(sql) {
    const stmt = db.prepare(sql)
    return { ...stmt, all(...params) { const rows = stmt.all(...params); rowsRead += rows.length; return rows } }
  } }
  const repository = createConversationsRepository({ db: measured })
  const state = createEmptyState()
  const sessionId = 'control-center:cat'
  state.sessions[sessionId] = { id: sessionId, petPackId: 'cat' }
  for (let i = 0; i < 200; i++) {
    const id = `thread-${i}`
    const key = `${sessionId}:${id}`
    state.conversations[key] = { id, sessionId, petPackId: 'cat' }
    state.messages[key] = Array.from({ length: 100 }, (_, j) => ({ role: 'user', content: `history ${i} ${j}` }))
  }
  repository.commitState(state)
  const store = createAiTalkStore({ repository })
  rowsRead = 0
  return { db, store, repository, sessionId, countRows: () => rowsRead }
}

test('appending to one AI conversation does not scan other conversation histories', async (t) => {
  const { store, repository, sessionId, countRows } = await setup(t)
  store.appendMessages(sessionId, 'thread-0', [{ role: 'assistant', content: 'new reply' }])
  assert.ok(countRows() <= 101, `append scanned ${countRows()} rows for a 100-message conversation`)
  const saved = repository.loadState()
  assert.equal(saved.messages[`${sessionId}:thread-0`].length, 101)
  assert.equal(saved.messages[`${sessionId}:thread-199`].length, 100)
})

test('scoped AI writes preserve other rows and restore memory on failure', async (t) => {
  const { db, store, repository, sessionId } = await setup(t)
  db.exec("CREATE TRIGGER reject_ai_write BEFORE INSERT ON ai_messages WHEN NEW.content = 'reject me' BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END;")
  assert.throws(() => store.appendMessages(sessionId, 'thread-0', [{ role: 'assistant', content: 'reject me' }]), /injected disk failure/)
  assert.equal(store.getMessages(sessionId, 'thread-0').length, 100)
  db.exec('DROP TRIGGER reject_ai_write;')
  store.appendMessages(sessionId, 'thread-0', [{ role: 'assistant', content: 'accepted' }])
  assert.deepEqual(repository.loadState().messages[`${sessionId}:thread-0`], store.getMessages(sessionId, 'thread-0'))
  assert.equal(repository.loadState().messages[`${sessionId}:thread-199`].length, 100)
})
