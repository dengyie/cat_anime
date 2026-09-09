import { z } from "zod"

import { ERROR_CODES } from "./envelope.js"

/**
 * 反向通道契约(Backend <-> Shell)—— 见 docs/refactor/03-api-contract.md §7 与 ADR-011。
 *
 * 不过 HTTP,走 child_process.fork 的消息通道:不占端口、本机其他进程不可达、无需二次鉴权。
 * 所有消息统一套一层带版本号的信封 —— 升级或崩溃重拉会产生新旧进程配对,
 * HTTP 侧有 /api/v1 兜底,这条通道原本什么都没有。
 */

export const BRIDGE_PROTOCOL_VERSION = 1

/** sidecar 收到未知 v 时主动退出的码 */
export const EXIT_CODE_VERSION_MISMATCH = 78

/** 版本不符时 Shell 杀掉并重拉的次数上限,超过则进降级模式 */
export const MAX_VERSION_MISMATCH_RELAUNCHES = 2

/** dialog.result 超过 60s 未回则丢弃并向调用方返 504 */
export const DIALOG_RESULT_TIMEOUT_MS = 60_000

/** sidecar 必须在 10s 内发出 ready,否则 Shell 判定启动失败 */
export const SIDECAR_READY_TIMEOUT_MS = 10_000

export const envelopeSchema = <T extends z.ZodTypeAny>(body: T) =>
  z.object({
    v: z.literal(BRIDGE_PROTOCOL_VERSION),
    id: z.string().min(1),
    at: z.number().int().positive(),
    body,
  })

export type Envelope<T> = { v: 1; id: string; at: number; body: T }

export const catalogRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("listCatalog") }).strict(),
  z.object({ operation: z.literal("prepareInstall"), kind: z.enum(["plugin", "pet-pack"]), itemId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("installSelection"), selectionId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("clearSelection"), selectionId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("addBlocklistEntry"), type: z.enum(["pluginId", "packId", "sha256"]), value: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("removeBlocklistEntry"), type: z.enum(["pluginId", "packId", "sha256"]), value: z.string().min(1) }).strict(),
])
export type CatalogBridgeRequest = z.infer<typeof catalogRequestSchema>

export const PET_PACK_BRIDGE_OPERATIONS = [
  "list",
  "manifest",
  "validate",
  "clear-selection",
  "import",
  "export",
  "activate",
  "remove",
] as const
export type PetPackBridgeOperation = (typeof PET_PACK_BRIDGE_OPERATIONS)[number]

export const ACTIONS_BRIDGE_OPERATIONS = [
  "get", "inspect", "reinspect", "clear-selection", "import", "save-config",
  "preview-proposal", "submit-proposal", "accept-proposal", "reject-proposal",
  "update-rule", "delete-rule", "remove",
] as const
export type ActionsBridgeOperation = (typeof ACTIONS_BRIDGE_OPERATIONS)[number]

export const backendToShellSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("actions.request"),
    operation: z.enum(ACTIONS_BRIDGE_OPERATIONS),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    type: z.literal("pet.command.request"),
    operation: z.enum(["say", "playAction", "setEvent"]),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({ type: z.literal("pet.say"), text: z.string(), durationMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("pet.playAction"), actionId: z.string(), loop: z.boolean().optional() }),
  z.object({ type: z.literal("pet.event"), name: z.string(), payload: z.unknown().optional() }),
  z.object({ type: z.literal("window.openPluginDashboard"), pluginId: z.string() }).strict(),
  z.object({ type: z.literal("notify"), level: z.enum(["info", "warn", "error"]), message: z.string() }),
  z.object({ type: z.literal("tray.setBadge"), count: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("ready"),
    port: z.number().int().positive(),
    /** 字符串 "v1",不是数字。07 篇 spike 里的数字 1 只是一次性探针。 */
    apiVersion: z.literal("v1"),
    pid: z.number().int().positive(),
  }),
  z.object({ type: z.literal("degraded"), reason: z.string() }),
  z.object({ type: z.literal("dialog.request"), requestId: z.string(), mode: z.enum(["file", "directory"]) }),
  z.object({ type: z.literal("settings.changed"), paths: z.array(z.string()), version: z.number().int().nonnegative() }),
  z.object({ type: z.literal("settings.apply.request"), paths: z.array(z.string()), version: z.number().int().nonnegative(), values: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("settings.persist.result"), version: z.number().int().nonnegative(), ok: z.boolean(), changedPaths: z.array(z.string()), error: z.string().optional(), errorCode: z.string().optional() }),
  z.object({ type: z.literal("secrets.persist.request"), providerId: z.string().min(1), value: z.string().min(1).nullable() }).strict(),
  z.object({ type: z.literal("catalog.request"), request: catalogRequestSchema }).strict(),
  z.object({
    type: z.literal("pet-packs.request"),
    operation: z.enum(PET_PACK_BRIDGE_OPERATIONS),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({ type: z.literal("ai.state"), snapshot: z.record(z.string(), z.unknown()) }).strict(),
  z.object({
    type: z.literal("ai.host.request"),
    operation: z.enum(["context", "present"]),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
])
export type BackendToShell = z.infer<typeof backendToShellSchema>
export const actionsRequestSchema = backendToShellSchema.options[0]

export const shellToBackendSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("actions.result"),
    operation: z.enum(ACTIONS_BRIDGE_OPERATIONS),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string().min(1) }).strict().optional(),
  }).strict(),
  z.object({
    type: z.literal("init"),
    userDataPath: z.string(),
    sessionToken: z.string().min(32),
    logLevel: z.enum(["error", "warn", "info", "debug"]),
    appInfo: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      packaged: z.boolean(),
      platform: z.string().min(1),
      arch: z.string().min(1),
    }).strict().optional(),
    /**
     * ADR-010:启动时唯一的密钥注入入口。
     * Shell 侧 safeStorage.decrypt() 后一次性注入,后端只留在内存,不落盘。
     * 运行期写入仅允许反向走 secrets.persist.request 交还 Shell 加密落盘。
     */
    providerKeys: z.record(z.string(), z.string()).optional(),
    localHttpConfig: z.object({
      enabled: z.boolean(),
      host: z.string(),
      port: z.number().int().nonnegative().max(65535),
    }).strict().optional(),
  }),
  z.object({ type: z.literal("shutdown"), graceMs: z.number().int().nonnegative() }),
  z.object({ type: z.literal("pet.stateSnapshot"), state: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("dialog.result"), requestId: z.string(), paths: z.array(z.string()).nullable() }),
  z.object({ type: z.literal("power.suspend") }),
  z.object({ type: z.literal("power.resume") }),
  z.object({ type: z.literal("settings.apply.result"), version: z.number().int().nonnegative(), ok: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("settings.persist.request"), ifVersion: z.number().int().nonnegative(), patch: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("secrets.persist.result"), providerId: z.string().min(1), ok: z.boolean(), error: z.string().optional() }).strict(),
  z.object({ type: z.literal("catalog.result"), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }).strict(),
  z.object({
    type: z.literal("pet-packs.result"),
    operation: z.enum(PET_PACK_BRIDGE_OPERATIONS),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string().min(1),
    }).strict().optional(),
  }).strict(),
  z.object({
    type: z.literal("pet.pack-activated"),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({ type: z.literal("pet.command.result"), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }).strict(),
  z.object({ type: z.literal("ai.host.result"), operation: z.enum(["context", "present"]), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }).strict(),
])
export type ShellToBackend = z.infer<typeof shellToBackendSchema>

export const backendToShellEnvelopeSchema = envelopeSchema(backendToShellSchema)
export const shellToBackendEnvelopeSchema = envelopeSchema(shellToBackendSchema)

/**
 * 版本闸门。返回 "ok" | "version-mismatch" | "malformed"。
 * 调用方据此决定:正常处理 / 杀并重拉 / 丢弃并记 warn。
 */
export function inspectEnvelope(raw: unknown): "ok" | "version-mismatch" | "malformed" {
  if (typeof raw !== "object" || raw === null) return "malformed"
  const v = (raw as { v?: unknown }).v
  if (typeof v !== "number") return "malformed"
  return v === BRIDGE_PROTOCOL_VERSION ? "ok" : "version-mismatch"
}
