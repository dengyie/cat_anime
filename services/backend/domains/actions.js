import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { EVENT_ACTIONS_CHANGED } from "@openpet/contracts"
import { ApiError } from "../http/middleware.js"

const require = createRequire(import.meta.url)
const { inspectFrameFolder } = require("../../../src/main/services/sprite-generator.js")
const { createActionImportService } = require("../../../src/main/services/action-import-service.js")
const { createActionService: createHostActionService } = require("../../../src/main/services/action-service.js")
const { getLegacyPetAnimations } = require("../../../src/main/pet-pack/loader.js")
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

function id(value, field = "Action id") {
	if (typeof value !== "string" || !SAFE_ID.test(value)) throw new ApiError("VALIDATION_FAILED", `${field} is invalid`)
	return value
}
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch (_) { return { defaultAction: "", clickAction: "", actions: [], triggerProposalInbox: [], triggerRules: [] } }
}
function translate(error) {
	if (error instanceof ApiError) return error
	const message = String(error?.message || error || "Action operation failed")
	const code = /does not exist|not found|no longer available/i.test(message) ? "NOT_FOUND"
		: /already exists|last action|read-only|not (?:pending|active)/i.test(message) ? "CONFLICT"
		: /invalid|unsupported|required|must be|does not match/i.test(message) ? "VALIDATION_FAILED" : "INTERNAL"
	return new ApiError(code, message, { status: code === "INTERNAL" ? 500 : undefined, cause: error })
}
function sourcePath(value) {
	if (typeof value !== "string" || !path.isAbsolute(value)) throw new ApiError("VALIDATION_FAILED", "Frame folder path must be absolute")
	let real
	try { real = fs.realpathSync(value) } catch (_) { throw new ApiError("VALIDATION_FAILED", "Frame folder does not exist") }
	try { if (fs.lstatSync(value).isSymbolicLink()) throw new ApiError("VALIDATION_FAILED", "Frame folder must not be a symbolic link") } catch (error) {
		if (error instanceof ApiError) throw error
		throw new ApiError("VALIDATION_FAILED", "Frame folder does not exist")
	}
	if (!fs.statSync(real).isDirectory()) throw new ApiError("VALIDATION_FAILED", "Frame folder must be a directory")
	return real
}

export function createActionService({ root, jobs, shell, now = Date.now, emit } = {}) {
	if (typeof root !== "string" || !path.isAbsolute(root)) throw new TypeError("action root must be absolute")
	const configPath = path.join(root, "cat_anime", "animations.json")
	const importer = createActionImportService({ framesRoot: path.join(root, "cat_anime", "flames"), spritesDir: path.join(root, "cat_anime", "sprites"), configPath })
	const host = createHostActionService({
		projectRoot: root,
		loadLegacyAnimations: () => getLegacyPetAnimations({ configPath }),
		saveLegacyAnimations: (config) => { fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8") },
	})
	let selection = null
	const publish = () => emit?.(EVENT_ACTIONS_CHANGED, { at: now(), actions: host.getConfig().actions ?? [] })
	const get = () => clone(host.getConfig())

	const inspect = async (folder, actionId) => {
		const real = sourcePath(folder)
		const inspection = await inspectFrameFolder(real)
		if (actionId && host.getConfig().actions.some((item) => item.id === actionId)) { inspection.errors = [...inspection.errors, `Action ID already exists: ${actionId}`]; inspection.valid = false }
		if (!inspection.valid) throw new ApiError("ACTION_FRAMES_MISSING", inspection.errors.join("; ") || "No valid action frames", { status: 400, details: { path: real, inspection } })
		return { path: real, folderName: path.basename(real), actionId: actionId || path.basename(real), inspection }
	}
	const requestFolder = async () => {
		if (!shell?.request) throw new ApiError("BACKEND_UNAVAILABLE", "dialog service unavailable")
		const reply = await shell.request({ type: "dialog.request", mode: "directory" }, { expectedType: "dialog.result" })
		const paths = reply?.body?.paths
		if (paths === null) return null
		if (!Array.isArray(paths) || typeof paths[0] !== "string") throw new ApiError("VALIDATION_FAILED", "dialog returned no frame folder")
		return paths[0]
	}
	const inspectFrames = async (folder, actionId) => {
		const selected = folder ?? await requestFolder()
		if (selected === null) return { canceled: true }
		const result = await inspect(selected, actionId)
		selection = result
		return result
	}
	const importFrames = async (folder, actionId, label) => {
		const selected = folder ?? selection?.path ?? await requestFolder()
		if (selected === null) return { canceled: true }
		if (!selected) throw new ApiError("VALIDATION_FAILED", "Frame folder selection is required")
		const result = await inspect(selected, actionId)
		const resolvedId = id(actionId || result.actionId)
		if (!jobs?.insert) throw new ApiError("BACKEND_UNAVAILABLE", "Job service unavailable")
		const job = jobs.insert({ id: `actions-import-frames:${resolvedId}:${now()}`, kind: "actions.import-frames", input: { path: result.path, actionId: resolvedId, ...(label ? { label } : {}) }, resourceKey: `actions:${resolvedId}` })
		return { jobId: job.id, actionId: resolvedId, inspection: result.inspection }
	}
	const runImportFrames = async ({ path: sourceDir, actionId, label, signal, report } = {}) => {
		if (signal?.aborted) throw signal.reason ?? new Error("Job canceled")
		report?.({ phase: "generating", percent: 25, message: "Generating action sprites" })
		const result = await importer.importActionFrames({ sourceDir, actionId, label })
		if (signal?.aborted) throw signal.reason ?? new Error("Job canceled")
		publish()
		return result
	}
	const play = async (actionId, source = "http:actions") => {
		const normalized = id(actionId)
		if (!host.getConfig().actions.some((item) => item.id === normalized)) throw new ApiError("NOT_FOUND", `Action not found: ${normalized}`)
		const reply = await shell?.request?.({ type: "pet.command.request", operation: "playAction", payload: { actionId: normalized, source } }, { expectedType: "pet.command.result" })
		if (reply?.body?.ok !== true) throw new ApiError("BACKEND_UNAVAILABLE", reply?.body?.error || "Shell pet command failed")
		return reply.body.result
	}
	const mutate = (fn) => { try { const result = fn(); publish(); return clone(result) } catch (error) { throw translate(error) } }
	const withAnimations = (fn) => mutate(() => ({ ...fn(), animations: host.getConfig() }))
	return {
		list: get, get, play, inspect: inspectFrames, reinspect: inspectFrames, importFrames, runImportFrames,
		clearSelection: () => { selection = null; return { ok: true } },
		updateConfig: (patch = {}) => mutate(() => host.applyCreatorActionMutation(patch)),
		update: (actionId, patch = {}) => mutate(() => {
			const normalized = id(actionId)
			const current = readJson(configPath)
			if (!current.actions.some((item) => item.id === normalized)) throw new ApiError("NOT_FOUND", `Action not found: ${normalized}`)
			const next = { ...current, actions: current.actions.map((item) => item.id === normalized ? { ...item, ...patch, id: normalized } : item) }
			fs.mkdirSync(path.dirname(configPath), { recursive: true })
			fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
			return next
		}),
		remove: async (actionId) => { try { const result = await importer.deleteAction(id(actionId)); publish(); return clone({ animations: result?.animations ?? host.getConfig(), ...result }) } catch (error) { throw translate(error) } },
		previewProposal: (input) => host.previewTriggerProposal(input),
		submitProposal: (input) => withAnimations(() => host.submitTriggerProposal(input)),
		acceptProposal: (proposalId) => withAnimations(() => host.acceptTriggerProposalItem(id(proposalId, "Proposal id"))),
		rejectProposal: (proposalId, reason) => withAnimations(() => host.rejectTriggerProposalItem(id(proposalId, "Proposal id"), reason)),
		updateRule: (ruleId, patch) => withAnimations(() => host.updateTriggerRule(id(ruleId, "Rule id"), patch)),
		deleteRule: (ruleId) => withAnimations(() => host.deleteTriggerRule(id(ruleId, "Rule id"))),
	}
}
