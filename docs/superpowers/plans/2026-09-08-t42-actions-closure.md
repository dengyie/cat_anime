# T42 Actions Closure Implementation Plan

> **For agentic workers:** Use the available executing-plans workflow task by task. The canonical backlog remains GitHub #41; this document defines the T42 implementation and verification only.

**Goal:** Complete the Actions HTTP/SSE/Job cutover without changing active-pet ownership or losing desktop behavior.

**Architecture:** Backend owns authenticated HTTP requests and Job state. A typed `actions.request` / `actions.result` reverse bridge executes existing Actions operations through the Shell's injected ActionService, ActionImportService and PetService. The native directory picker retains its IPC entry and opaque selection handle; all business calls use HTTP. Import reaches Shell only after the runner enters `finalizing`.

**Tech Stack:** Electron, Node HTTP, npm workspaces, TypeScript contracts, React, Node native test runner, Playwright.

## Global Constraints

- Develop in `codex/issue41-t42-closure`; primary `main` remains protected.
- Preserve `cat_anime/` material structure and `PetService` as pet-state authority.
- Do not modify `001_init.sql` or introduce a second Actions configuration writer.
- Keep credentials out of renderers, persisted Jobs and ordinary plugins.
- Retain the native Actions directory picker; retire only equivalent business IPC.
- Preserve diagnostics, proposal results, active-pack persistence, animation broadcasts and chat refreshes.
- T43's threshold only decreases after measured retirement; no cosmetic gate bypass.

## Task 1: Prove and repair the authority boundary

**Files:** `tests/backend/actions-cutover.test.js`, `services/backend/domains/actions.js`, `services/backend/routes/actions.js`, `services/backend/index.js`, `packages/contracts/src/bridge.ts`, `apps/desktop/src/sidecar/{message-handler,runtime-coordinator}.js`, `src/main/ipc/actions-sidecar-bridge.js`, `src/main/ipc.js`, `src/main/bootstrap/create-openpet-runtime.js`.

**Interfaces:** `createActionService({ shell, jobs, emit })` exposes `list`, `updateConfig`, proposal/rule methods, selection methods, and `runImportFrames({ selectionId, actionId, label, signal, report, finalize })`. Shell receives `{ type: 'actions.request', operation, payload }` and returns a correlated `{ type: 'actions.result', operation, ok, result|error }`. Its operation list is exported by `@openpet/contracts` and validated before dispatch.

- [x] Add failing Node tests that compare the backend result to the supplied active Shell snapshot, preserve opaque selection handles, reject wrong operation responses, and assert `finalize` precedes import.
- [x] Run `node --test tests/backend/actions-cutover.test.js`; capture the expected failures before implementation.
- [x] Replace local legacy-file writes with correlated authority requests. Route handlers await results. Wire `shell` and the runner's `finalize` callback into production assembly.
- [x] Move existing Actions handler behavior into a Shell bridge helper, retaining response adapters, native selection state, animation broadcasts, trigger refreshes and chat refresh after deletion.
- [x] Re-run focused backend, bridge and Shell tests. Verify malformed messages cannot dispatch an operation and a failed authority request produces an API error.

The central behavioral assertion is:

```js
assert.deepEqual(await actions.list(), activeShellView)
await actions.runImportFrames({ selectionId: 'selection-1', actionId: 'wave', finalize })
assert.deepEqual(events, ['finalizing', 'shell-import'])
```

## Task 2: Complete the frontend Job flow

**Files:** `src/control-center/src/features/actions/api.ts`, `src/control-center/src/hooks/useActionsPane.ts`, `tests/control-center/actions-cutover.test.js`, relevant Playwright smoke coverage, `control-center-preload.js`, `src/shared/ipc-channels.{ts,js}`.

**Interfaces:** Initial inspection returns the Shell's `selectionId`; the renderer never invents or resolves source paths. `importActionFrames` returns a Job start in desktop mode and a completed result only for the existing demo mode. `useJob(jobId)` supplies completion/cancellation/error state. `pet.actions-changed` refreshes the visible Actions snapshot.

- [x] Add tests for selectionId propagation, queued-versus-terminal import results, failed Jobs and duplicate SSE refresh suppression.
- [x] Use the existing typed backend client and shared DTOs, with no `any` response coercion or optimistic success on `202`.
- [x] Keep the import UI busy until terminal Job evidence, then update the selected action and clear the selection only on success.
- [x] Restore the native inspect IPC entry; preserve deleted diagnostics coverage through the new bridge rather than removing the specification.

## Task 3: Verify, record and integrate

**Files:** `docs/refactor/{03-api-contract,09-repo-state,15-channel-retirement}.md` and this execution record. GitHub #41 remains the single task board.

- [x] Run `npm run build:contracts`, `npm run test:backend`, `npm run test:core:all`, `npm test`, `npm run check:syntax`, `npm run check:api-contract`, `npm run check:channel-retirement`, `npm run check:preload-size`, `npm run check:docs-drift`, and `git diff --check`.
- [x] Record actual channel count, preload bytes, test output and unresolved manual evidence.
- [ ] Rebase onto fresh `origin/main`, repeat checks affected by any conflict resolution, create the T42 PR with `Refs #41`, verify remote checks and merge.
- [ ] Update #41 with the integrated SHA and exact verification evidence. T43 and T47–T50 continue under their existing task cards.

## Verification record — 2026-09-08

- New authority tests: 3 failures / 1 pass before implementation, then 4/4 pass. Additional malformed-response and pack-change tests captured expected failures before fixing them.
- Frontend regression tests: 5 failures before implementation, then 5/5 pass. Browser Job success/failure/cancellation: 3/3 pass.
- `npm test`: 3,025 passed, 0 failed, 1 existing skip. Restored all three Actions test groups the earlier local branch had skipped.
- `test:backend`: 277/277; `test:control-center`: 80/80; `check:syntax`, typecheck, API contract, channel retirement, preload, docs drift and diff whitespace checks pass. The complete Node run includes the core suite; the separate full browser run completes core:all coverage.
- Actual Actions runner verifies finalizing before host dispatch and cancellation refusal with JOB_NOT_CANCELABLE / 423.
- IPC: 140 → 128 (−12); preload: 19,495 → 17,475 bytes (−2,020). Native inspector retained.
- T43 remains pending: 17,475 bytes is above 10 KiB. All account, signing, packaged/manual release evidence remains unclaimed.
