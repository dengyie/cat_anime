// HTTP 关注点:错误类型、响应信封、鉴权、body 上限、访问日志。
// 契约来源:docs/refactor/03-api-contract.md §2(信封与错误码)、§8(鉴权)。
//
// 为什么这些都在同一个文件而不是单独的 errors.js / respond.js:
// 02 篇 §3 的目标目录树里 http/ 只有 router.js 与 middleware.js。为了让代码与文档
// 的目录树严格一致,本文件承担全部「HTTP 关注点」,router.js 只做分发并从这里
// import(反向 import 会形成环)。

import { createHash, randomUUID, timingSafeEqual } from "node:crypto"

// 03 篇 §2.3 的 13 个通用错误码 -> HTTP 状态。
//
// ⚠️ 故意只有通用码。8 个专用业务码(PLUGIN_MANIFEST_INVALID 等)不在这里出现,
// 抛出方必须显式传 status。原因:完整映射的权威副本在
// packages/contracts/src/envelope.ts,而本包还没接入根 workspaces(等 spike 5),
// 现在 import 不到。只复制通用码这一小半能把漂移面压到最小;接入 workspaces 后
// 本常量改为 re-export,并给 check:api-contract 加一条对账。
export const GENERIC_ERROR_HTTP_STATUS = Object.freeze({
	VALIDATION_FAILED: 400,
	UNAUTHORIZED: 401,
	PERMISSION_DENIED: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	PAYLOAD_TOO_LARGE: 413,
	UNSUPPORTED_MEDIA_TYPE: 415,
	LOCKED: 423,
	RATE_LIMITED: 429,
	INTERNAL: 500,
	PROVIDER_ERROR: 502,
	BACKEND_UNAVAILABLE: 503,
	PROVIDER_TIMEOUT: 504,
})

export const RETRYABLE_ERROR_CODES = Object.freeze(
	new Set(["RATE_LIMITED", "INTERNAL", "PROVIDER_ERROR", "BACKEND_UNAVAILABLE", "PROVIDER_TIMEOUT"]),
)

export const MAX_BODY_BYTES = 1024 * 1024
export const DEFAULT_MAX_ACCESS_LOGS = 200

const KNOWN_CLIENTS = Object.freeze(new Set(["control-center", "pet-window", "mcp"]))
const LOOPBACK_HOSTS = Object.freeze(new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]))
const BEARER_PREFIX = "bearer "
const BODYLESS_METHODS = Object.freeze(new Set(["GET", "HEAD", "DELETE", "OPTIONS"]))
const CORS_METHODS = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
const CORS_HEADERS = Object.freeze([
	"accept",
	"authorization",
	"content-type",
	"idempotency-key",
	"last-event-id",
	"x-client",
	"x-request-id",
])
const CORS_METHOD_SET = new Set(CORS_METHODS)
const CORS_HEADER_SET = new Set(CORS_HEADERS)

export class ApiError extends Error {
	constructor(code, message, options = {}) {
		super(message ?? code)
		this.name = "ApiError"
		this.code = code
		this.status = options.status ?? GENERIC_ERROR_HTTP_STATUS[code] ?? 500
		this.details = options.details ?? null
		this.retryable = options.retryable ?? RETRYABLE_ERROR_CODES.has(code)
		if (options.cause !== undefined) this.cause = options.cause
	}
}

export function elapsedMs(ctx) {
	return Math.round(performance.now() - ctx.startedAt)
}

function writeJson(ctx, status, payload) {
	if (ctx.res.writableEnded) return
	const body = Buffer.from(JSON.stringify(payload), "utf8")
	ctx.res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.byteLength),
		"cache-control": "no-store",
	})
	ctx.res.end(body)
}

export function sendSuccess(ctx, data, status = 200) {
	writeJson(ctx, status, { ok: true, data, meta: { requestId: ctx.requestId, elapsedMs: elapsedMs(ctx) } })
}

export function sendList(ctx, items, options = {}) {
	sendSuccess(ctx, { items, total: options.total ?? items.length, cursor: options.cursor ?? null })
}

export function sendError(ctx, error) {
	const apiError = error instanceof ApiError ? error : new ApiError("INTERNAL", "后端内部错误", { cause: error })
	writeJson(ctx, apiError.status, {
		ok: false,
		error: {
			code: apiError.code,
			message: apiError.message,
			details: apiError.details,
			retryable: apiError.retryable,
			requestId: ctx.requestId,
		},
	})
}

export function requestId() {
	return async (ctx, next) => {
		const header = ctx.req.headers["x-request-id"]
		const usable = typeof header === "string" && header.length > 0 && header.length <= 200
		ctx.requestId = usable ? header : randomUUID()
		ctx.res.setHeader("x-request-id", ctx.requestId)
		await next()
	}
}

export function errorBoundary({ logger } = {}) {
	return async (ctx, next) => {
		try {
			await next()
		} catch (error) {
			const expected = error instanceof ApiError && error.status < 500
			if (!expected) {
				logger?.error?.("请求处理失败", {
					requestId: ctx.requestId,
					method: ctx.method,
					path: ctx.rawPath,
					error: String(error),
					stack: error?.stack,
				})
			}
			sendError(ctx, error)
		}
	}
}

export function loopbackOnly() {
	return async (ctx, next) => {
		// 02 篇 §6:后端只监听回环。listen("127.0.0.1") 已经挡住外部,这一层是纵深
		// 防御 —— 将来若有人误改成 0.0.0.0,请求仍然进不来。
		const remote = ctx.req.socket?.remoteAddress ?? ""
		if (!LOOPBACK_HOSTS.has(remote)) {
			throw new ApiError("PERMISSION_DENIED", "只接受来自回环地址的请求", { details: { remoteAddress: remote } })
		}
		await next()
	}
}

function trustedRendererOrigin(origin) {
	if (origin === "null") return true
	if (typeof origin !== "string") return false
	try {
		const parsed = new URL(origin)
		return parsed.protocol === "http:" &&
			parsed.hostname === "127.0.0.1" &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.pathname === "/" &&
			parsed.search === "" &&
			parsed.hash === ""
	} catch {
		return false
	}
}

function appendVary(res, names) {
	const existing = String(res.getHeader("vary") ?? "")
	const values = new Map()
	for (const name of [...existing.split(","), ...names]) {
		const trimmed = name.trim()
		if (trimmed.length > 0) values.set(trimmed.toLowerCase(), trimmed)
	}
	res.setHeader("vary", Array.from(values.values()).join(", "))
}

function requestedCorsHeaders(value) {
	if (typeof value !== "string" || value.trim() === "") return []
	return value.split(",").map((header) => header.trim().toLowerCase()).filter(Boolean)
}

/**
 * Electron 的 file:// renderer 会以 Origin:null 跨源访问随机端口 sidecar；开发态
 * Control Center 则从 127.0.0.1 的 Vite 端口访问。只为这两类 origin 回显 CORS，
 * 预检仍须来自回环 socket，实际请求仍继续经过 bearerAuth。
 */
export function cors() {
	return async (ctx, next) => {
		const origin = ctx.req.headers.origin
		if (!trustedRendererOrigin(origin)) {
			await next()
			return
		}

		ctx.res.setHeader("access-control-allow-origin", origin)
		ctx.res.setHeader("access-control-expose-headers", "x-request-id")
		appendVary(ctx.res, ["Origin"])

		const requestedMethod = ctx.req.headers["access-control-request-method"]
		if (ctx.method !== "OPTIONS" || typeof requestedMethod !== "string") {
			await next()
			return
		}

		const method = requestedMethod.toUpperCase()
		const headers = requestedCorsHeaders(ctx.req.headers["access-control-request-headers"])
		if (!CORS_METHOD_SET.has(method) || headers.some((header) => !CORS_HEADER_SET.has(header))) {
			throw new ApiError("PERMISSION_DENIED", "CORS 预检请求包含不允许的方法或头部", {
				details: { method, headers },
			})
		}

		ctx.res.setHeader("access-control-allow-methods", CORS_METHODS.join(", "))
		ctx.res.setHeader("access-control-allow-headers", CORS_HEADERS.join(", "))
		ctx.res.setHeader("access-control-max-age", "600")
		appendVary(ctx.res, ["Access-Control-Request-Method", "Access-Control-Request-Headers"])
		ctx.res.writeHead(204)
		ctx.res.end()
	}
}

function digest(value) {
	return createHash("sha256").update(String(value), "utf8").digest()
}

function constantTimeEqual(left, right) {
	// 先摘要再比:timingSafeEqual 在长度不等时会直接抛,而抛与不抛本身就是一个侧信道。
	return timingSafeEqual(digest(left), digest(right))
}

function readBearer(authorization) {
	if (typeof authorization !== "string") return null
	if (!authorization.toLowerCase().startsWith(BEARER_PREFIX)) return null
	const token = authorization.slice(BEARER_PREFIX.length).trim()
	return token.length > 0 ? token : null
}

function firstString(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value
	}
	return null
}

function matches(expected, presented) {
	if (typeof expected !== "string" || expected.length === 0) return false
	if (typeof presented !== "string" || presented.length === 0) return false
	return constantTimeEqual(presented, expected)
}

/**
 * 03 篇 §8:Authorization: Bearer <sessionToken>。
 * 未鉴权一律 401,**不设例外**(含 /health)。
 *
 * legacyPathPrefixes 是 ADR-009 的兼容口:/api/pet/* 与 /mcp 沿用旧的
 * x-openpet-token / x-ibot-token,只在这两个前缀下生效。不传 getLegacyToken
 * 或返回空值,等于关掉这两个入口。
 */
export function bearerAuth({ getSessionToken, legacyPathPrefixes = [], getLegacyToken } = {}) {
	return async (ctx, next) => {
		const presented = readBearer(ctx.req.headers.authorization)

		if (matches(getSessionToken?.(), presented)) {
			ctx.client = readClient(ctx.req.headers["x-client"])
			await next()
			return
		}

		const isLegacyPath = legacyPathPrefixes.some(
			(prefix) => ctx.rawPath === prefix || ctx.rawPath.startsWith(prefix + "/"),
		)
		if (isLegacyPath) {
			const legacyPresented = firstString(
				presented,
				ctx.req.headers["x-openpet-token"],
				ctx.req.headers["x-ibot-token"],
			)
			if (matches(getLegacyToken?.(), legacyPresented)) {
				ctx.client = "mcp"
				await next()
				return
			}
		}

		throw new ApiError("UNAUTHORIZED", "缺少或无效的 Authorization: Bearer <sessionToken>")
	}
}

function readClient(header) {
	return typeof header === "string" && KNOWN_CLIENTS.has(header) ? header : null
}

/**
 * 读并解析 JSON 请求体。上限 1 MB(03 篇 §2),流式累加字节数,
 * 不等完整读完才判断 —— 否则 1 MB 上限形同虚设。
 */
export function jsonBody({ maxBytes = MAX_BODY_BYTES } = {}) {
	return async (ctx, next) => {
		if (BODYLESS_METHODS.has(ctx.method)) {
			await next()
			return
		}

		const declared = ctx.req.headers["content-length"]
		if (declared !== undefined && Number(declared) > maxBytes) {
			throw new ApiError("PAYLOAD_TOO_LARGE", "请求体超过 " + maxBytes + " 字节")
		}

		const chunks = []
		let size = 0
		for await (const chunk of ctx.req) {
			size += chunk.length
			if (size > maxBytes) {
				throw new ApiError("PAYLOAD_TOO_LARGE", "请求体超过 " + maxBytes + " 字节")
			}
			chunks.push(chunk)
		}

		if (size === 0) {
			await next()
			return
		}

		const contentType = String(ctx.req.headers["content-type"] ?? "").toLowerCase()
		if (!contentType.startsWith("application/json")) {
			throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "只接受 application/json", {
				details: { contentType: contentType.length > 0 ? contentType : null },
			})
		}

		try {
			ctx.body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
		} catch (cause) {
			throw new ApiError("VALIDATION_FAILED", "请求体不是合法 JSON", {
				details: { reason: String(cause?.message ?? cause) },
			})
		}

		await next()
	}
}

/** 环形缓冲,供 POST /service/diagnostics 读取最近的访问记录。 */
export function createAccessLogBuffer({ max = DEFAULT_MAX_ACCESS_LOGS } = {}) {
	const entries = []
	return {
		max,
		push(entry) {
			entries.push(entry)
			if (entries.length > max) entries.splice(0, entries.length - max)
		},
		list() {
			return entries.slice()
		},
		size() {
			return entries.length
		},
	}
}

/**
 * Record after the response finishes so outer error handlers have set its status.
 *
 * 只记方法、路径、状态、耗时、客户端。**不记 body、不记 query、不记头部** ——
 * query 里可能带搜索词,头部里带 token,日志是会进诊断包的。
 */
export function accessLog({ buffer, logger, appendHttp } = {}) {
	return async (ctx, next) => {
		let recorded = false
		const record = () => {
			if (recorded) return
			recorded = true
			ctx.res.off("finish", record)
			ctx.res.off("close", record)
			const at = Date.now()
			const entry = {
				at: new Date(at).toISOString(),
				requestId: ctx.requestId,
				method: ctx.method,
				path: ctx.rawPath,
				status: ctx.res.statusCode,
				elapsedMs: elapsedMs(ctx),
				client: ctx.client,
			}
			buffer?.push?.(entry)
			try {
				appendHttp?.({ ...entry, at, authorized: ctx.client !== null })
			} catch (error) {
				logger?.warn?.("写入 HTTP 访问日志失败", { error: String(error) })
			}
			if (entry.status >= 500) logger?.warn?.("请求以 5xx 结束", entry)
		}
		ctx.res.once("finish", record)
		ctx.res.once("close", record)
		await next()
	}
}
