const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assertBrowserModules } = require('../../scripts/browser-dependency-gate.cjs')

test('Browser dependency gate rejects zod even when a module would be tree-shaken', () => {
  assert.throws(() => assertBrowserModules(['/app/node_modules/zod/v4/core/index.js']), /contains zod/)
  assert.throws(() => assertBrowserModules(['C:\\app\\node_modules\\zod\\v4\\index.js']), /contains zod/)
  assert.doesNotThrow(() => assertBrowserModules(['/app/node_modules/valibot/dist/index.js']))
})

test('Generated browser validators agree with canonical contracts on valid and invalid payloads', async () => {
  const contracts = await import('@openpet/contracts')
  const browser = await import('../../src/shared/browser-contracts.ts')
  const v = await import('valibot')
  const fixtures = {
    settingsPatchRequestSchema: [{ ifVersion: 0, patch: {} }, { ifVersion: -1, patch: {} }, { ifVersion: 0.1, patch: {} }, { ifVersion: '0', patch: {} }, { ifVersion: 1, patch: [] }],
    apiFailureSchema: [{ ok: false, error: { code: 'INTERNAL', message: 'error', retryable: false, requestId: 'r' } }, { ok: false, error: {} }, { ok: true }],
    jobProgressSchema: [{ phase: 'starting', percent: 0 }, { phase: 'done', percent: 100 }, { phase: '', percent: 10 }, { phase: 'x', percent: 101 }, { phase: 'x', percent: -1 }],
    settingsEnvelopeSchema: [{ version: 2, values: { any: { nested: true } } }, { version: null, values: {} }],
  }
  for (const [name, values] of Object.entries(fixtures)) {
    for (const value of values) {
      const expected = contracts[name].safeParse(value)
      const actual = v.safeParse(browser[name], value)
      assert.equal(actual.success, expected.success, `${name}: ${JSON.stringify(value)}`)
      if (expected.success) assert.deepEqual(actual.output, expected.data)
    }
  }
  const { buildBrowserContracts } = await import('../../scripts/build-browser-contracts.mjs')
  buildBrowserContracts({ check: true })
})
