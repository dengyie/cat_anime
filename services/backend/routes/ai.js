import { randomUUID } from "node:crypto"
import { ApiError, sendSuccess } from "../http/middleware.js"

export const AI_SECRET_ROUTES = Object.freeze([
	"PUT /ai/providers/:id/key",
	"DELETE /ai/providers/:id/key",
])

export const AI_ROUTES = Object.freeze(["POST /ai/images/generate"])

function apiKey(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.apiKey !== "string") {
		throw new ApiError("VALIDATION_FAILED", "apiKey is required", { details: { field: "apiKey" } })
	}
	return body.apiKey
}

function containsCredential(value) {
	if (Array.isArray(value)) return value.some(containsCredential)
	if (!value || typeof value !== "object") return false
	return Object.entries(value).some(([key, entry]) => /api.?key|password|secret|token|credential/i.test(key) || containsCredential(entry))
}

export function registerAiSecretRoutes(router, { secrets, onChanged } = {}) {
	if (!router || typeof router.put !== "function" || typeof router.delete !== "function") {
		throw new TypeError("registerAiSecretRoutes requires router")
	}
	if (!secrets || typeof secrets.set !== "function" || typeof secrets.clear !== "function") {
		throw new TypeError("registerAiSecretRoutes requires secrets service")
	}

	router.put("/ai/providers/:id/key", async (ctx) => {
		const result = await secrets.set(ctx.params.id, apiKey(ctx.body))
		onChanged?.()
		return sendSuccess(ctx, result)
	})
	router.delete("/ai/providers/:id/key", async (ctx) => {
		const result = await secrets.clear(ctx.params.id)
		onChanged?.()
		return sendSuccess(ctx, result)
	})
}

export function registerAiRoutes(router, { jobs } = {}) {
	if (!router || typeof router.post !== "function") throw new TypeError("registerAiRoutes requires router")
	router.post("/ai/images/generate", (ctx) => {
		if (!jobs?.insert) throw new ApiError("BACKEND_UNAVAILABLE", "Job service unavailable")
		const input = ctx.body
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("VALIDATION_FAILED", "Image generation input is required")
		if (containsCredential(input)) {
			throw new ApiError("VALIDATION_FAILED", "Image generation credentials are host-managed")
		}
		const job = jobs.insert({ id: `image-generate:${randomUUID()}`, kind: "image.generate", input })
		return sendSuccess(ctx, { jobId: job.id }, 202)
	})
}
