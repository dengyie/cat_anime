'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../..')
const fixtureFiles = [
	'docs/refactor/03-api-contract.md',
	'docs/refactor/15-channel-retirement.md',
	'packages/contracts/src/envelope.ts',
	'packages/contracts/src/events.ts',
	'packages/contracts/src/jobs.ts',
	'services/backend/routes/registry.js',
	'services/backend/routes/health.js',
	'services/backend/routes/service.js',
	'services/backend/routes/ai.js',
	'services/backend/routes/ai-runtime.js',
	'services/backend/routes/ai-stream.js',
	'src/main/control-center-adapters.js',
	'src/main/services/plugin-service-state.js',
	'src/main/services/plugin-runtime-safety.js',
	'services/backend/routes/about.js',
	'services/backend/routes/settings.js',
	'services/backend/routes/actions.js',
	'services/backend/routes/pet-packs.js',
	'services/backend/routes/catalog.js',
	'services/backend/routes/jobs.js',
	'services/backend/routes/plugins.js',
	'services/backend/jobs/state-machine.js',
	'services/backend/http/router.js',
	'services/backend/http/middleware.js',
	'src/shared/ipc-channels.ts',
	'src/shared/ipc-channels.js',
	'scripts/api-contract-route-parser.mjs',
	'scripts/check-api-contract.mjs'
]

const createFixture = (t) => {
	const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openpet-api-contract-'))
	t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

	for (const relativePath of fixtureFiles) {
		const targetPath = path.join(fixtureRoot, relativePath)
		fs.mkdirSync(path.dirname(targetPath), { recursive: true })
		fs.copyFileSync(path.join(repoRoot, relativePath), targetPath)
	}
	fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(fixtureRoot, 'node_modules'), 'dir')

	return fixtureRoot
}

test('CLI reads Job statuses from section 6.2 instead of the jobs-recovered SSE row', (t) => {
	const fixtureRoot = createFixture(t)
	const doc = fs.readFileSync(path.join(fixtureRoot, 'docs/refactor/03-api-contract.md'), 'utf8')
	const recoveredRow = doc.split('\n').find((line) => line.includes('system.jobs-recovered'))

	assert.match(recoveredRow, /requeued/)
	assert.doesNotMatch(recoveredRow, /`queued`/)
	assert.ok(doc.indexOf('system.jobs-recovered') < doc.indexOf('### 6.2 Job 对象'))

	const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/check-api-contract.mjs')], {
		cwd: fixtureRoot,
		encoding: 'utf8'
	})

	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
	assert.match(result.stdout, /ok\s+Job 状态 一致\(6 项\)/)
})

test('CLI hard-checks route registry and IPC inventories', (t) => {
	const fixtureRoot = createFixture(t)
	const tsPath = path.join(fixtureRoot, 'src/shared/ipc-channels.ts')
	fs.writeFileSync(tsPath, fs.readFileSync(tsPath, 'utf8').replace("  PET_QUIT: 'pet:quit',\n", ''))
	const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/check-api-contract.mjs')], { cwd: fixtureRoot, encoding: 'utf8' })
	assert.equal(result.status, 1)
	assert.match(result.stderr, /TS\/JS IPC 通道|IPC 通道数/)
})

test('CLI rejects route registration and registry omissions', (t) => {
	for (const target of ['registration', 'registry']) {
		const fixtureRoot = createFixture(t)
		const relativePath = target === 'registration' ? 'services/backend/routes/jobs.js' : 'services/backend/routes/registry.js'
		const file = path.join(fixtureRoot, relativePath)
		const source = fs.readFileSync(file, 'utf8')
		const needle = target === 'registration'
			? '\trouter.get("/jobs/:id", (ctx) => {'
			: '\t"GET /jobs/:id",\n'
		assert.ok(source.includes(needle))
		if (target === 'registration') {
			const start = source.indexOf(needle)
			const end = source.indexOf('\n\trouter.post(', start)
			fs.writeFileSync(file, source.slice(0, start) + source.slice(end + 1))
		} else {
			fs.writeFileSync(file, source.replace(needle, ''))
		}
		const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/check-api-contract.mjs')], { cwd: fixtureRoot, encoding: 'utf8' })
		assert.equal(result.status, 1, target)
		assert.match(result.stderr, /注册表|实际已注册/)
	}
})

test('CLI permits only the explicitly registered T45 transitional revoke route', (t) => {
	const fixtureRoot = createFixture(t)
	const docPath = path.join(fixtureRoot, 'docs/refactor/03-api-contract.md')
	const doc = fs.readFileSync(docPath, 'utf8')
	assert.doesNotMatch(doc, /token\/revoke-sessions/)
	const result = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/check-api-contract.mjs')], { cwd: fixtureRoot, encoding: 'utf8' })
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
	assert.match(result.stdout, /实际路由、注册表与 §4 精确对账\(112\/119 行\)/)

	const registryPath = path.join(fixtureRoot, 'services/backend/routes/registry.js')
	const registry = fs.readFileSync(registryPath, 'utf8')
	fs.writeFileSync(registryPath, registry.replace('\t"POST /service/token/revoke-sessions",\n', ''))
	const missing = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/check-api-contract.mjs')], { cwd: fixtureRoot, encoding: 'utf8' })
	assert.equal(missing.status, 1)
	assert.match(missing.stderr, /注册表|实际已注册/)
})

test('route parser expands compact method/path cells without cross-pairing paths', async () => {
	const { expandRouteMethodsAndPaths } = await import('../../scripts/api-contract-route-parser.mjs')
	assert.deepEqual(expandRouteMethodsAndPaths('GET · POST', '`/ai/traces` · `/ai/traces/export`'), [['GET', '/ai/traces'], ['POST', '/ai/traces/export']])
	assert.deepEqual(expandRouteMethodsAndPaths('GET · POST · DELETE', '`/ai/memories` · `/{id}`'), [['GET', '/ai/memories'], ['POST', '/ai/memories'], ['DELETE', '/ai/memories/{id}']])
	assert.deepEqual(expandRouteMethodsAndPaths('POST · PATCH · DELETE', '`/creator/flows` · `/{id}`'), [['POST', '/creator/flows'], ['PATCH', '/creator/flows/{id}'], ['DELETE', '/creator/flows/{id}']])
	assert.deepEqual(expandRouteMethodsAndPaths('GET · DELETE', '`/ai/conversations` · `/{id}`'), [['GET', '/ai/conversations'], ['DELETE', '/ai/conversations/{id}']])
	assert.deepEqual(expandRouteMethodsAndPaths('PATCH · PUT', '`/items` · `/{id}`'), [])
	assert.deepEqual(expandRouteMethodsAndPaths('GET · POST', '`/one` · `/two`'), [['GET', '/one'], ['POST', '/two']])
	assert.deepEqual(expandRouteMethodsAndPaths('GET · POST · DELETE', '`/one` · `/two` · `/three` · `/four`'), [])
})
