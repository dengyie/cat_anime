"use strict"

const assert = require("node:assert/strict")
const { describe, it } = require("node:test")

describe("T22 SSE hook seams", () => {
	it("exports hooks and uses the contract reconnect constants", async () => {
		const source = require("node:fs").readFileSync("src/control-center/src/hooks/useSse.ts", "utf8")
		assert.match(source, /SSE_RECONNECT_BACKOFF_MS/)
		assert.match(source, /SSE_RECONNECT_AFTER_SILENCE_MS/)
		assert.match(source, /invalidateQueries\(\{ queryKey: \[event\.topic\] \}\)/)
		assert.match(source, /system\.events-dropped/)
		const hooks = await import("../../src/control-center/src/hooks/useSse.ts")
		assert.equal(typeof hooks.useSse, "function")
		assert.equal(typeof hooks.configureSse, "function")
		const job = await import("../../src/control-center/src/hooks/useJob.ts")
		assert.equal(typeof job.useJob, "function")
	})

	it("T32 migrates only plugin.command while Shell IPC remains authoritative elsewhere", async () => {
		const source = require("node:fs").readFileSync("src/control-center/src/features/plugins/api.ts", "utf8")
		assert.match(source, /\/plugins\/\$\{encodeURIComponent\(pluginId\)\}\/commands\/\$\{encodeURIComponent\(command\)\}/)
		assert.match(source, /job: true, retry: false/)
		const { pluginHttpApi } = await import("../../src/control-center/src/features/plugins/api.ts")
		assert.equal(typeof pluginHttpApi.command, "function")
		assert.equal(typeof pluginHttpApi.list, "function")
		assert.equal(typeof pluginHttpApi.setConfig, "function")
		const app = require("node:fs").readFileSync("src/control-center/src/hooks/usePluginsPaneData.ts", "utf8")
		assert.match(app, /const getPlugins = async \(\) => .*pluginHttpApi\.list\(\)/)
		assert.match(app, /pluginHttpApi\.logs\(/)
		const actions = require("node:fs").readFileSync("src/control-center/src/hooks/usePluginsPaneActions.ts", "utf8")
		assert.match(actions, /pluginHttpApi\.uninstall\(/)
		assert.match(actions, /pluginHttpApi\.enable\(/)
		assert.match(actions, /pluginHttpApi\.nativeApproval\(/)
		assert.match(actions, /pluginHttpApi\.setConfig\(/)
		assert.match(actions, /pluginHttpApi\.command\(/)
		const pane = require("node:fs").readFileSync("src/control-center/src/panes/PluginRow.tsx", "utf8")
		assert.match(pane, /onOpenDashboard/)
		const paneBody = require("node:fs").readFileSync("src/control-center/src/panes/PluginsPaneBody.tsx", "utf8")
		assert.match(paneBody, /onInspectPluginPackage/)
	})

	it("T32 JobPanel uses SSE events and 202 job controls without polling", () => {
		const source = require("node:fs").readFileSync("src/control-center/src/features/jobs/JobPanel.tsx", "utf8")
		assert.match(source, /useSse\(\['jobs'\]\)/)
		assert.match(source, /backendClient\.request/)
		assert.match(source, /\/cancel/)
		assert.match(source, /\/retry/)
		assert.doesNotMatch(source, /setInterval|setTimeout/)
		const app = require("node:fs").readFileSync("src/control-center/src/App.jsx", "utf8")
		assert.match(app, /<JobPanel \/>/)
	})

	it("T32 plugin command preserves returned jobId for the global panel", () => {
		const source = require("node:fs").readFileSync("src/control-center/src/features/plugins/api.ts", "utf8")
		assert.match(source, /Promise<PluginJobCreated>/)
		assert.match(source, /command\(pluginId: string, command: string/)
	})

	it("T32 HTTP plugin command unwraps and preserves queued job ids", async () => {
		const calls = []
		const { configureBackendClient } = await import("../../src/control-center/src/api/backend-client.ts")
		const { pluginHttpApi } = await import("../../src/control-center/src/features/plugins/api.ts")
		const success = (data, status = 200) => new Response(JSON.stringify({ ok: true, data, meta: { requestId: "r_test" } }), {
			status,
			headers: { "content-type": "application/json" },
		})
		try {
			configureBackendClient({
				getBackend: () => ({ baseUrl: "http://127.0.0.1:4321", sessionToken: "test-token" }),
				fetchImpl: async (url, init = {}) => {
					calls.push({ url: String(url), init })
					const pathname = new URL(String(url)).pathname
					if (pathname === "/plugins/demo/commands/run") return success({ jobId: "plugin.command:1" }, 202)
					throw new Error(`unexpected request: ${pathname}`)
				}
			})
			assert.deepEqual(await pluginHttpApi.command("demo", "run", { value: 1 }), { jobId: "plugin.command:1" })
			assert.equal(calls.every(({ init }) => new Headers(init.headers).get("authorization") === "Bearer test-token"), true)
			assert.equal(calls.find(({ url }) => url.endsWith("/commands/run")).init.method, "POST")
		} finally {
			configureBackendClient()
		}
	})

	it("T32 falls back only when the backend is unavailable before dispatch", async () => {
		const { isBackendUnavailableBeforeDispatch } = await import("../../src/control-center/src/features/plugins/api.ts")
		assert.equal(isBackendUnavailableBeforeDispatch({ code: "BACKEND_UNAVAILABLE" }), false)
		assert.equal(isBackendUnavailableBeforeDispatch({ code: "BACKEND_UNAVAILABLE", dispatched: false }), true)
		assert.equal(isBackendUnavailableBeforeDispatch({ code: "BACKEND_UNAVAILABLE", dispatched: true }), false)
		assert.equal(isBackendUnavailableBeforeDispatch({ code: "NOT_FOUND", dispatched: false }), false)
		assert.equal(isBackendUnavailableBeforeDispatch({ code: "PERMISSION_DENIED", dispatched: false }), false)
	})

	it("T32 immediately falls back only for development without a backend bridge", async () => {
		const { shouldUseImmediatePluginCommandFallback, shouldUsePluginDemoApi } = await import("../../src/control-center/src/features/plugins/api.ts")
		assert.equal(shouldUseImmediatePluginCommandFallback(true, false), true)
		assert.equal(shouldUseImmediatePluginCommandFallback(true, true), false)
		assert.equal(shouldUseImmediatePluginCommandFallback(false, false), false)
		assert.equal(shouldUseImmediatePluginCommandFallback(false, true), false)
		assert.equal(shouldUsePluginDemoApi(true, false), true)
		assert.equal(shouldUsePluginDemoApi(true, true), false)
		assert.equal(shouldUsePluginDemoApi(false, false), false)
		assert.equal(shouldUsePluginDemoApi(false, true), false)
		const dataHook = require("node:fs").readFileSync("src/control-center/src/hooks/usePluginsPaneData.ts", "utf8")
		assert.match(dataHook, /useDemoApi\(\) \? api\.getPlugins\(\) : pluginHttpApi\.list\(\)/)
		assert.match(dataHook, /api\.getPluginLogs\(/)
		assert.match(dataHook, /useDemoApi\(\) \? api\.getImGatewaySecretState\(\) : pluginHttpApi\.imSecret\('state'\)/)
	})

	it("T32 backend API errors retain codes for IPC fallback", async () => {
		const { configureSse, requestBackend } = await import("../../src/control-center/src/hooks/useSse.ts")
		configureSse({
			getBackend: () => ({ baseUrl: "http://127.0.0.1:4321", sessionToken: "test-token" }),
			fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: "Plugin service unavailable" } }) })
		})
		await assert.rejects(requestBackend("/plugins"), (error) => {
			assert.equal(error.code, "BACKEND_UNAVAILABLE")
			assert.equal(error.status, 503)
			return true
		})
	})

	it("T32 backend bootstrap stays outside the frozen IPC channel contract", () => {
		const preload = require("node:fs").readFileSync("control-center-preload.js", "utf8")
		const runtime = require("node:fs").readFileSync("src/main/bootstrap/create-openpet-runtime.js", "utf8")
		assert.match(preload, /__openpetBackend/)
		assert.match(runtime, /SETTINGS_CHANGED/)
		assert.doesNotMatch(preload, /BACKEND_GET|BACKEND_CHANGED/)
		assert.doesNotMatch(runtime, /IPC\.BACKEND_GET|IPC\.BACKEND_CHANGED/)
	})

	it("T41 settings IPC exposes backend bootstrap only through the lifecycle bridge", async () => {
		const vm = require("node:vm")
		const source = require("node:fs").readFileSync("control-center-preload.js", "utf8")
		const exposed = {}
		const handlers = {}
		const ipcRenderer = {
			on: (channel, handler) => { handlers[channel] = handler },
			removeListener: () => {},
			invoke: async (_channel, payload) => payload?.includeBackend
				? { settings: {}, backend: { baseUrl: "http://127.0.0.1:4321", sessionToken: "ready" } }
				: {},
			send: () => {}
		}
		vm.runInNewContext(source, {
			require: (name) => name === "electron"
				? { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } }, ipcRenderer }
				: require(name),
			console,
			setTimeout
		})
		const backend = []
		exposed.openpetBackend.onChanged((value) => backend.push(value))
		await new Promise((resolve) => setImmediate(resolve))
		handlers["settings:changed"]({}, { __openpetBackend: { baseUrl: "http://127.0.0.1:4321", sessionToken: "next" } })
		handlers["settings:changed"]({}, { scale: 0.8 })
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(typeof exposed.controlCenterAPI.onSettingsChanged, 'undefined')
		assert.deepEqual(backend, [
			{ baseUrl: "http://127.0.0.1:4321", sessionToken: "next" }
		])
	})

	it("T41 preload forwards runtime cursor status over the existing settings lifecycle bridge", async () => {
		const vm = require("node:vm")
		const source = require("node:fs").readFileSync("control-center-preload.js", "utf8")
		const exposed = {}
		const handlers = {}
		const ipcRenderer = { on: (channel, handler) => { handlers[channel] = handler }, removeListener: () => {}, invoke: async () => ({}), send: () => {} }
		vm.runInNewContext(source, { require: (name) => name === "electron" ? { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } }, ipcRenderer } : require(name), console, setTimeout })
		const statuses = []
		exposed.openpetBackend.onRuntimeStatusChanged((value) => statuses.push(value))
		handlers["settings:changed"]({}, { systemCursorStatus: { supported: true, platform: "darwin", active: true, helperPid: 77 } })
		assert.deepEqual(JSON.parse(JSON.stringify(exposed.openpetBackend.getRuntimeStatus())), { supported: true, platform: "darwin", active: true, helperPid: 77 })
		assert.deepEqual(JSON.parse(JSON.stringify(statuses)), [{ supported: true, platform: "darwin", active: true, helperPid: 77 }])
	})

	it("T44 preload and App keep an unencrypted secret-storage warning visible", () => {
		const fs = require("node:fs")
		const vm = require("node:vm")
		const source = fs.readFileSync("control-center-preload.js", "utf8")
		const exposed = {}
		const handlers = {}
		const ipcRenderer = { on: (channel, handler) => { handlers[channel] = handler }, removeListener: () => {}, invoke: async () => ({}), send: () => {} }
		vm.runInNewContext(source, { require: (name) => name === "electron" ? { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } }, ipcRenderer } : require(name), console, setTimeout })
		const security = []
		exposed.openpetBackend.onSecretStorageSecurityChanged((value) => security.push(value))
		handlers["settings:changed"]({}, {
			__openpetBackend: null,
			__openpetSecretStorageSecurity: {
				encryptionAvailable: false,
				storage: "plaintext-0600",
				warning: "safeStorage 不可用，Provider 密钥正以 0600 权限的明文文件保存。",
			},
		})
		assert.deepEqual(JSON.parse(JSON.stringify(exposed.openpetBackend.getSecretStorageSecurity())), {
			encryptionAvailable: false,
			storage: "plaintext-0600",
			warning: "safeStorage 不可用，Provider 密钥正以 0600 权限的明文文件保存。",
		})
		handlers["settings:changed"]({}, { systemCursorStatus: { supported: true, platform: "darwin", active: false, helperPid: 0 } })
		assert.equal(exposed.openpetBackend.getSecretStorageSecurity().storage, "plaintext-0600")
		assert.equal(security.length, 1)

		const app = fs.readFileSync("src/control-center/src/App.jsx", "utf8")
		assert.match(app, /data-testid="secret-storage-warning"/)
		assert.match(app, /role="alert"/)
		assert.match(app, /onSecretStorageSecurityChanged/)
	})

	it("T32 JobPanel refreshes when a late backend opens without a business event", async () => {
		const { shouldRefreshOnSseState } = await import("../../src/control-center/src/features/jobs/policy.ts")
		assert.equal(shouldRefreshOnSseState("unavailable", "open"), true)
		assert.equal(shouldRefreshOnSseState("reconnecting", "open"), true)
		assert.equal(shouldRefreshOnSseState("open", "open"), false)
		assert.equal(shouldRefreshOnSseState("connecting", "reconnecting"), false)
	})

	it("T32 retry action is hidden after max attempts are exhausted", async () => {
		const { canRetryJob } = await import("../../src/control-center/src/features/jobs/policy.ts")
		assert.equal(canRetryJob({ status: "failed", attempt: 1, maxAttempts: 2 }), true)
		assert.equal(canRetryJob({ status: "interrupted", attempt: 1, maxAttempts: 1 }), false)
		assert.equal(canRetryJob({ status: "failed", attempt: 2, maxAttempts: 2 }), false)
		assert.equal(canRetryJob({ status: "running", attempt: 1, maxAttempts: 2 }), false)
	})

	it("T42 reconnects when a new topic is subscribed after the SSE connection is open", async () => {
		const { SseManager } = await import("../../src/control-center/src/hooks/useSse.ts")
		const manager = new SseManager()
		let resolveRead
		const reads = []
		const calls = []
		manager.configure({
			getBackend: () => ({ baseUrl: "http://127.0.0.1:4321", sessionToken: "test-token" }),
			fetchImpl: async (url, init) => {
				calls.push({ url: String(url), signal: init.signal })
				const body = new ReadableStream({ start(controller) { resolveRead = () => controller.close() } })
				return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
			}
		})
		const stopSettings = manager.subscribe(["settings"], () => {}, () => {})
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(calls.length, 1)
		const stopPet = manager.subscribe(["pet"], () => {}, () => {})
		assert.equal(calls[0].signal.aborted, true)
		stopPet(); stopSettings(); try { resolveRead?.() } catch { /* reconnect already canceled the stream */ }
	})
})
