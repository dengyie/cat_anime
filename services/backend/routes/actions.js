import { sendSuccess } from "../http/middleware.js"

export const ACTION_ROUTES = Object.freeze([
	"GET /actions",
	"POST /actions/frames/inspect",
	"POST /actions/frames/reinspect",
	"POST /actions/frames/import",
	"DELETE /actions/frames/selection",
	"PUT /actions/config",
	"DELETE /actions/:id",
	"POST /actions/triggers/preview",
	"POST /actions/triggers/proposals",
	"POST /actions/triggers/proposals/:id/accept",
	"POST /actions/triggers/proposals/:id/reject",
	"PATCH /actions/triggers/rules/:id",
	"DELETE /actions/triggers/rules/:id",
])

export function registerActionRoutes(router, { actions } = {}) {
	if (!actions) throw new TypeError("action service required")
	router.get("/actions", async (ctx) => sendSuccess(ctx, await actions.list()))
	router.post("/actions/frames/inspect", async (ctx) => sendSuccess(ctx, await actions.inspect(ctx.body ?? {})))
	router.post("/actions/frames/reinspect", async (ctx) => sendSuccess(ctx, await actions.reinspect(ctx.body ?? {})))
	router.post("/actions/frames/import", async (ctx) => sendSuccess(ctx, await actions.importFrames(ctx.body ?? {}), 202))
	router.delete("/actions/frames/selection", async (ctx) => sendSuccess(ctx, await actions.clearSelection({ selectionId: ctx.query.selectionId })))
	router.put("/actions/config", async (ctx) => sendSuccess(ctx, await actions.updateConfig(ctx.body ?? {})))
	router.delete("/actions/:id", async (ctx) => sendSuccess(ctx, await actions.remove(ctx.params.id)))
	router.post("/actions/triggers/preview", async (ctx) => sendSuccess(ctx, await actions.previewProposal(ctx.body ?? {})))
	router.post("/actions/triggers/proposals", async (ctx) => sendSuccess(ctx, await actions.submitProposal(ctx.body ?? {})))
	router.post("/actions/triggers/proposals/:id/accept", async (ctx) => sendSuccess(ctx, await actions.acceptProposal(ctx.params.id)))
	router.post("/actions/triggers/proposals/:id/reject", async (ctx) => sendSuccess(ctx, await actions.rejectProposal(ctx.params.id, ctx.body?.reason)))
	router.patch("/actions/triggers/rules/:id", async (ctx) => sendSuccess(ctx, await actions.updateRule(ctx.params.id, ctx.body ?? {})))
	router.delete("/actions/triggers/rules/:id", async (ctx) => sendSuccess(ctx, await actions.deleteRule(ctx.params.id)))
}
