# 15 · IPC 通道退役台账

> v1.4 · 2026-09-05 · T42 Actions · 以 `src/shared/ipc-channels.ts` 为当前清单

本台账登记当前 127 个 IPC 常量的去向。`keep` 是 02 篇允许长期存在的窗口/原生边界；`cutover:<domain>` 表示 03 篇已有 HTTP/SSE 对等入口；`blocked:Txx` 表示等待指定任务卡完成后再切换；`retired` 表示已从当前清单删除并保留历史记录；`dead` 仅用于确认没有生产调用方的遗留常量。

当前台账由 121 个 `ipcMainService.handle/on` 注册和 6 个事件-only 通道组成。Source 列是实际生产引用文件，不是推测路径；门禁会逐项检查 TS/JS 清单、注册/事件来源、重复项和未知 `IPC.*` 引用。

T40 卡面与 T39 后的 03 篇有一处数字演进：T40 的硬上限仍为 `keep ≤ 41`，因此新增的 QQ/WeCom 四个 host-secret 通道登记为 `blocked:T44`，而不是伪装成长期 keep。T41 及后续任务可把已删除常量保留为 `retired` 历史行，并在 Retired by 列记录提交 SHA；历史行不计入当前通道对账或 keep 上限。

## Summary

| Scope | Count |
| --- | ---: |
| Current IPC constants | 127 |
| Current direct registrations | 121 |
| Current event-only channels | 6 |
| Current keep | 40 |
| Current cutover | 29 |
| Current blocked | 58 |
| Current dead | 0 |
| Historical retired | 31 |

## Ledger

| IPC channel | Status | HTTP route / blocker | Source | Reason | Retired by |
| --- | --- | --- | --- | --- | --- |
| `pet:get-animations` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:animations-changed` | `keep` | `IPC-only (native/window)` | `preload.js` | Window/native IPC remains the intended boundary | — |
| `pet:get-bounds` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:get-movement-state` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:set-viewport` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:set-position` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:set-mouse-passthrough` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:request-focus-for-cursor` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:record-app-log` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:drag-ended` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:move-by` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:say` | `keep` | `IPC-only (native/window)` | `preload.js` | Window/native IPC remains the intended boundary | — |
| `pet:play-action` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:show-context-menu` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-pet-runtime-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet:menu-command` | `keep` | `IPC-only (native/window)` | `preload.js` | Window/native IPC remains the intended boundary | — |
| `pet:quit` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-system-ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:open` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:get-state` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:hide` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:set-always-on-top` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:open-settings` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:send-message` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:cancel-message` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-chat:state-changed` | `keep` | `IPC-only (native/window)` | `src/main/pet-chat-preload.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:get-state` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:open` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:show-message` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:hide` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:set-pinned` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:set-interacting` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:set-hit-test-mode` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:drag-to` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:send-message` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:cancel-message` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-bubble-chat:state-changed` | `keep` | `IPC-only (native/window)` | `src/main/pet-bubble-chat-preload.js` | Window/native IPC remains the intended boundary | — |
| `settings:open` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-system-ipc.js` | Window/native IPC remains the intended boundary | — |
| `settings:get` | `retired` | `GET /settings` | `src/main/ipc/register-settings-ipc.js` | Control Center reads the versioned, redacted Backend envelope through HTTP | 13a419a66eb2b42781fc2a79d193499fc6b99916 |
| `settings:save` | `retired` | `PATCH /settings` | `src/main/ipc/register-settings-ipc.js` | Control Center writes canonical point-path patches through Backend optimistic locking; trusted Shell effects are applied from Backend snapshots | 13a419a66eb2b42781fc2a79d193499fc6b99916 |
| `settings:import-cursor` | `blocked:T41` | `POST /settings/cursor/import` — unavailable fallback | `src/main/ipc/register-settings-ipc.js` | Route registration receives no handler from the backend composition root, so it returns `BACKEND_UNAVAILABLE`; T41 must bridge the host dialog and cursor importer | — |
| `settings:preview-scale` | `blocked:T41` | `POST /settings/preview-scale` — unavailable fallback | `src/main/ipc/register-settings-ipc.js` | Route registration receives no handler from the backend composition root, so it returns `BACKEND_UNAVAILABLE`; T41 must bridge the host preview side effect | — |
| `settings:close` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-settings-ipc.js` | Window/native IPC remains the intended boundary | — |
| `settings:changed` | `blocked:T41` | `SSE settings.changed` — renderer/bootstrap parity pending | `control-center-preload.js` | SSE only publishes changed paths and version after backend PATCH; IPC still synchronizes pet-renderer settings and multiplexes backend bootstrap updates, which T41 must replace before retirement | — |
| `actions:get` | `retired` | `GET /actions` | `src/main/ipc.js` | Control Center reads the complete persisted action config from Backend | 4b6a1ac |
| `actions:inspect-frames` | `retired` | `POST /actions/frames/inspect` | `src/main/ipc.js` | Frame inspection is owned by the Backend action domain | 4b6a1ac |
| `actions:reinspect-frames` | `retired` | `POST /actions/frames/reinspect` | `src/main/ipc.js` | Reinspection uses the HTTP action selection lifecycle | 4b6a1ac |
| `actions:clear-frame-selection` | `retired` | `DELETE /actions/frames/selection` | `src/main/ipc.js` | Selection cleanup is owned by the Backend action domain | 4b6a1ac |
| `actions:import-frames` | `retired` | `POST /actions/frames/import` → Job/SSE | `src/main/ipc.js` | Frame import uses the shared Jobs runner and publishes action changes | 4b6a1ac |
| `actions:save-config` | `retired` | `PUT /actions/config` | `src/main/ipc.js` | Config writes use host ActionService persistence semantics | 4b6a1ac |
| `actions:preview-trigger-proposal` | `retired` | `POST /actions/triggers/preview` | `src/main/ipc.js` | Preview delegates to host validation without persisting | 4b6a1ac |
| `actions:submit-trigger-proposal` | `retired` | `POST /actions/triggers/proposals` | `src/main/ipc.js` | Proposal inbox is persisted in the action manifest | 4b6a1ac |
| `actions:accept-trigger-proposal` | `retired` | `POST /actions/triggers/proposals/:id/accept` | `src/main/ipc.js` | Acceptance applies host action/rule effects | 4b6a1ac |
| `actions:reject-trigger-proposal` | `retired` | `POST /actions/triggers/proposals/:id/reject` | `src/main/ipc.js` | Rejection persists status and reason | 4b6a1ac |
| `actions:update-trigger-rule` | `retired` | `PATCH /actions/triggers/rules/:id` | `src/main/ipc.js` | Rule updates use host validation and persistence | 4b6a1ac |
| `actions:delete-trigger-rule` | `retired` | `DELETE /actions/triggers/rules/:id` | `src/main/ipc.js` | Rule deletion uses host persistence semantics | 4b6a1ac |
| `actions:delete` | `retired` | `DELETE /actions/:id` | `src/main/ipc.js` | Deletion delegates to the shared importer | 4b6a1ac |
| `pet-packs:list` | `retired` | `GET /pet-packs` | `src/main/ipc.js` | Pet Pack state is served through the Shell-owned reverse bridge and Backend HTTP | 490357f7 |
| `pet-packs:inspect-directory` | `keep` | `IPC-only (native/window)` | `src/main/ipc.js` | Window/native IPC remains the intended boundary | — |
| `pet-packs:clear-selection` | `retired` | `POST /pet-packs/validate` | `src/main/ipc.js` | Selection lifecycle is handled through the Shell Pet Pack reverse bridge | 490357f7 |
| `pet-packs:import` | `retired` | `POST /pet-packs/import` → Job | `src/main/ipc.js` | Import job delegates to the Shell-owned Pet Pack service | 490357f7 |
| `pet-packs:export` | `retired` | `POST /pet-packs/:id/export` → Job | `src/main/ipc.js` | Export job delegates to the Shell-owned Pet Pack service | 490357f7 |
| `pet-packs:set-active` | `retired` | `POST /pet-packs/:id/activate` | `src/main/ipc.js` | Activation and runtime refresh are owned by the Shell bridge | 490357f7 |
| `pet-packs:active-changed` | `retired` | `SSE pet.pack-activated` | `control-center-preload.js` | Active-pack updates are delivered through SSE after Shell activation | 490357f7 |
| `pet-packs:remove` | `retired` | `DELETE /pet-packs/:id` | `src/main/ipc.js` | Removal delegates to the Shell-owned Pet Pack service | 490357f7 |
| `control-center:active-pet-pack-changed` | `retired` | `SSE pet.pack-activated` | `control-center-preload.js` | Control Center now invalidates Pet Pack state from SSE | 490357f7 |
| `ai:get-config` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:save-config` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:save-api-key` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:save-vision-api-key` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:clear-vision-api-key` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:test-connection` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:discover-models` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:discover-vision-models` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:get-persona-profile` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:generate-persona-draft` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:save-persona-override` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:get-memory-profile` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:delete-memory` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:clear-pet-pack-memories` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-talk:get-trace-summary` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-talk:export-trace` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `hatch-pet-agent:get-config` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `hatch-pet-agent:save-config` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `hatch-pet-agent:save-api-key` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `hatch-pet-agent:clear-api-key` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `hatch-pet-agent:check-capability` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `hatch-pet-agent:get-run-status` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `image-generation:get-config` | `blocked:T46` | `Backend image-generation Job not landed` | `src/main/ipc/register-ai-ipc.js` | Image generation waits for T46 Job handler | — |
| `image-generation:save-config` | `blocked:T46` | `Backend image-generation Job not landed` | `src/main/ipc/register-ai-ipc.js` | Image generation waits for T46 Job handler | — |
| `image-generation:save-api-key` | `blocked:T46` | `Backend image-generation Job not landed` | `src/main/ipc/register-ai-ipc.js` | Image generation waits for T46 Job handler | — |
| `image-generation:clear-api-key` | `blocked:T46` | `Backend image-generation Job not landed` | `src/main/ipc/register-ai-ipc.js` | Image generation waits for T46 Job handler | — |
| `image-generation:check-health` | `blocked:T46` | `Backend image-generation Job not landed` | `src/main/ipc/register-ai-ipc.js` | Image generation waits for T46 Job handler | — |
| `image-generation:discover-models` | `blocked:T46` | `Backend image-generation Job not landed` | `src/main/ipc/register-ai-ipc.js` | Image generation waits for T46 Job handler | — |
| `ai:get-conversation` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:chat` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai:export-trace-diagnostics` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-behavior:get` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-behavior:save` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-behavior:dry-run` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-behavior:replay-decision` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-behavior:export-diagnostics` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `ai-behavior:clear-decisions` | `blocked:T47` | `Backend AI domain not landed` | `src/main/ipc/register-ai-ipc.js` | AI domain waits for T47 migration | — |
| `plugins:list` | `cutover:plugins` | `GET /plugins` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:set-enabled` | `cutover:plugins` | `POST /plugins/:id/enable` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:set-native-execution-approved` | `cutover:plugins` | `POST /plugins/:id/native-approval` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:save-config` | `cutover:plugins` | `PUT /plugins/:id/config` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:im-gateway:get-secret-state` | `cutover:plugins` | `GET /plugins/:id/config?operation=secret-state` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:im-gateway:save-telegram-token` | `cutover:plugins` | `PUT /plugins/:id/config?operation=secret-save` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:im-gateway:clear-telegram-token` | `cutover:plugins` | `PUT /plugins/:id/config?operation=secret-clear` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:im-gateway:save-qq-credentials` | `blocked:T44` | `Backend secrets boundary not landed` | `src/main/ipc/register-plugin-ipc.js` | Host-secret channel waits for T44 secrets boundary | — |
| `plugins:im-gateway:clear-qq-credentials` | `blocked:T44` | `Backend secrets boundary not landed` | `src/main/ipc/register-plugin-ipc.js` | Host-secret channel waits for T44 secrets boundary | — |
| `plugins:im-gateway:save-wecom-credentials` | `blocked:T44` | `Backend secrets boundary not landed` | `src/main/ipc/register-plugin-ipc.js` | Host-secret channel waits for T44 secrets boundary | — |
| `plugins:im-gateway:clear-wecom-credentials` | `blocked:T44` | `Backend secrets boundary not landed` | `src/main/ipc/register-plugin-ipc.js` | Host-secret channel waits for T44 secrets boundary | — |
| `plugins:run-creator-studio-default-flow` | `cutover:plugins` | `POST /plugins/:id/commands/:cmd?operation=creator-default-flow` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:run-command` | `cutover:plugins` | `POST /plugins/:id/commands/:cmd` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:run-setup` | `cutover:plugins` | `POST /plugins/:id/commands/:cmd?operation=setup` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:open-dashboard` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-plugin-ipc.js` | Window/native IPC remains the intended boundary | — |
| `plugins:start-service` | `cutover:plugins` | `POST /plugins/:id/start` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:stop-service` | `cutover:plugins` | `POST /plugins/:id/stop` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:check-service-health` | `cutover:plugins` | `POST /plugins/:id/start?operation=health` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:save-service-health-policy` | `cutover:plugins` | `PUT /plugins/:id/config?operation=health-policy` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:inspect-package` | `keep` | `IPC-only (native/window)` | `src/main/ipc/register-plugin-ipc.js` | Window/native IPC remains the intended boundary | — |
| `plugins:inspect-github-repository` | `cutover:plugins` | `POST /plugins/validate` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:clear-selection` | `cutover:plugins` | `POST /plugins/install?operation=clear-selection` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:install` | `cutover:plugins` | `POST /plugins/install` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:update` | `cutover:plugins` | `POST /plugins/install (update)` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:uninstall` | `cutover:plugins` | `DELETE /plugins/:id` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:get-logs` | `cutover:plugins` | `GET /plugins/:id/logs` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:export-logs` | `cutover:plugins` | `GET /plugins/:id/logs?operation=export` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:clear-logs` | `cutover:plugins` | `DELETE /plugins/:id/logs` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `plugins:clear-storage` | `cutover:plugins` | `POST /plugins/:id/enable?operation=storage-clear` | `src/main/ipc/register-plugin-ipc.js` | Existing backend route is the migration target | — |
| `creator:get-state` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:pick-reference-image` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:bind-reference` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:generate-new-character` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:generate-existing-action` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:retry-action` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:retry-identity` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:accept-identity` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:accept-action-candidate` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:export-recovery-bundle` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:import-available-actions` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:get-last-run` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `creator:get-asset-preview` | `blocked:T48` | `Backend Creator domain not landed` | `src/main/ipc/register-creator-ipc.js` | Creator Studio waits for T48 migration | — |
| `service:get-status` | `cutover:service` | `GET /service/status` | `src/main/ipc/register-service-ipc.js` | Existing backend route is the migration target | — |
| `service:save-config` | `cutover:service` | `PUT /service/config` | `src/main/ipc/register-service-ipc.js` | Existing backend route is the migration target | — |
| `service:get-logs` | `cutover:service` | `GET /service/logs` | `src/main/ipc/register-service-ipc.js` | Existing backend route is the migration target | — |
| `service:export-logs` | `cutover:service` | `GET /service/logs?operation=export` | `src/main/ipc/register-service-ipc.js` | Existing backend route is the migration target | — |
| `service:clear-logs` | `cutover:service` | `DELETE /service/logs` | `src/main/ipc/register-service-ipc.js` | Existing backend route is the migration target | — |
| `service:rotate-token` | `cutover:service` | `POST /service/token/rotate` | `src/main/ipc/register-service-ipc.js` | Existing backend route is the migration target | — |
| `service:revoke-mcp-sessions` | `blocked:T45` | `Backend route not implemented: POST /service/token/revoke-sessions` | `src/main/ipc/register-service-ipc.js` | Waiting for T45 MCP sidecar migration; current backend route registry has no MCP session revoke endpoint | — |
| `about:get-info` | `retired` | `GET /about` | `src/main/ipc.js` | Control Center reads the host About view through Backend HTTP | 413c5825 |
| `about:check-updates` | `retired` | `POST /about/check-updates` | `src/main/ipc.js` | Control Center queues the existing update-check Job and follows its result through Backend Job/SSE APIs | 413c5825 |
| `catalog:get` | `retired` | `GET /catalog` | `src/main/ipc.js` | Catalog state now comes from the Shell-owned Catalog bridge and Backend HTTP route | ac59d75f |
| `catalog:prepare-install` | `retired` | `POST /catalog/prepare` | `src/main/ipc.js` | Reviewed install preparation is handled by the Backend Catalog domain | ac59d75f |
| `catalog:install-selection` | `retired` | `POST /catalog/install` → Job | `src/main/ipc.js` | Install consumes the reviewed selection through the Backend Job boundary | ac59d75f |
| `catalog:clear-selection` | `retired` | `POST /catalog/clear-selection` | `src/main/ipc.js` | Pending selection lifecycle is owned by the Backend Catalog bridge | ac59d75f |
| `catalog:add-blocklist` | `retired` | `POST /catalog/blocklist` | `src/main/ipc.js` | Catalog blocklist mutation is handled by the Backend Catalog domain | ac59d75f |
| `catalog:remove-blocklist` | `retired` | `DELETE /catalog/blocklist/:id` | `src/main/ipc.js` | Catalog blocklist removal is handled by the Backend Catalog domain | ac59d75f |

## Operating rules

- `npm run check:channel-retirement` 对当前 active 行与 TS 清单逐项对账；active 必须精确覆盖当前常量，历史 `retired` 行可以不再存在于当前源。
- 当前通道上限为 158，后续提交只能减少 active 数量；新增 IPC 常量必须先更新本台账和 T40 依据。
- `retired` 行必须保留原 channel、真实历史 source、删除提交的完整或短 SHA（至少 7 位）；它不计入 current、keep、cutover、blocked、dead 计数。
- `keep` 上限是 41。四个 QQ/WeCom host-secret 通道等待 T44 的 secrets 边界，不能借 `keep` 绕过上限。
- `cutover` 行在同一切换提交中完成 HTTP/SSE 接入、旧 IPC 删除和台账状态更新；不得先并行双写再补删除。

Refs #41
