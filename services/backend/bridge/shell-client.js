// 反向通道客户端。包住 process.send / process.on("message"),对上提供
// send / request / waitFor / on 四个动作。
//
// 请求与回复的关联方式:Shell 回复时沿用同一个信封 id。这与 07 篇 spike 1 里
// shell.js 的行为一致(它用 id:"1" 回了 init),因此不新增 replyTo 字段 ——
// 信封形状是冻结的契约面,能不动就不动。

import { ERROR_CODES } from "@openpet/contracts"
import { ApiError } from "../http/middleware.js"
import {
	BACKEND_TO_SHELL_TYPES,
	DIALOG_RESULT_TIMEOUT_MS,
	EXIT_CODE_VERSION_MISMATCH,
	SHELL_TO_BACKEND_TYPES,
	createEnvelope,
	parseEnvelope,
} from "./message-schema.js"

export function createShellClient({ send, exit = (code) => process.exit(code), logger } = {}) {
	if (typeof send !== "function") throw new Error("createShellClient 需要 send(envelope)")

	const handlers = new Map()
	const waiters = new Map()
	const pending = new Map()
	let disposed = false

	function validateExpectedResponse(envelope, expectedType, expectedOperation) {
		if (!expectedType) return null
		if (envelope.body.type !== expectedType) {
			return `unexpected Shell response type: expected ${expectedType}, got ${envelope.body.type}`
		}
		if (expectedType === "settings.apply.result") {
			const body = envelope.body
			if (!Number.isInteger(body.version) || body.version < 0) return "settings.apply.result has an invalid version"
			if (typeof body.ok !== "boolean") return "settings.apply.result has an invalid ok field"
			if (body.error !== undefined && typeof body.error !== "string") return "settings.apply.result has an invalid error"
		}
		if (expectedType === "secrets.persist.result") {
			const body = envelope.body
			if (typeof body.providerId !== "string" || body.providerId.length === 0) return "secrets.persist.result has an invalid providerId"
			if (typeof body.ok !== "boolean") return "secrets.persist.result has an invalid ok field"
			if (body.error !== undefined && typeof body.error !== "string") return "secrets.persist.result has an invalid error"
			const allowed = new Set(["type", "providerId", "ok", "error"])
			if (Object.keys(body).some((key) => !allowed.has(key))) return "secrets.persist.result has unexpected fields"
		}
		if (expectedType === "catalog.result") {
			const body = envelope.body
			if (typeof body.ok !== "boolean") return "catalog.result has an invalid ok field"
			if (body.ok && !Object.hasOwn(body, "result")) return "catalog.result has no result"
			if (!body.ok && typeof body.error !== "string") return "catalog.result has no error"
		}
		if (expectedType === "pet-packs.result" || expectedType === "actions.result") {
			const body = envelope.body
			if (body.operation !== expectedOperation) {
				return `unexpected ${expectedType} operation: expected ${expectedOperation}, got ${String(body.operation)}`
			}
			if (typeof body.ok !== "boolean") return `${expectedType} has an invalid ok field`
			if (body.ok && body.error !== undefined) return `successful ${expectedType} must not include an error`
			if (expectedType === "actions.result" && body.ok && !Object.hasOwn(body, "result")) return "actions.result has no result"
			if (!body.ok) {
				if (body.error === null || typeof body.error !== "object" || Array.isArray(body.error)) {
					return `failed ${expectedType} has no structured error`
				}
				if (!ERROR_CODES.includes(body.error.code)) return `${expectedType} has an invalid error code`
				if (typeof body.error.message !== "string" || body.error.message.length === 0) {
					return `${expectedType} has an invalid error message`
				}
			}
		}
		if (expectedType === "pet.command.result") {
			const body = envelope.body
			if (typeof body.ok !== "boolean") return "pet.command.result has an invalid ok field"
			if (body.ok && !Object.hasOwn(body, "result")) return "pet.command.result has no result"
			if (!body.ok && typeof body.error !== "string") return "pet.command.result has no error"
		}
		return null
	}

	function receive(raw) {
		if (disposed) return

		const parsed = parseEnvelope(raw, { allowedTypes: SHELL_TO_BACKEND_TYPES })
		if (!parsed.ok) {
			if (parsed.reason === "version-mismatch") {
				logger?.error?.("反向通道信封版本不符,按 ADR-011 退出", {
					detail: parsed.detail,
					exitCode: EXIT_CODE_VERSION_MISMATCH,
				})
				exit(EXIT_CODE_VERSION_MISMATCH)
				return
			}
			// 其余异常一律丢弃。不退进程:一条脏消息不应该能放倒整个后端。
			logger?.warn?.("丢弃无法解析的 Shell 消息", { reason: parsed.reason, detail: parsed.detail })
			return
		}

		const envelope = parsed.envelope

		const awaiting = pending.get(envelope.id)
		if (awaiting !== undefined) {
			pending.delete(envelope.id)
			clearTimeout(awaiting.timer)
			const validationError = validateExpectedResponse(envelope, awaiting.expectedType, awaiting.expectedOperation)
			if (validationError) awaiting.reject(new Error(validationError))
			else awaiting.resolve(envelope)
			return
		}

		const typeWaiters = waiters.get(envelope.body.type)
		if (typeWaiters !== undefined && typeWaiters.size > 0) {
			for (const waiter of typeWaiters) {
				clearTimeout(waiter.timer)
				waiter.resolve(envelope)
			}
			typeWaiters.clear()
		}

		const listeners = handlers.get(envelope.body.type)
		if (listeners === undefined) return
		for (const listener of listeners) {
			try {
				listener(envelope)
			} catch (error) {
				logger?.error?.("反向通道监听器抛出", { type: envelope.body.type, error: String(error) })
			}
		}
	}

	function dispatch(body, correlateDialogRequest, options = {}) {
		if (disposed) return null
		if (body === null || typeof body !== "object" || typeof body.type !== "string") {
			throw new Error("反向通道消息必须是带 type 的对象")
		}
		if (!BACKEND_TO_SHELL_TYPES.includes(body.type)) {
			// R15:不在白名单里的类型直接报错,而不是默默发出去。
			throw new Error("不在白名单里的反向通道消息类型: " + body.type)
		}
		const envelope = createEnvelope(body, { id: options.id })
		if (correlateDialogRequest && body.type === "dialog.request") {
			envelope.body = { ...body, requestId: envelope.id }
		}
		send(envelope)
		return envelope
	}

	function sendBody(body, options = {}) {
		return dispatch(body, false, options)
	}

	function reply(id, body) {
		if (typeof id !== "string" || id.length === 0) throw new Error("反向通道回复需要 envelope id")
		return dispatch(body, false, { id })
	}

	function request(body, options = {}) {
		const timeoutMs = options.timeoutMs ?? DIALOG_RESULT_TIMEOUT_MS
		// Bind host requests to their response type as well as their envelope id.
		const expectedType = options.expectedType ?? ({
			"settings.apply.request": "settings.apply.result",
			"secrets.persist.request": "secrets.persist.result",
			"catalog.request": "catalog.result",
			"pet-packs.request": "pet-packs.result",
			"actions.request": "actions.result",
			"pet.command.request": "pet.command.result",
		})[body?.type] ?? null
		const expectedOperation = options.expectedOperation ?? (["pet-packs.request", "actions.request"].includes(body?.type) ? body.operation : null)
		const envelope = dispatch(body, true)
		if (envelope === null) return Promise.reject(new Error("shellClient 已销毁"))

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(envelope.id)
				// ⚠️ 03 篇定的是 504,而 504 对应的码叫 PROVIDER_TIMEOUT。Shell 弹窗不是
				// provider,语义别扭;但错误码表是冻结契约,新增 SHELL_TIMEOUT 要走 §10
				// 的冻结点流程。先按 504 实现。
				reject(
					new ApiError("PROVIDER_TIMEOUT", "Shell 在 " + timeoutMs + "ms 内没有回复 " + body.type, {
						details: { type: body.type, envelopeId: envelope.id },
					}),
				)
			}, timeoutMs)
			timer.unref?.()
			pending.set(envelope.id, { resolve, reject, timer, expectedType, expectedOperation })
		})
	}

	function waitFor(type, options = {}) {
		const timeoutMs = options.timeoutMs ?? DIALOG_RESULT_TIMEOUT_MS
		return new Promise((resolve, reject) => {
			if (!waiters.has(type)) waiters.set(type, new Set())
			const bucket = waiters.get(type)
			const waiter = { resolve, reject, timer: null }
			waiter.timer = setTimeout(() => {
				bucket.delete(waiter)
				reject(new Error("等待 Shell 消息 " + type + " 超过 " + timeoutMs + "ms"))
			}, timeoutMs)
			waiter.timer.unref?.()
			bucket.add(waiter)
		})
	}

	function on(type, listener) {
		if (!handlers.has(type)) handlers.set(type, new Set())
		handlers.get(type).add(listener)
		return () => handlers.get(type)?.delete(listener)
	}

	function dispose() {
		disposed = true
		for (const awaiting of pending.values()) {
			clearTimeout(awaiting.timer)
			awaiting.reject(new Error("shellClient 已销毁"))
		}
		pending.clear()
		for (const bucket of waiters.values()) {
			for (const waiter of bucket) clearTimeout(waiter.timer)
			bucket.clear()
		}
		waiters.clear()
		handlers.clear()
	}

	return { receive, send: sendBody, reply, request, waitFor, on, dispose }
}
