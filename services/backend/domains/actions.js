import { randomUUID } from "node:crypto"
import { ERROR_CODES, EVENT_ACTIONS_CHANGED } from "@openpet/contracts"
import { ApiError } from "../http/middleware.js"

const ERROR_CODE_SET = new Set(ERROR_CODES)

function requiredString(value, field) {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
		throw new ApiError("VALIDATION_FAILED", `${field} is required`)
	}
	return value
}

function object(value = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("VALIDATION_FAILED", "Actions input must be an object")
	return value
}

export function createActionService({ shell, jobs, emit, now = Date.now } = {}) {
	if (typeof shell?.request !== "function") throw new TypeError("Shell Actions bridge required")

	const authority = async (operation, payload = {}) => {
		let envelope
		try {
			envelope = await shell.request(
				{ type: "actions.request", operation, payload },
				{ expectedType: "actions.result", expectedOperation: operation },
			)
		} catch (cause) {
			if (cause instanceof ApiError) throw cause
			throw new ApiError("BACKEND_UNAVAILABLE", "Shell Actions authority unavailable", { cause })
		}
		const body = envelope?.body
		if (body?.type !== "actions.result" || body.operation !== operation || typeof body.ok !== "boolean") {
			throw new ApiError("INTERNAL", "Shell Actions response is invalid")
		}
		if (!body.ok) {
			const code = ERROR_CODE_SET.has(body.error?.code) ? body.error.code : "INTERNAL"
			throw new ApiError(code, body.error?.message || "Shell Actions operation failed", {
				...(code === "ACTION_FRAMES_MISSING" ? { status: 400 } : {}),
			})
		}
		return body.result
	}
	const mutate = async (operation, payload) => {
		const result = await authority(operation, payload)
		if (result?.ok !== false) emit?.(EVENT_ACTIONS_CHANGED, { at: now(), actions: result?.animations?.actions ?? [] })
		return result
	}
	const list = () => authority("get")
	const selection = (input = {}) => ({ selectionId: requiredString(input.selectionId, "selectionId"), ...(input.actionId ? { actionId: requiredString(input.actionId, "actionId") } : {}) })

	const importFrames = (input = {}) => {
		object(input)
		const payload = { ...selection(input), actionId: requiredString(input.actionId, "actionId") }
		if (input.label !== undefined) {
			if (typeof input.label !== "string" || input.label.length > 256) throw new ApiError("VALIDATION_FAILED", "Action label is invalid")
			payload.label = input.label
		}
		if (!jobs?.insert) throw new ApiError("BACKEND_UNAVAILABLE", "Job service unavailable")
		const job = jobs.insert({
			id: `actions-import:${randomUUID()}`,
			kind: "actions.import-frames",
			input: payload,
			resourceKey: "actions:import",
		})
		return { jobId: job.id }
	}
	const runImportFrames = async ({ selectionId, actionId, label, signal, report, finalize } = {}) => {
		if (signal?.aborted) throw signal.reason ?? new ApiError("CONFLICT", "Action import canceled")
		if (typeof finalize !== "function") throw new ApiError("INTERNAL", "Action import requires a finalization boundary")
		const payload = { ...selection({ selectionId, actionId }), actionId: requiredString(actionId, "actionId"), ...(label === undefined ? {} : { label }) }
		report?.({ phase: "importing", percent: 10, message: "Preparing action import" })
		// The host writes active-pack assets. Lock cancellation before dispatch.
		return finalize(() => mutate("import", payload))
	}
	return {
		list,
		get: list,
		inspect: (input = {}) => authority("inspect", object(input)),
		reinspect: (input = {}) => authority("reinspect", selection(object(input))),
		clearSelection: (input = {}) => authority("clear-selection", selection(object(input))),
		importFrames,
		runImportFrames,
		updateConfig: (input = {}) => mutate("save-config", object(input)),
		remove: (actionId) => mutate("remove", { actionId: requiredString(actionId, "actionId") }),
		previewProposal: (input = {}) => authority("preview-proposal", object(input)),
		submitProposal: (input = {}) => mutate("submit-proposal", object(input)),
		acceptProposal: (proposalId) => mutate("accept-proposal", { proposalId: requiredString(proposalId, "proposalId") }),
		rejectProposal: (proposalId, reason) => mutate("reject-proposal", { proposalId: requiredString(proposalId, "proposalId"), ...(reason === undefined ? {} : { reason }) }),
		updateRule: (ruleId, patch = {}) => mutate("update-rule", { ...object(patch), ruleId: requiredString(ruleId, "ruleId") }),
		deleteRule: (ruleId) => mutate("delete-rule", { ruleId: requiredString(ruleId, "ruleId") }),
	}
}
