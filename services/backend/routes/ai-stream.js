import { randomUUID } from "node:crypto"
import { ApiError } from "../http/middleware.js"

export async function streamAiChat(ctx, { ai, present }) {
  const input = ctx.body
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("VALIDATION_FAILED", "Chat input is required")
  if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 4000) throw new ApiError("VALIDATION_FAILED", "message must contain 1 to 4000 characters")
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[\w:.-]{1,120}$/.test(input.requestId))) throw new ApiError("VALIDATION_FAILED", "Invalid requestId")
  if (!ctx.req.headers.accept?.includes("text/event-stream")) throw new ApiError("VALIDATION_FAILED", "Chat requires Accept: text/event-stream")
  const requestId = input.requestId || randomUUID()
  const controller = new AbortController()
  const abort = () => controller.abort()
  ctx.res.once("close", abort)
  ctx.hijacked = true
  ctx.res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" })
  ctx.res.flushHeaders?.()
  const send = (event, payload) => {
    if (ctx.res.destroyed || ctx.res.writableEnded) return
    // Slow clients cannot accumulate unbounded provider output in the socket.
    if (ctx.res.writableLength > 256 * 1024) { controller.abort(); return }
    ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const heartbeat = setInterval(() => {
    if (!ctx.res.destroyed) ctx.res.write(": ping\n\n")
  }, 15_000)
  heartbeat.unref?.()
  try {
    const result = await ai.chat({ message: input.message, messageBatch: input.messageBatch, entrypoint: input.entrypoint || "control-center", requestId }, {
      signal: controller.signal,
      onState: (state) => send("ai.chat-delta", state),
    })
    const output = input.present !== false && !result.canceled && !controller.signal.aborted && present
      ? await present(result, { source: "control-center", requestId })
      : result
    send("ai.chat-done", { ok: true, data: output, requestId })
  } catch (error) {
    send("ai.chat-done", { ok: false, requestId, error: { code: error?.code === "CONFLICT" ? "CONFLICT" : "INTERNAL", message: "AI request failed" } })
  } finally {
    clearInterval(heartbeat)
    ctx.res.removeListener("close", abort)
    ctx.res.end()
  }
}
