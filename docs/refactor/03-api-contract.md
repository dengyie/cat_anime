# 03 · API 契约与通信协议

> 🔌 本篇是前后端并行开发的唯一依据。契约未定稿前不得开始写业务代码。当前 99 个 IPC 通道的去向已在本篇逐域定义。

## 1. 协议基础

| 项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:<随机端口>/api/v1` |
| 传输 | HTTP/1.1 keep-alive(不用 HTTPS,loopback 内) |
| 内容类型 | `application/json; charset=utf-8` |
| 鉴权 | `Authorization: Bearer <sessionToken>`(全部端点强制) |
| 推送 | SSE,`GET /api/v1/events` |
| 反向调用 | Node `child_process` fork 消息通道(不过 HTTP) |
| 版本策略 | 路径内嵌 `v1`;破坏性变更 → `v2` 并行一个大版本 |
| 幂等 | 所有写操作支持可选 `Idempotency-Key` 头 |

### 1.1 请求头约定

| 头 | 必选 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer <sessionToken>` |
| `Content-Type` | 写操作时是 | `application/json` |
| `X-Request-Id` | 否 | 前端可传,不传则后端生成 |
| `Idempotency-Key` | 否 | 对安装/导入/生成类强烈建议传 |
| `X-Client` | 否 | `control-center` / `pet-window` / `mcp` |

### 1.2 端口发现与就绪门禁

后端用 `listen(0)` 由系统分配端口,因此 **Base URL 在后端启动完成前根本不存在**。前端必须走下面的门禁,不得假设端口已知:

1. Shell fork sidecar,sidecar 绑定端口成功后发 `ready` 消息(含 `port`、`apiVersion`、`pid`)。
2. Shell 收到 `ready` 后,才把 `port` 与 `sessionToken` 注入渲染进程(`openpetShell.getBackend()`)。
3. 渲染进程首帧时 `getBackend()` 返回 `null`,这是**正常初始态,不是错误**。
4. api client 在 `null` 状态下把请求排队(上限 50 条 / 10 秒),收到 `onBackendChanged` 后统一冲刷。
5. 超过 10 秒仍未就绪 → 进入降级 UI,停止排队并丢弃队列。

> ⚠️ **这是每次冷启动都会发生的竞态,不是低概率风险。** Control Center 窗口的渲染速度快于 sidecar 的端口绑定,若前端直接发请求必然拿到空端口。排队 + 门禁是强制要求,不是优化项。

## 2. 统一响应包装

### 2.1 成功

```json
{
  "ok": true,
  "data": { },
  "meta": { "requestId": "r_01H...", "elapsedMs": 42 }
}
```

列表类响应:

```json
{
  "ok": true,
  "data": { "items": [], "total": 128, "cursor": "eyJvZmZzZXQiOjUwfQ" },
  "meta": { "requestId": "r_01H..." }
}
```

### 2.2 失败

```json
{
  "ok": false,
  "error": {
    "code": "PLUGIN_MANIFEST_INVALID",
    "message": "插件清单缺少 permissions 字段",
    "details": { "field": "permissions", "pluginId": "im-gateway" },
    "retryable": false,
    "requestId": "r_01H..."
  }
}
```

> ⚠️ `message` 是面向用户的中文文案,前端可直接展示;`code` 是稳定枚举,前端用于分支判断。**前端不得靠 `message` 字符串匹配做逻辑。**

### 2.3 HTTP 状态码与错误码表

| HTTP | code | 含义 | 可重试 |
| --- | --- | --- | --- |
| 400 | `VALIDATION_FAILED` | 入参校验失败 | 否 |
| 401 | `UNAUTHORIZED` | token 缺失/错误 | 否 |
| 403 | `PERMISSION_DENIED` | 插件权限/未授权原生执行 | 否 |
| 404 | `NOT_FOUND` | 资源不存在 | 否 |
| 409 | `CONFLICT` | 并发写冲突、重复安装 | 是(重拉后) |
| 413 | `PAYLOAD_TOO_LARGE` | 超 1 MB | 否 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 非 JSON | 否 |
| 423 | `LOCKED` | 资源被长任务占用 | 是 |
| 429 | `RATE_LIMITED` | 限流(带 `Retry-After`) | 是 |
| 500 | `INTERNAL` | 未预期异常 | 是 |
| 502 | `PROVIDER_ERROR` | 上游 provider 报错 | 是 |
| 503 | `BACKEND_UNAVAILABLE` | 后端启动中/关闭中 | 是 |
| 504 | `PROVIDER_TIMEOUT` | provider 超时 | 是 |

**专用业务码**(搭配 400/409/423):`PLUGIN_MANIFEST_INVALID`、`PLUGIN_ALREADY_RUNNING`、`PLUGIN_NATIVE_NOT_APPROVED`、`PET_PACK_INCOMPATIBLE`、`ACTION_FRAMES_MISSING`、`AI_KEY_NOT_CONFIGURED`、`JOB_NOT_CANCELABLE`、`MIGRATION_REQUIRED`。

## 3. 99 个通道的去向总表

| 域 | 通道数 | 留 IPC | 迁 HTTP | 备注 |
| --- | --- | --- | --- | --- |
| `PET_*` 运行时 | 16 | 16 | 0 | 全部窗口/几何能力 |
| `PET_CHAT_*` | 8 | 8 | 0 | 窗口控制,内部转发后端 |
| `PET_BUBBLE_CHAT_*` | 11 | 11 | 0 | 窗口控制 |
| `SETTINGS_*` | 5 | 2 | 3 | `OPEN`/`CLOSE` 留(开窗); `GET`/`SAVE` 已在 T41 退役 |
| `ACTIONS_*` | 1 | 1 | 0 | 仅 `INSPECT_FRAMES` 保留原生弹框；12 个业务通道退休，Control Center 通过 Backend HTTP |
| `PET_PACKS_*` | 1 | 1 | 0 | 仅 `INSPECT_DIRECTORY` 保留原生弹框；其余 8 个通道已在 T42 同一提交退休 |
| AI 总域 | 8 | 0 | 8 | 29 个对话、配置、记忆与行为通道已在 T47 退役；剩余图像和 Creator 操作随 T48 收口 |
| `PLUGINS_*` | 29 | 6 | 23 | `OPEN_DASHBOARD`、`INSPECT_PACKAGE`、QQ/WeCom 凭据保存/清除留 |
| `CREATOR_*` | 13 | 0 | 13 | 多数转 Job |
| `SERVICE_*` | 7 | 0 | 7 | 全迁 |
| `ABOUT_*` | 0 | 0 | 0 | `about:get-info` / `about:check-updates` 已在 T42 退休；能力改由 Backend HTTP/Job 提供 |
| `CATALOG_*` | 0 | 0 | 0 | 6 个 Catalog 通道已在 T42 同一提交中退休；HTTP 路由仍由 Backend 提供 |
| **合计** | **99** | **45** | **54** | |

> **实现登记（T47 AI）**：本表只统计当前 IPC 通道。AI 对话通过 HTTP/SSE 进入后端，历史由 SQLite 保存；孵化配置和密钥也由后端统一写入。Actions 的 12 个业务通道已由 `/actions*` HTTP 路由承接。`check:api-contract` 以 `src/shared/ipc-channels.ts` 为清单逐项复算：**99 = 45 留 IPC + 54 迁 HTTP**。

## 4. 路由表

### 4.1 健康与服务

| 方法 | 路径 | 源 IPC | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | — | 未鉴权返 `401`(无例外,见 [02 篇 §6.2](./02-architecture.md));鉴权后返版本与运行时长 |
| GET | `/service/status` | `SERVICE_GET_STATUS` | 含端口、enabled、内存、活跃 Job 数 |
| POST | `/service/enable` | `SERVICE_SET_ENABLED` | 开关对外 MCP/HTTP |
| POST | `/service/token/rotate` | `SERVICE_ROTATE_TOKEN` | 仅轮换 MCP token |
| GET | `/service/logs` | `SERVICE_GET_LOGS` | 分页,从 SQLite 读 |
| DELETE | `/service/logs` | `SERVICE_CLEAR_LOGS` | 清空 |
| GET | `/service/config` | `SERVICE_GET_CONFIG` | 不返回 token 明文 |
| PUT | `/service/config` | `SERVICE_SAVE_CONFIG` | 更新服务配置,不接受 token 明文 |
| POST | `/service/diagnostics` | 新增 | 导出诊断包 |
| GET | `/about` | `ABOUT_GET_INFO` | 版本信息 |
| POST | `/about/check-updates` | `ABOUT_CHECK_UPDATES` | 返 Job(可能联网) |

> 实现登记：服务路由由 `services/backend/routes/service.js` 注册，服务管理器为 `services/backend/domains/local-http.js`；本映射不新增 `SERVICE_*` 通道或另一份路由定义。

### 4.2 设置

| 方法 | 路径 | 源 IPC | 说明 |
| --- | --- | --- | --- |
| GET | `/settings` | — | 全量读,已脱敏 |
| PATCH | `/settings` | — | **改为部分更新**,带 `ifVersion` 乐观锁 |
| POST | `/settings/cursor/import` | `SETTINGS_IMPORT_CURSOR` | 传路径(弹框在 Shell) |
| POST | `/settings/preview-scale` | `SETTINGS_PREVIEW_SCALE` | 预览 |
| GET | `/settings/schema` | 新增 | 前端动态渲染用 |

> 🔑 **关键变更:`SETTINGS_SAVE` 不得直译为 `PUT /settings`。** 现状是全量读-改-写,在多进程下会丢写。必须改为 `PATCH` + 版本号乐观锁,冲突返 `409 CONFLICT`。

### 4.3 宠物(仅读 + 反向驱动)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/pet/state` | 宠物当前状态快照(后端从 Shell 缓存) |
| POST | `/pet/say` | 后端代理 → 反向通道 → PetService |
| POST | `/pet/action` | 同上 |
| POST | `/pet/event` | 同上,供插件与 MCP 使用 |

### 4.4 动作

> **T42 Actions 实现登记**：Actions HTTP 域通过 `actions.request` / `actions.result` 调用 Shell 注入的 `ActionService`、`ActionImportService` 和活动 `PetService`，保留配置、提案、规则与运行诊断。原生目录选择返回 opaque `selectionId`；renderer 不构造路径或句柄。导入请求携带 `{ selectionId, actionId, label? }`，以 202 返回 `{ jobId }`；只有 runner 进入 `finalizing` 后才派发 Shell 写入。Job 终态包含原 `ActionFrameImportResult`，界面在成功终态更新动作列表，失败时保留选区；`pet.actions-changed` SSE 刷新活动视图。选区绑定创建时的 Pet Pack，切包后导入返回冲突。

| 方法 | 路径 | 源 IPC |
| --- | --- | --- |
| GET | `/actions` | `ACTIONS_GET` |
| POST | `/actions/frames/inspect` | `ACTIONS_INSPECT_FRAMES`(传路径)† |
| POST | `/actions/frames/reinspect` | `ACTIONS_REINSPECT_FRAMES` |
| POST | `/actions/frames/import` | `ACTIONS_IMPORT_FRAMES` → **Job** |
| DELETE | `/actions/frames/selection` | `ACTIONS_CLEAR_FRAME_SELECTION` |
| PUT | `/actions/config` | `ACTIONS_SAVE_CONFIG` |
| DELETE | `/actions/{id}` | `ACTIONS_DELETE` |
| POST | `/actions/triggers/preview` | `ACTIONS_PREVIEW_TRIGGER_PROPOSAL` |
| POST | `/actions/triggers/proposals` | `ACTIONS_SUBMIT_TRIGGER_PROPOSAL` |
| POST | `/actions/triggers/proposals/{id}/accept` | `ACTIONS_ACCEPT_TRIGGER_PROPOSAL` |
| POST | `/actions/triggers/proposals/{id}/reject` | `ACTIONS_REJECT_TRIGGER_PROPOSAL` |
| PATCH | `/actions/triggers/rules/{id}` | `ACTIONS_UPDATE_TRIGGER_RULE` |
| DELETE | `/actions/triggers/rules/{id}` | `ACTIONS_DELETE_TRIGGER_RULE` |

本表 13 行全部对应 HTTP；`POST /actions/frames/import` 返回 202 并通过 Jobs/SSE 提供实际执行状态。

### 4.5 宠物包

| 方法 | 路径 | 源 IPC |
| --- | --- | --- |
| GET | `/pet-packs` | `pet-packs:list`（T42 退休） |
| POST | `/pet-packs/import` | `pet-packs:import`（T42 退休）→ **Job** |
| POST | `/pet-packs/{id}/activate` | `pet-packs:set-active`（T42 退休） |
| DELETE | `/pet-packs/{id}` | `pet-packs:remove`（T42 退休） |
| POST | `/pet-packs/{id}/export` | `pet-packs:export`（T42 退休） → **Job** |
| GET | `/pet-packs/{id}/manifest` | `pet-packs:list`（T42 退休） |
| POST | `/pet-packs/validate` | `pet-packs:clear-selection`（T42 退休） |

本表 7 条路由；Pet Pack 的 9 个历史通道中仅 `pet-packs:inspect-directory` 留在 IPC，其余 8 个已在 T42 同一提交退休。`pet-packs:active-changed` 与 `control-center:active-pet-pack-changed` 是事件通道，迁移后由 SSE `pet.pack-activated` 承担。

### 4.6 AI

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ai/config` | 不含密钥明文 |
| GET | `/ai/state` | 当前宠物的只读配置、人设和会话快照 |
| PATCH | `/ai/config` | 部分更新 |
| PUT | `/ai/providers/{id}/key` | **只写**,返 `{ configured, maskedTail }` |
| DELETE | `/ai/providers/{id}/key` | 清除 |
| POST | `/ai/providers/{id}/test` | 连接测试,15s 超时 |
| GET | `/ai/providers/{id}/models` | 模型目录 |
| GET · PUT | `/ai/persona` | 人设 |
| POST | `/ai/persona/draft` | 生成人设草稿 |
| GET · POST · DELETE | `/ai/memories` · `/{id}` | 记忆 |
| DELETE | `/ai/memories` | 清空当前宠物记忆 |
| POST | `/ai/chat` | **SSE 流式**(`Accept: text/event-stream`) |
| POST | `/ai/chat/{id}/cancel` | 取消活动或排队的对话请求 |
| GET · DELETE | `/ai/conversations` · `/{id}` | 对话 |
| GET | `/ai/conversations/{id}` | 指定会话消息 |
| POST | `/ai/talk/start` · `/ai/talk/stop` | 主动搭话 |
| GET · POST | `/ai/behavior/rules` | 行为规则列表与创建 |
| PATCH · DELETE | `/ai/behavior/rules/{id}` | 行为规则更新与删除 |
| GET · PATCH | `/ai/behavior` | 行为配置 |
| POST | `/ai/behavior/dry-run` | 干跑 |
| POST | `/ai/behavior/evaluate` | 行为决策 |
| POST | `/ai/behavior/replay` | 决策重放 |
| POST | `/ai/behavior/diagnostics` | 导出行为诊断 |
| DELETE | `/ai/behavior/decisions` | 清空行为决策 |
| GET · POST | `/ai/traces` · `/ai/traces/export` | 诊断 |
| POST | `/ai/traces/diagnostics` | 导出筛选后的 AI 诊断 |
| POST | `/ai/utterances` | 记录 PetService 已呈现的话语 |
| POST | `/ai/entrypoints/chat` | 插件等入口的对话 |
| POST | `/ai/completions` | 后端按能力解析配置；拒绝调用方 configOverride、密钥引用与 signal 字段 |
| GET · PATCH | `/ai/hatch/config` | 孵化设置与有效模型；固定 ai.hatch-pet 密钥引用 |
| GET · POST | `/ai/hatch/agents` · `/ai/hatch/start` | 孵化 → **Job** |
| GET | `/ai/hatch/budget` | 预算账本 |
| POST | `/ai/images/generate` | → **Job**(265s) |
| GET | `/ai/images/health` | provider 健康 |
| GET | `/ai/images/models` | 图像模型目录 |

### 4.7 插件

| 方法 | 路径 | 源 IPC | Job |
| --- | --- | --- | --- |
| GET | `/plugins` | `PLUGINS_GET_LIST` | |
| GET | `/plugins/{id}` | `PLUGINS_GET_DETAIL` | |
| POST | `/plugins/install` | `PLUGINS_INSTALL`(传路径) | ✅ |
| POST | `/plugins/install/github` | `PLUGINS_IMPORT_GITHUB` | ✅ |
| DELETE | `/plugins/{id}` | `PLUGINS_UNINSTALL` | |
| POST | `/plugins/{id}/enable` | `PLUGINS_SET_ENABLED` | |
| POST | `/plugins/{id}/start` | `PLUGINS_START_SERVICE` | |
| POST | `/plugins/{id}/stop` | `PLUGINS_STOP_SERVICE` | |
| POST | `/plugins/{id}/restart` | `PLUGINS_RESTART_SERVICE` | |
| GET | `/plugins/{id}/status` | `PLUGINS_GET_RUNTIME_STATUS` | |
| GET | `/plugins/{id}/logs` | `PLUGINS_GET_LOGS` | |
| DELETE | `/plugins/{id}/logs` | `PLUGINS_CLEAR_LOGS` | |
| POST | `/plugins/{id}/commands/{cmd}` | `PLUGINS_RUN_COMMAND` | ✅ |
| GET · PUT | `/plugins/{id}/permissions` | `PLUGINS_*_PERMISSIONS` | |
| POST | `/plugins/{id}/native-approval` | `PLUGINS_SET_NATIVE_EXECUTION_APPROVED` | |
| POST | `/plugins/validate` | `PLUGINS_VALIDATE` | |
| POST | `/plugins/sync-bundled` | `PLUGINS_SYNC_BUNDLED` | ✅ |
| GET · PUT | `/plugins/{id}/config` | `PLUGINS_*_CONFIG` | |

**保留在 IPC**:`PLUGINS_OPEN_DASHBOARD`(需开 `BrowserWindow`)、`PLUGINS_INSPECT_PACKAGE`(需 `dialog.showOpenDialog`)、`PLUGINS_SAVE_IM_GATEWAY_QQ_CREDENTIALS`、`PLUGINS_CLEAR_IM_GATEWAY_QQ_CREDENTIALS`、`PLUGINS_SAVE_IM_GATEWAY_WECOM_CREDENTIALS`、`PLUGINS_CLEAR_IM_GATEWAY_WECOM_CREDENTIALS`(host-secret,不迁 HTTP)。

### 4.8 Creator Studio

| 方法 | 路径 | Job |
| --- | --- | --- |
| GET | `/creator/flows` | |
| POST · PATCH · DELETE | `/creator/flows` · `/{id}` | |
| POST | `/creator/characters/generate` | ✅ 265s |
| POST | `/creator/sprites/generate` | ✅ |
| POST | `/creator/sprites/evaluate` | ✅ |
| GET · POST · DELETE | `/creator/references` | |
| POST | `/creator/workflows/{id}/run` | ✅ |
| GET | `/creator/workflows/{id}/artifacts` | |
| POST | `/creator/export` | ✅ |

### 4.9 Catalog

| 方法 | 路径 | 源 IPC |
| --- | --- | --- |
| GET | `/catalog` | `catalog:get`（T42 退休） |
| POST | `/catalog/refresh` | Backend Catalog domain |
| GET | `/catalog/{id}` | Backend Catalog domain |
| POST | `/catalog/prepare` | `catalog:prepare-install`（T42 退休） |
| POST | `/catalog/install` | `catalog:install-selection`（T42 退休） → **Job** |
| POST | `/catalog/clear-selection` | `catalog:clear-selection`（T42 退休） |
| POST | `/catalog/blocklist` | `catalog:add-blocklist`（T42 退休） |
| DELETE | `/catalog/blocklist/{id}` | `catalog:remove-blocklist`（T42 退休） |
| GET | `/catalog/installed` | Backend Catalog domain |
| POST | `/catalog/source` | Backend Catalog domain |

### 4.10 Job

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/jobs` | 列表,可按 `status`、`kind` 过滤 |
| GET | `/jobs/{id}` | 详情 |
| POST | `/jobs/{id}/cancel` | 取消(不可取消返 `423`) |
| POST | `/jobs/{id}/retry` | 重试(仅 failed/interrupted) |
| GET | `/jobs/{id}/events` | 历史事件(补齐历史进度) |
| DELETE | `/jobs/completed` | 清理已完成 |

> 实现登记：Job 路由通过 `services/backend/routes/jobs.js` 接入，统一交给 `services/backend/jobs/dispatcher.js` 派发；Job kind/status 仍以 §6 与契约包为唯一来源。

### 4.11 当前实现注册表（T39）

`services/backend/routes/registry.js` 是当前已实现 REST 路由的可执行登记表；它与各 `register*Routes` 的运行时注册结果均为 **74 条**。`check:api-contract` 会展开 §4.1–§4.10 的紧凑方法/路径单元格，并按规范化参数路径逐条比较这 74 条，而不是只比较总数。§4 的其余目标路由仍保留在契约表中，待对应域实现后加入登记表。

SSE 不属于上述 REST 登记子集，但仍是 API 路由的一部分：

| 方法 | 路径 | 实现 | 说明 |
| --- | --- | --- | --- |
| GET | `/events` | `services/backend/routes/events.js` + `services/backend/events/hub.js` | SSE 订阅；事件名、topic 与 §5 目录逐项对账 |

`GET /api/v1/events` 不计入 §4.1–§4.10 的 74 条 REST registry 对账，也不计入 §3 IPC 通道数。

## 5. SSE 事件规范

```text
GET /api/v1/events?topics=pet,jobs,plugins,ai,logs
Authorization: Bearer <sessionToken>
Accept: text/event-stream
```

`topics` 的全量可选值共 8 个:`pet`、`jobs`、`plugins`、`ai`、`logs`、`settings`、`catalog`、`system`。上面只是典型订阅示例。

> ⚠️ **`system` 无论是否出现在 `topics` 里都会下发。** 降级、关闭、事件丢弃、Job 恢复这四类通知直接影响前端能不能信任自己的缓存,不能因为前端忘了订阅就静默丢弃。后端对 `system` 不做订阅过滤。

帧格式(带 `id` 以支持 `Last-Event-ID` 断点重连):

```text
id: 10241
event: job.progress
data: {"jobId":"job_01H...","kind":"image.generate","phase":"rendering","percent":62,"message":"第 3/5 帧"}

```

### 事件目录

| topic | event | 负载要点 |
| --- | --- | --- |
| `jobs` | `job.created` · `job.progress` · `job.succeeded` · `job.failed` · `job.canceled` | `jobId`、`kind`、`phase`、`percent` |
| `plugins` | `plugin.installed` · `plugin.removed` · `plugin.status-changed` · `plugin.log` | `pluginId`、`status` |
| `ai` | `ai.chat-delta` · `ai.chat-done` · `ai.talk-utterance` | `conversationId`、`delta` |
| `pet` | `pet.pack-activated` · `pet.actions-changed` | 前端据此失效缓存 |
| `settings` | `settings.changed` | `paths: string[]`(只告知变更路径) |
| `catalog` | `catalog.refreshed` | |
| `logs` | `log.appended` | 默认不订阅,仅日志面板开启 |
| `system` | `backend.shutting-down` · `backend.degraded` | 前端切降级 UI |
| `system` | `system.jobs-recovered` | `{ interrupted: string[], requeued: string[] }` —— 后端重启后的 Job 恢复结果(见 [04 篇 §2.6](./04-subsystems.md))。前端收到后必须失效任务列表缓存,并对 `interrupted` 里的项提示可重试 |
| `system` | `system.events-dropped` | `{ topic: string, dropped: number, since: string }` —— 背压丢帧通告(见下方背压规则)。**前端收到即视为本地缓存不再可信**,需全量重拉受影响 topic 的数据 |

> 📌 上表的 event 名是契约的一部分,`packages/contracts` 里必须有一份与之逐字对应的枚举,并由 `check:api-contract` 校验「后端实际发出的事件名 = 枚举 = 本表」三方一致。本表曾漏登 `system.jobs-recovered` 与 `system.events-dropped` 两项,就是因为它们只写在子系统篇里而没回归到契约。

**心跳**:每 15s 发 `: ping` 注释行。前端 45s 无帧则重连。

**背压**:单连接缓冲上限 1000 帧,超限丢弃最旧 `log.appended` 并发一条 `system.events-dropped`。

## 6. Job 契约

### 6.1 创建响应

所有长任务统一返 `202 Accepted`:

```json
{
  "ok": true,
  "data": {
    "jobId": "job_01HQ8Z...",
    "kind": "image.generate",
    "status": "queued",
    "createdAt": "2026-08-09T06:05:00.000Z",
    "estimatedMs": 265000,
    "pollUrl": "/api/v1/jobs/job_01HQ8Z..."
  }
}
```

### 6.2 Job 对象

```json
{
  "jobId": "job_01HQ8Z...",
  "kind": "image.generate",
  "status": "running",
  "progress": { "phase": "rendering", "percent": 62, "message": "第 3/5 帧" },
  "cancelable": true,
  "attempt": 1,
  "maxAttempts": 2,
  "createdAt": "...", "startedAt": "...", "finishedAt": null,
  "result": null,
  "error": null,
  "input": { "redacted": true, "summary": "prompt: 橘猫站立…" }
}
```

`status` 枚举:`queued` · `running` · `succeeded` · `failed` · `canceled` · `interrupted`(进程重启遗留,见 [02 篇 §4.3](./02-architecture.md))。

### 6.3 kind 枚举(17 个)

`image.generate` · `sprite.generate` · `sprite.evaluate` · `creator.character` · `creator.workflow` · `creator.export` · `hatch.run` · `plugin.install` · `plugin.install.github` · `plugin.command` · `plugin.sync-bundled` · `pet-pack.import` · `pet-pack.export` · `actions.import-frames` · `catalog.install` · `about.check-updates` · `store.migrate`

## 7. 反向通道契约(Backend → Shell)

不过 HTTP,走 fork 消息。所有消息统一套一层带版本号的信封,消息类型严格白名单:

```ts
// 信封:升级或崩溃重拉会产生新旧进程配对,必须靠版本号拦住
type Envelope<T> = { v: 1; id: string; at: number; body: T }

type BackendToShell =
  | { type: "ai.state"; snapshot: Record<string, unknown> }
  | { type: "ai.host.request"; operation: "context" | "present"; payload: Record<string, unknown> }
  | { type: "actions.request"; operation: ActionsBridgeOperation; payload: Record<string, unknown> }
  | { type: "pet.say"; text: string; durationMs?: number }
  | { type: "pet.playAction"; actionId: string; loop?: boolean }
  | { type: "pet.event"; name: string; payload?: unknown }
  | { type: "window.openPluginDashboard"; pluginId: string; url: string }
  | { type: "notify"; level: "info"|"warn"|"error"; message: string }
  | { type: "tray.setBadge"; count: number }
  | { type: "ready"; port: number; apiVersion: "v1"; pid: number }
  | { type: "degraded"; reason: string }
  | { type: "settings.changed"; paths: string[]; version: number }
  | { type: "settings.apply.request"; paths: string[]; version: number; values?: Record<string, unknown> }
  | { type: "settings.persist.result"; version: number; ok: boolean; changedPaths: string[]; error?: string; errorCode?: string }

type ShellToBackend =
  | { type: "ai.host.result"; operation: "context" | "present"; ok: boolean; result?: unknown; error?: string }
  | { type: "actions.result"; operation: ActionsBridgeOperation; ok: boolean; result?: unknown; error?: { code: ErrorCode; message: string } }
  | { type: "init"; userDataPath: string; sessionToken: string; logLevel: string }
  | { type: "shutdown"; graceMs: number }
  | { type: "pet.stateSnapshot"; state: PetState }
  | { type: "dialog.result"; requestId: string; paths: string[] | null }
  | { type: "power.suspend" | "power.resume" }
  | { type: "settings.apply.result"; version: number; ok: boolean; error?: string }
  | { type: "settings.persist.request"; ifVersion: number; patch: Record<string, unknown> }
```

`ActionsBridgeOperation` 与 `ErrorCode` 引用 `@openpet/contracts` 的单一契约。Actions 回复必须匹配请求的 envelope id、消息类型和 operation；成功必须含 result，失败必须含结构化错误。未知操作和额外请求字段在进入 Shell 服务前拒绝。

AI 后端通过 `context` 获取活动宠物包，通过 `present` 请求 Shell 的 PetService 呈现回复。
已取消或属于其他宠物包的结果不会呈现；`ai.state` 只发送不含密钥值的配置、历史和人设快照。

`settings.persist.request` 是仅供 Shell 使用的进程内持久化边界，当前只允许
`petBehavior.home.anchor`。HTTP `PATCH /settings` 对该路径一律返回 `403`，不接受
可由 renderer 伪造的 `x-client` 头；Backend 以同 envelope id 回复
`settings.persist.result`，并在成功后发布 settled 的 `settings.changed`。

设置 PATCH 先由 Backend 写入 canonical envelope，再通过 `settings.apply.request`
等待 Shell 完成必要的 host effects；只有收到同一 envelope id 的成功
`settings.apply.result` 后，HTTP 才返回成功并发布 `settings.changed`。失败时 Backend
用版本锁补偿 canonical 写入并返回错误，避免 SSE 反映未 settled 的状态。普通
`GET /settings` 在 mutation settled 前不会读取 transient snapshot；`settings.apply.request`
只携带 host effect 所需的 canonical `values`，因此 Shell 不需要在 Backend 等待 host
apply 时回读 GET，避免请求环死锁。

**规则**:

1. 每条消息入口做 schema 校验;未知 `type` 丢弃并记 warn。
2. **`v` 与当前支持版本不符时,Shell 立即杀掉并重拉 sidecar,重拉不超过 2 次**,之后进降级模式;sidecar 收到未知 `v` 时主动退出(exit code 78 = 版本不兼容)。这是升级期唯一可靠的兜底。
3. 不得在此通道传输大二进制负载(文件走路径)。**唯一允许传输敏感数据的是 `init` 消息中的 provider 密钥**,见 ADR-010 与 [04 篇 §4](./04-subsystems.md)。
4. `id` 用于把 `dialog.result` 与发起方配对,超过 60 秒未回则丢弃并返 `504`。
5. **`apiVersion` 是字符串 `"v1"`,不是数字。** [07 篇](./07-spike.md) 的 spike 验证代码里写的是 `apiVersion: 1`(数字),那只是测时序用的一次性脚本;转正式实现时以本篇为准。

## 8. 兼容与弃用策略

| 对象 | 策略 |
| --- | --- |
| 兼容端点 `POST /api/pet/say`、`/api/pet/action`、`/api/pet/event` | 原路径保留一个大版本,后端内部转发到 `/api/v1/pet/*`;新代码只允许用 v1 路径 |
| `GET /api/status` | 保留但**移除未鉴权信息披露**:未鉴权返 `401` |
| `POST /mcp` · `GET /mcp` | **端口与路径都不得变化**。MCP 仍在用户自选端口上对外监听(默认关闭),与前后端之间的 `/api/v1`(随机端口、仅回环)是两个互不相干的监听器。sidecar 内嵌 MCP 后必须继承原端口配置,否则现有客户端配置全部失效 |
| `x-openpet-token` · `x-ibot-token` | 保留,仅适用于兼容路径 |
| 旧 IPC 通道常量 | M1–M4 期间保留 shim,并在 dev 下 `console.warn`;M5 删除 |
| 弃用窗口 | 至少一个完整大版本(1.x → 2.0 才能删) |

## 9. 契约工程化

1. `packages/contracts/api/*.ts` 定义所有请求/响应类型(以 `openpet-contracts.ts` 96.6 KB 为基底)。
	- **旧文件的处置已定案(ADR-012)**:M0 把 `src/shared/openpet-contracts.ts` 原样搬到 `packages/contracts/legacy.ts`,原路径改为一行 `export * from "@openpet/contracts/legacy"` 的薄壳;M5 删除薄壳并批量改 import。**任何阶段都不允许两份可编辑的类型定义同时存在。**
	- `src/shared` 下的 JS/TS 双版本文件(`cursor-library`、`ipc-channels`)同批处理:TS 为唯一源,JS 由构建产出并加入 `.gitignore`。此项不做完,`check:api-contract` 会因为读到过期的 JS 常量而误报。
2. 用 `zod`(ADR-016 已定案,不再比选 TypeBox 或手写)同时产出:
	- 后端运行时入参校验中间件
	- 前端 TS 类型(`z.infer`)
	- MSW mock handler(取代 181 KB 的 demo api)
	- 本文档路由表(防文档漂移)
3. 新增 `npm run check:api-contract`:校验路由实现与契约完全一致(多余/缺失路由均报错),同时校验 §5 事件目录与后端实际发出的事件名一致,并比对 `ipc-channels.ts` 的通道盘点数。
4. 接入现有 `check:docs-drift`,使契约变更必须同步文档。

## 10. 性能预算

分离后每个操作多一跳回环 HTTP。**没有预算就没有「切完变慢了」的判据**,下列上限进入 M2 验收:

| 操作 | 现状(IPC) | 分离后 P95 上限 | 超标处理 |
| --- | --- | --- | --- |
| `GET /settings` | 约 2 ms | 30 ms | 加进程内 5 秒缓存,由 `settings.changed` 失效 |
| `GET /plugins`(20 个插件) | 约 15 ms | 80 ms | 运行状态字段拆到 `/plugins/status` 单独轮询 |
| `POST /pet/say`(含反向通道) | 约 3 ms | 50 ms | 降级为 Shell 直连 PetService |
| SSE 首帧延迟 | — | 200 ms | 连接建立即补发一帧状态快照 |
| 冷启动到前端可用 | 约 1.2 s | 2.0 s | sidecar 延迟启动,非 AI 面板先渲染 |
| Control Center 切 tab | 约 30 ms | 150 ms | 预取相邻 tab 数据 |

测量方式:统一响应里已有 `meta.elapsedMs`,M2 起在 `tests/backend/perf.test.js` 用 200 次采样断言 P95,纳入 CI 门禁。

> 📌 **E5 真机时序**:sidecar 首行单跑 `+569 ms`,共享 `OPENPET_T0` 时 `+779 ms`;这段固定开销计入上表 2.0 s 冷启动预算。完整实测见 [07 篇](./07-spike.md) §7 第 2 行。

> 📌 **契约冻结点**:本篇的路由表、错误码表与 §5 事件目录在 M1 结束前必须定稿并转为代码。之后的变更走 ADR 补充,不得直接改代码。
