const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function setup(t) {
  const { openDatabase } = await import('../../services/backend/store/db.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openpet-db-recovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { openDatabase, root, file: path.join(root, 'probe.db') }
}

test('driver recovers its transaction depth after deferred COMMIT failure', async (t) => {
  const { openDatabase, file } = await setup(t)
  const db = await openDatabase({ file })
  t.after(() => db.close())
  db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);')
  assert.throws(() => db.transaction(() => db.prepare('INSERT INTO child VALUES (?)').run(7)), /FOREIGN KEY/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM child').get().n, 0)
  db.transaction(() => {
    db.prepare('INSERT INTO parent VALUES (?)').run(7)
    assert.throws(() => db.transaction(() => { db.prepare('INSERT INTO parent VALUES (?)').run(8); throw new Error('nested rollback') }), /nested rollback/)
    db.prepare('INSERT INTO child VALUES (?)').run(7)
  })
  assert.equal(db.prepare('SELECT count(*) AS n FROM child').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM parent').get().n, 1)
  db.close()
  const reopened = await openDatabase({ file })
  t.after(() => reopened.close())
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM child').get().n, 1)
})

test('simultaneous opens of one physical database permit only one writer', async (t) => {
  const { openDatabase, file } = await setup(t)
  const results = await Promise.allSettled([openDatabase({ file }), openDatabase({ file })])
  t.after(() => { for (const result of results) if (result.status === 'fulfilled') result.value.close() })
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
})

test('database paths through a symbolic directory do not bypass single-writer protection', async (t) => {
  const { openDatabase, file, root } = await setup(t)
  const db = await openDatabase({ file })
  t.after(() => db.close())
  const alias = path.join(root, 'alias')
  fs.symlinkSync(root, alias, 'junction')
  let duplicate
  try {
    await assert.rejects(async () => { duplicate = await openDatabase({ file: path.join(alias, 'probe.db') }) }, /单写者/)
  } finally { duplicate?.close() }
})
