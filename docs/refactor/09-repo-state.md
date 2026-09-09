# 09 · 仓库现状快照

> v1.8 · 2026-09-08 · T42 Actions 切换与 T44–T46 落地复核

**读者**:领到任务卡准备写代码的 agent。前置阅读 [08 篇 执行手册](./08-agent-guide.md)。

---

## 0. 怎么用这一篇

领卡之前在这里确认两件事:

1. 你要建的文件**是不是已经存在**;
2. 你要调的函数**签名长什么样**。

> **已存在的文件按现状用 —— 不要重写,不要改签名。** 它们是样板,后面所有模块照这个形状写。

如果你认为某个已有文件的设计不对:写进 §4 缺口清单并在 PR 里说明,**不要直接改**。已有文件的每一处形状都有理由,理由写在文件顶部的注释里,先读它。

---

## 1. 重构已经落地的部分

```plain text
apps/desktop/src/sidecar/               ✅ sidecar 生命周期与反向通道
  spawn.js  message-handler.js  orphan-cleanup.js  runtime-coordinator.js
packages/contracts/                    ✅ 契约唯一来源(ESM + zod)
  package.json  tsconfig.json  README.md
  src/index.ts  envelope.ts  jobs.ts  events.ts  bridge.ts  settings.ts
services/backend/                      ✅ sidecar backend 已接入业务
  package.json  README.md  index.js
  http/router.js  http/middleware.js
  bridge/message-schema.js  bridge/shell-client.js
  store/db.js  store/migrate.js  store/migrate-from-json.js
  store/migrations/001_init.sql  store/repositories/{jobs,logs}.js
  jobs/ (6 个顶层文件)  jobs/handlers/ (7 个文件)
  routes/ (12 组)  domains/ (8 组:6 个顶层文件 + plugins/ + ai/)
  secrets/provider-keys.js  mcp/{mcp-transport-service,local-http-service}.cjs
  events/hub.js
scripts/check-api-contract.mjs          ✅ M0 门禁
tests/backend/state-machine.test.js     ✅ 测试样板
```

根 `package.json` 已开启 workspaces(`apps/*`、`services/*`、`packages/*`),`check:node` 已覆盖 `apps` 与 `services`。backend 当前由 12 组 routes 文件装配 76 条实际 method/path；`routes/registry.js` 是硬对账注册表，不是第二套业务实现。

**当前 backend 已完成启动、迁移、Job 恢复/调度和 HTTP 业务路由注册。** 尚未归属仓储的三张表见缺口 G13。

---

## 2. 已存在文件的对外接口

### 2.1 `services/backend/http/middleware.js`

全局约定的落点。**改它等于改全局**,见 08 篇 §6。

常量:`GENERIC_ERROR_HTTP_STATUS`(13 个通用码 → HTTP 状态)、`RETRYABLE_ERROR_CODES`(5 个)、`MAX_BODY_BYTES = 1024 * 1024`、`DEFAULT_MAX_ACCESS_LOGS = 200`。

导出:`ApiError`、`elapsedMs`、`sendSuccess`、`sendList`、`sendError`、`requestId`、`errorBoundary`、`loopbackOnly`、`bearerAuth`、`jsonBody`、`createAccessLogBuffer`、`accessLog`。

```js
new ApiError(code, message, { status, details, retryable, cause })
// status 默认 GENERIC_ERROR_HTTP_STATUS[code] ?? 500
// retryable 默认 RETRYABLE_ERROR_CODES.has(code)

bearerAuth({ getSessionToken, legacyPathPrefixes, getLegacyToken })
jsonBody({ maxBytes })            // 超限中途即断,返 413
createAccessLogBuffer({ max })    // 环形缓冲,给 /service/logs 用
accessLog({ buffer, logger })
```

要点:token 比对是 sha256 后 `timingSafeEqual`,不要改成 `===`;`GET/HEAD/DELETE/OPTIONS` 不读 body;回包统一走 `sendSuccess`/`sendList`/`sendError`,不要自己 `res.end(JSON.stringify(...))`。

### 2.2 `services/backend/http/router.js`

```js
const router = createRouter({ basePath: "/api/v1" })
// → { use, register, get, post, put, patch, delete, absolute, routes, handle }
```

处理函数拿到的 `ctx`:

```js
{ req, res, method, rawPath, routePath, query, params, body,
  state, requestId, client, hijacked, startedAt }
```

要点:`HEAD` 自动走 `GET`;路径匹配但方法不对返 **404 `NOT_FOUND`**(没有 `METHOD_NOT_ALLOWED` 这个码);SSE 之类要接管响应流的,把 `ctx.hijacked` 置 true;`routes()` 返回已注册路由表,M1 的门禁硬化要用它对 03 篇 §4。

### 2.3 `services/backend/bridge/message-schema.js`

常量:`BRIDGE_PROTOCOL_VERSION = 1`、`EXIT_CODE_VERSION_MISMATCH = 78`、`MAX_VERSION_MISMATCH_RELAUNCHES = 2`、`DIALOG_RESULT_TIMEOUT_MS = 60_000`、`BACKEND_TO_SHELL_TYPES`、`SHELL_TO_BACKEND_TYPES`。

函数:`nextEnvelopeId()`(形如 `b<pid>-<seq>`)、`createEnvelope`、`parseEnvelope`。

`parseEnvelope` 的 6 种失败原因:`not-object` / `version-mismatch` / `bad-id` / `bad-at` / `bad-body` / `unknown-type`。**`version-mismatch` 必须走「退出 78 由 Shell 重拉」,不能当普通错误吞掉**(ADR-011)。

`BACKEND_TO_SHELL_TYPES` 与契约 `backendToShellSchema` 当前均为 17 项，包含 Settings、Secrets、Catalog、Pet Packs、Actions 与 PetService 请求；类型全集由 `@openpet/contracts` 派生;请求复用 envelope `id`,结果超时为 60 秒。缺口 G2 已关闭(证据见 §4)。

### 2.4 `services/backend/bridge/shell-client.js`

```js
const shell = createShellClient({ send, exit, logger })
// → { receive, send, request, waitFor, on, dispose }
```

`request` 的相关性靠**复用同一个 envelope `id`**,没有 `replyTo` 字段。`waitFor("init")` 必须在开始排空 inbox **之前**注册,否则丢首帧 —— `index.js` 里已经是正确顺序,照抄。

### 2.5 `services/backend/store/db.js`

```js
const db = await openDatabase({ file, pragmas, logger })
// → { driverName: "node:sqlite", file, exec, prepare, transaction, pragma, close }
// prepare(sql) → { get, all, run }
```

`DEFAULT_PRAGMAS`:`journal_mode = WAL`、`synchronous = NORMAL`、`foreign_keys = ON`、`busy_timeout = 5000`。

要点:内部用 `await import("node:sqlite")`,拿不到就抛 `NODE_SQLITE_UNAVAILABLE`;Electron 42.4.0 / Node 24.16.0 无需 flag,`tests/backend/sqlite-driver.test.js` 已用 file-backed DB 验证 `journal_mode='wal'`、四项默认 pragma 与跨连接持久化(缺口 G11 已关闭)。模块级 `openFiles` 集合强制同一文件只开一次(ADR-007);**`transaction(fn)` 拒绝 async 回调**。

### 2.6 `services/backend/store/migrations/001_init.sql` —— 已冻结

9 张表:`ai_conversations`、`ai_messages`、`ai_memories`、`jobs`、`job_events`、`plugin_logs`、`http_access_logs`、`traces`、`schema_migrations`(后者带 `IF NOT EXISTS`,因为迁移运行器要先建它)。

⚠️ `idx_jobs_resource_active` 是**部分唯一索引**,`WHERE status IN ('queued','running')` 与 `state-machine.js` 的 `ACTIVE_STATUSES` 绑定。两处不同步的后果是代码以为锁已释放、索引仍拦 INSERT,表现为莫名的 `SQLITE_CONSTRAINT`。`tests/backend/state-machine.test.js` 已经把这条写成断言。

时间列一律 `INTEGER` Unix 毫秒。保留策略:`http_access_logs` 7 天或 1 万行;`job_events` 随 job 级联;`plugin_logs` 每插件 5000 条;每小时清理一次。

### 2.7 `services/backend/jobs/state-machine.js`

集合:`JOB_STATUSES`(6)、`ACTIVE_STATUSES`、`TERMINAL_STATUSES`、`RETRYABLE_STATUSES`、`JOB_KINDS`(17)、`UNCANCELABLE_PHASES`(`{"finalizing"}`)、`MAX_ATTEMPTS_BY_KIND`(9 个键,值都是 2)、`DEFAULT_MAX_ATTEMPTS = 1`、`INTERRUPTED_ERROR_CODE = "BACKEND_RESTARTED"`。

函数:`isJobStatus`、`isJobKind`、`isActive`、`isTerminal`、`maxAttemptsFor`、`nextStatuses`、`canTransition`、`assertTransition(from, to, { jobId })`、`isCancelable({ status, phase })`、`assertCancelable`、`canRetry`、`assertRetry`、`interruptionError(reason)`。

要点:合法边**恰好 9 条**,非法流转抛 `CONFLICT`/409(是并发,不是输入错误);取消判定看 **phase 不看 kind** —— 运行器在写最终文件前必须把 phase 置为 `finalizing`,否则「正在落盘时被取消」这个约束形同虚设;`assertCancelable` 抛 `JOB_NOT_CANCELABLE` 时**显式带 423**(业务码不在默认状态表里)。

### 2.8 `services/backend/index.js`

退出码:`64` 无 IPC 通道、`65` init 超时、`66` HTTP 启动失败、`70` 未捕获异常、`78`(在 bridge 里)版本不兼容。超时常量 `INIT_TIMEOUT_MS = 10_000`、`SHUTDOWN_GRACE_MS = 5_000`。

`runtime` 对象包含 `{ sessionToken, startedAt, secrets, userDataDir, legacyToken, petState, degraded, db }` 以及已装配的 `settings`、`jobs`、`logs`、`service`、`catalog`、`petPacks`、`actions`、`plugins`、`about`、`queue`、`runner` 等运行时句柄 —— 新模块需要运行期状态就挂在这里,不要另造全局。

中间件顺序(**不要改**):`requestId → errorBoundary → accessLog → loopbackOnly → bearerAuth → jsonBody`。

启动顺序刻意与 07 篇 spike 1 不同:先 `init` 再监听端口再发 `ready`,只有一个就绪点。`ready` 消息体 `{ type, port, apiVersion: "v1", pid, sessionToken, startupMs }`。

### 2.9 `apps/desktop/src/sidecar/spawn.js`(CJS)

导出 `spawnSidecar`、`stopSidecar`、`resolveSidecarEntry`、`SIDECAR_RELATIVE_ENTRY = "services/backend/index.js"`、`READY_TIMEOUT_MS = 10000`、`EXIT_CODE_VERSION_MISMATCH = 78`、`MAX_VERSION_MISMATCH_RELAUNCHES = 2`。

抛 `SIDECAR_READY_TIMEOUT`、`SIDECAR_VERSION_MISMATCH`、`SIDECAR_EARLY_EXIT`、`SIDECAR_SPAWN_FAILED`。成功返回 `{ child, port, sessionToken, apiVersion, pid, startupMs, attempt, baseUrl }`。重拉预算只对 `SIDECAR_VERSION_MISMATCH` 生效。

### 2.10 `packages/contracts/src/*.ts`

`index.ts` 只做 re-export,新增契约文件要在这里追加一行(热点文件,只追加)。**缩进是 2 空格,不是 tab。**

`bridge.ts` 已导出:`BRIDGE_PROTOCOL_VERSION`、`EXIT_CODE_VERSION_MISMATCH`、`MAX_VERSION_MISMATCH_RELAUNCHES`、`DIALOG_RESULT_TIMEOUT_MS`、`SIDECAR_READY_TIMEOUT_MS`、`envelopeSchema`、`Envelope<T>`、`backendToShellSchema`(9 项)、`shellToBackendSchema`(6 项)、两个信封 schema、`inspectEnvelope`。

`init` 消息是唯一允许携带敏感数据(`providerKeys`)的地方,ADR-010;后端只留内存,不落盘。

### 2.11 门禁与测试

`scripts/check-api-contract.mjs` 对账六项并重算 03 篇 §3 的算术,格式硬要求见 08 篇 §5。
`tests/backend/state-machine.test.js` 是测试样板 —— 新测试照抄它的 CJS + `await import()` 开头。当前 `check:api-contract` 已硬对账实际路由注册表与 IPC 清单,不再输出 `todo`。

### 2.12 `services/backend/store/migrate.js`

```js
MIGRATIONS_DIR
CODE_SCHEMA_VERSION
checksumOf(sql)                         // → sha256 hex
listMigrationFiles()                    // → [{ version, file, path, sql, checksum }]
appliedVersions(db)                     // → [{ version, applied_at, checksum }]
migrate({ db, logger } = {})            // → { from, to, applied }
```

`migrate` 先确保 `schema_migrations` 存在,校验所有已应用迁移的 checksum,拒绝数据库版本高于代码版本,再逐个以同步事务应用缺失迁移。`db` 必须提供 `exec`、`prepare`、`transaction`;迁移 logger 只使用可选的 `info`。

### 2.13 `services/backend/jobs/queue.js`

```js
CONCURRENCY_BY_GROUP
QUEUE_TIMEOUT_MS = 30_000
QUEUE_TICK_MS = 250
groupOf(kind)                          // → "image" | "creator" | "plugin-install" |
                                       //    "plugin-command" | "pack" | "other"
createQueue({
  repo, logger, now = Date.now,
  queueTimeoutMs = QUEUE_TIMEOUT_MS, tickMs = QUEUE_TICK_MS,
} = {})                                // → { enqueue, next, release, cancel,
                                       //    stats, expire, stop }
```

`enqueue(input)` 接受新 Job 对象或已有 Job id 字符串;新对象经 `repo.insert`,已有 id 经 `repo.byId`。`next()` 按组并发上限把 queued Job 转为 running;`release(job)` 释放运行槽并尝试返回下一个 Job;`cancel(job)` 只取消等待中的 Job;`expire(nowValue)` 返回排队超时后转为 canceled 的 Job 列表。队列创建时启动可 `unref` 的超时扫描器,`stop()` 必须在 shutdown 时调用。

### 2.14 `services/backend/jobs/runner.js`

```js
SIGKILL_DELAY_MS = 2_000
SHUTDOWN_GRACE_MS = 5_000
RETRY_BASE_DELAY_MS = 250
signalProcessTree(processHandle, signal) // → boolean
createRunner({
  repo, queue, progress = createProgressThrottle, handlers = {}, emit, logger,
  delay, signalTree, isRunning,
  shutdownGraceMs = SHUTDOWN_GRACE_MS, tmpRoot = null,
} = {})                                // → { run, cancel, shutdown }
```

`run(job?)` 从 `queue.next()` 或显式 Job 启动 handler,返回 Promise;没有可运行 Job 时返回 `null`。handler 收到 `{ job, tmpDir, signal, report(frame), registerProcess(processHandle), finalize(writeFinalArtifact) }`;其中 `finalize` 先发出 `phase: "finalizing"` 的末帧。`cancel(jobId)` 与 `shutdown()` 均为 Promise,后者返回 `{ interrupted }`;子进程终止按进程树处理并在超时后 SIGKILL。

### 2.15 `services/backend/jobs/progress.js`

```js
THROTTLE_MS = 500
MIN_PERCENT_DELTA = 1
NO_PROGRESS_PERCENT = -1
createProgressThrottle({ onEmit, now = Date.now } = {})
  // → { report(frame), flush(), reset() }
```

每个运行中的 Job 独占一个节流器。`report({ phase, percent, ... })` 丢弃回退进度,相位变化立即发出,同相位的末帧由 `flush()` 保证发出;`reset()` 用于 retry 新 attempt。`onEmit(frame)` 是唯一外部副作用。

### 2.16 `services/backend/jobs/recovery.js`

```js
JOB_TMP_PREFIX = "job-"
RECOVERY_EVENT = "system.jobs-recovered"
recoverJobs({ repo, tmpDir, emit, logger, requeueRecovered = true } = {})
  // → { interrupted, requeued, tmpRemoved }
```

启动恢复扫描全部 running Job,经 repository 写为 `interrupted` 并按策略重新排队;脱敏的 `plugin.command` 不自动重排。随后清理 `tmpDir` 下的 `job-*` 子目录,并可发布 `system.jobs-recovered`。

### 2.17 `services/backend/store/repositories/jobs.js`

```js
createJobsRepository({ db, now = Date.now } = {})
  // → {
  //   insert, byId, list, count, removeCompleted, transition,
  //   setProgress, finish, appendEvent, listEvents, countEvents,
  //   activeByResourceKey, countByStatus
  // }
```

实际签名如下:

```js
insert(input = {})                         // → Job
byId(id)                                   // → Job | null
list({ status, kind, resourceKey, limit, offset } = {}) // → Job[]
count({ status, kind } = {})               // → number
removeCompleted()                          // → number
transition(id, to)                         // → Job
setProgress(id, progress)                  // → Job
finish(id, { status = "succeeded", result, error } = {}) // → Job
appendEvent(jobId, { at, phase, percent, message } = {}) // → JobEvent
listEvents(jobId, { limit } = {})          // → JobEvent[]
countEvents(jobId)                         // → number
activeByResourceKey(resourceKey)           // → Job | null
countByStatus(status?)                     // → number | { [status]: number }
```

状态转换统一经 `state-machine.js` 断言并用当前 status 做 CAS 更新;`resourceKey` 活跃锁冲突返 423。插件 Job 的 input 持久化为脱敏摘要,不把插件命令明文写入 SQLite。

---

### 2.18 T42 Actions 接口

`createActionService({ shell, jobs, emit, now })` 通过 Shell 原服务提供活动包视图。`importFrames({ selectionId, actionId, label? })` 只创建 Job；`runImportFrames({ selectionId, actionId, label, signal, report, finalize })` 在 finalizing 内派发导入。Shell 的 `src/main/ipc/actions-sidecar-bridge.js` 保留原生选择、配置写入、提案与规则校验、动画广播、运行诊断。12 个业务 IPC 退休，原生 inspect 留用；T47 又退休 29 个 AI 业务 IPC，当前 99 个 IPC，preload 13,490 字节。T43 的 10 KiB 目标尚未达到，当前 24 KiB 阈值只作为过渡门禁。

## 3. 还不存在的文件

按 M1 归组;编号见 [10 篇](./10-tasks-m1.md)、[11 篇](./11-tasks-m1-http.md)、[12 篇](./12-tasks-m2.md)、[13 篇](./13-tasks-m3.md) 的任务卡(M1 = T01–T14、M2 = T15–T23、M3 = T24–T33)。

| 组 | 待建 |
| --- | --- |
| 迁移与仓储 | ~~`store/migrate.js`、`store/repositories/*.js`、`store/migrate-from-json.js`~~ ✅ T01/T02/T14/T47 已落地；traces、HTTP access logs 等归属仍见缺口 G13 |
| Job 引擎 | ~~`jobs/queue.js`、`jobs/runner.js`、`jobs/progress.js`、`jobs/recovery.js`、`jobs/handlers/*.js`~~ ✅ T05–T08/T31 已落地 |
| HTTP | ~~`routes/*.js`、`domains/*.js`、SSE 推送~~ ✅ T09–T33 已落地；当前注册表实际 76 条路由 |
| 密钥 | ~~`secrets/*.js`~~ ✅ T44 `1433b299` 已落地，只写边界与脱敏摘要 |
| 反向通道 | ~~`dialog.request` 补齐、`apps/desktop/src/sidecar/message-handler.js`、`orphan-cleanup.js`、`domains/plugins/process-ledger.js`(T29)~~ ✅ T12/T13/T29 已落地 |
| 兼容层 | ~~`mcp/*.js`、`/api/pet/*` 与 `/mcp`~~ ✅ T45 `7bdf4f77` 已迁入同一 sidecar 的独立监听器，默认关闭 |
| AI / Creator | T46 `40358259` 与 `4b6a1ac2` 已实现 image.generate Job 和 finalizing；T47 `6dc7e9f0` 已完成 AI 对话域与 SQLite；T48 Creator 迁移待完成 |

> ✅ **`conversations` 仓储已在 T47 建成。** T14 的 JSON 导入仍直接使用迁移事务；运行期 AI 对话由 `store/repositories/conversations.js` 负责，新增结构只通过 `002_ai_talk.sql` 扩展。

---

## 4. 缺口清单

本节的 G1–G13 是**缺口编号**,与 [README §三](./README.md) 的目标 G1–G8 是两套互不相干的编号;本篇正文统一写作「缺口 G1」至「缺口 G13」。

每条都是**已知**的,不要重复发现。已关闭的条目保留在表里并标 ✅,这样你既不会重复修,也不会以为它从来没存在过。

| 编号 | 状态 | 现象 | 影响 / 去向 |
| --- | --- | --- | --- |
| 缺口 G1 | ✅ | `@openpet/contracts` 的 `main` 已指向构建产物 `dist/` | T34 已闭合: `build:contracts` 已进入 pack/dist/CI,`asarUnpack` 覆盖 `contracts/zod`(实现证据: `77e5d8435d0c88be3760d85f52df15580001720b`;合并证据: `929f6676e354f3aa1b298b4755fc069f96b9addc`) |
| 缺口 G2 | ✅ | 后端与契约反向通道均为 12 项,含 `dialog.request` 与 settings apply/persist | T12 已补齐 dialog 白名单，T41 增加 settings host-effect/persist 消息；`tests/backend/bridge-dialog.test.js` 与 `tests/backend/reverse-channel-allowlist.test.js` 覆盖成功、超时、关联响应和类型校验 |
| 缺口 G3 | ⏳ | 13 个通用码的状态映射在 `middleware.js` 和契约 `envelope.ts` **各有一份** | 需要 gate 检查这层重复;不要再复制第三处 |
| 缺口 G4 | ✅ | R20:ESM 入口在 `app.asar` 内可能解析失败 | E6 命中 `spawn ENOTDIR`;已用 `asarUnpack` + unpacked resolver 缓解并收到打包 sidecar ready(证据: `6248d2366435ee765799bdf581c8b6ae22a526e4`) |
| 缺口 G5 | ✅ | `package-lock.json` 未与 workspaces 同步 | E1 `npm install` 已确认 workspaces 和 lockfile 解析正常;本次 lockfile 无额外变化(证据: `304a5a346083bb7888407a2ed2dcaa3517e4d981`) |
| 缺口 G6 | ✅ | M0 六条 spike 结果未回填 | E3–E8 已全部实测并回填;唯一权威结果见 [07 篇](./07-spike.md) §7(证据: `bbfdb096d8a224f513eea5160cf000281f487161`) |
| 缺口 G7 | ✅ | 04 篇 §2.6 的 ⚠️ 待补登记 注记已过期 | 已关闭:注记改为「已补登(v1.3)」,并说明 `system` topic 现列四个事件、已纳入 `check:api-contract` 的 `EVENT_NAMES` 对账范围(证据: `e38940dbd8466712f6c499631e9e5ee9f4250959`) |
| 缺口 G8 | ✅ | 06 篇 §9 风险表缺 R20 | 已关闭:R20 已补入风险登记册,并同步收紧 §2 spike 第 5 条的判定标准(证据: `6248d2366435ee765799bdf581c8b6ae22a526e4`) |
| 缺口 G9 | ✅ | 路由表与 IPC 通道盘点门禁已硬化 | `check:api-contract` 对账 `routes/registry.js`、实际 `router.routes()`、03 篇 §4 与 TS/JS IPC 清单;当前为 112 条实际路由、99 条通道（T47 AI 退休 29 条 IPC，证据：`6dc7e9f0`） |
| 缺口 G10 | ✅ | `tests/backend/state-machine.test.js` 有一处 `it()` 标题笔误 | E9 已改为「6 个状态,17 个 kind」(证据: `bbfdb096d8a224f513eea5160cf000281f487161`) |
| 缺口 G11 | ✅ | E3 的 `:memory:` SQLite 探针不证明 WAL | T35 已由 file-backed `tests/backend/sqlite-driver.test.js` 复验 WAL、四项默认 pragma 与跨连接持久化(证据: `08c24e1c364e9ca6a59f57bc6544cb447aa0b565`) |
| 缺口 G12 | ✅ | 03 篇 §3 盘点 7 个 `SERVICE_*` 写通道,§4.1 已有对应入口 | T16 已补齐并实现服务配置写入端点 `PUT /service/config`,同时同步契约表(实现证据: `4480c4b5749d2ed242716732e45573ffc1a3131a`;契约/注册表证据: `4faa07df0244e9ce8bb53501589eaee4e50ac0b9`) |
| 缺口 G13 | ⏳ | `001_init.sql` 已建 9 张表；T47 已补齐 AI conversations、messages、memories 的运行期 repository；`traces`、`http_access_logs` 仍需独立 ownership card | 后续底层存储任务明确 traces 与 HTTP access logs 的归属和生命周期，不再重复建设 conversations 仓储 |

---

## 5. 六条 spike 的已完成结果

**E3–E8 已于 macOS / Electron 42.4.0 / Node 24.16.0 实测。** 结果见 [07 篇](./07-spike.md) §7:fork、端口、打包 sidecar、file-backed SQLite WAL 与 safeStorage 通过;前端闸门为预期的 3/4。

> 📌 **执行细节仍见 [14 交接单](./14-handoff.md) 的 E3–E8 卡**,但本节是状态索引而非待执行清单。完整实测值只维护在 [07 篇](./07-spike.md) §7。

| spike | 结果 | 后续归属 |
| --- | --- | --- |
| 6 `node:sqlite` | [07 篇 §7 第 6 行](./07-spike.md):模块、部分唯一索引、事务与 file-backed WAL 通过;`:memory:` 仅显示 memory 模式 | 已关闭缺口 G11;T35(卡面 [#41 §5](https://github.com/dengyie/OpenPet/issues/41),进度 [#41 §4](https://github.com/dengyie/OpenPet/issues/41)) |
| 1 fork sidecar | [07 篇 §7 第 1 行](./07-spike.md):ready +145 ms,双向消息与 clean exit 通过 | D1 保持 fork |
| 2 端口与 ready | [07 篇 §7 第 2 行](./07-spike.md):单跑首行 +569 ms;共享 T0 首行 +779 ms;完整链路 ready +86 ms | 窗口创建前并行启动 |
| 5 打包 | [07 篇 §7 第 5 行](./07-spike.md):初始 `spawn ENOTDIR`;`asarUnpack` + unpacked resolver 后 ready、clean exit 0 | R20 已缓解;后端 JS 明文可读 |
| 3 前端闸门 | [07 篇 §7 第 3 行](./07-spike.md):3/4,第 2 条按预期红 | T20(#41 §4) |
| 4 safeStorage | [07 篇 §7 第 4 行](./07-spike.md):sidecar 无 safeStorage;Shell encryption available | ADR-010 保留 |

🚨 **除 spike 1 外,命令前面那个 `ELECTRON_RUN_AS_NODE=1` 不能省。** spike 1 不带是故意的 —— `shell.js` 本身就是 Electron 主进程,由它给子进程设这个变量。

**spike 4 尤其要命**:不带这个变量,你跑的是 Electron 主进程,`require("electron")` 当然拿得到 `safeStorage` —— 你会得到与事实**完全相反**的结论,进而错误地删掉 ADR-010 的 `init` 注入。本表在 v1.1 及以前的版本里,spike 3 与 spike 4 两行漏了这个变量,v1.2 已修。

**维护边界**:结果已经闭环;只有打包、Electron 或协议边界变化时才重跑受影响的 spike。M1–M3 仍按任务卡依赖推进,不能把 M0 证据解读为功能完成。

---

## 6. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-08-15 | 首版:已落地文件的对外接口、待建清单、10 条缺口、spike 状态 |
| v1.1 | 2026-08-15 | 缺口表新增「状态」列,**关闭 G7 与 G8**(04 篇 §2.6 注记已清、06 篇 §9 已补 R20);G4 的去向改为已登记的 R20;G2 补注由 T12 修且 T18/T19 强依赖;§3 待建清单接上 12/13 篇的卡号(T14、T29、T31),并注明 `conversations` 仓储要到 M4 才建 |
| v1.2 | 2026-08-15 | **修掉 §5 命令表里 spike 3、spike 4 缺 `ELECTRON_RUN_AS_NODE=1` 的两行**(这是 [14 篇](./14-handoff.md) §5 登记的第 1 条文档债,危险度高:spike 4 用错解释器会得出相反结论);§5 补执行卡与唯一权威结果表的指针;§4 给 G1/G4/G5/G6/G10 标注对应的 E 卡,G9 补注「打印 `todo` 不算红」 |
| v1.3 | 2026-08-16 | 以 `main` 为基线回填 E1–E10;缺口 G1/G11 改由 T34/T35 对接 #41 §5 卡面与 #41 §4 进度;完成结果替代待执行表,并区分目标 G1–G8 与缺口 G1–G11 |
| v1.4 | 2026-09-04 | T37 复核当前仓库:补齐 sidecar/backend、迁移、Job、路由与仓储现状;关闭 G2/G9/G11/G12,登记 G13 未归属仓储;同步 68 条实际路由与 158 条 IPC 门禁证据 |
| v1.5 | 2026-09-05 | T41/T42 复核:当前 154 条 IPC;About 两条业务通道已退休;Catalog、Pet Packs、Actions 因后端语义不等价保留 IPC/preload 并登记 blocked:T42;反向通道补记 settings apply/persist 类型 |
| v1.6 | 2026-09-05 | T42 Catalog 6 条 IPC 已在 `ac59d75f` 同提交退休；当前 148 条 IPC、74 条 REST 路由；T41 live bridge 修复提交 `bac49b80` 待总控 rebase 验收 |
| v1.7 | 2026-09-05 | T42 Pet Packs 8 条 IPC 已在 `490357f7` 同提交退休；当前 140 条 IPC、74 条 REST 路由；T41 live bridge rebase 后提交 `890dac82` 待合入 |
| v1.8 | 2026-09-08 | T42 Actions 活动包权威与 Job 切换；当前 128 条 IPC、76 条 REST 路由；T44 密钥、T45 MCP、T46 图像任务补录，T43/T47/T48 保留未完成状态 |
| v1.9 | 2026-09-10 | T47 AI 域与 SQLite 会话仓储落地；当前 99 条 IPC、112 条实际路由、preload 13,490 字节；T43 阈值收紧与 T48 Creator 迁移仍待完成 |
