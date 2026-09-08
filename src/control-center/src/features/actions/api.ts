import { z } from 'zod'
import { EVENT_ACTIONS_CHANGED, type Job } from '@openpet/contracts'
import { backendClient } from '../../api/backend-client.ts'
import type { ApiClient } from '../../api/client.ts'
import { controlCenterAPI } from '../../api/control-center-api.ts'
import type {
  ActionFrameClearRequest, ActionFrameImportRequest, ActionFrameImportResult,
  ActionFrameInspectRequest, ActionFrameInspectionResult, ActionFrameReinspectRequest,
  ActionsConfigViewState, ActionsMutationResult, ActionsSaveConfigRequest,
  ActionTriggerProposalAcceptanceRequest, ActionTriggerProposalPreviewResult,
  ActionTriggerRuleMutationResult, ActionTriggerRuleStatus, ActionTriggerRuleUpdateRequest,
} from '../../../../shared/openpet-contracts.ts'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const actionsSchema = z.custom<ActionsConfigViewState>((value) =>
  object(value) && typeof value.defaultAction === 'string' && typeof value.clickAction === 'string'
  && Array.isArray(value.actions) && value.actions.every((action) => object(action) && typeof action.id === 'string')
)
const mutationSchema = z.custom<ActionsMutationResult>((value) =>
  object(value) && actionsSchema.safeParse(value.animations).success
)
const ruleMutationSchema = z.custom<ActionTriggerRuleMutationResult>((value) =>
  mutationSchema.safeParse(value).success && object(value) && object(value.rule) && typeof value.rule.id === 'string'
)
const previewSchema = z.custom<ActionTriggerProposalPreviewResult>((value) =>
  object(value) && typeof value.ok === 'boolean' && typeof value.applied === 'boolean'
  && typeof value.actionId === 'string' && typeof value.code === 'string' && typeof value.message === 'string'
)
const inspectionSchema = z.custom<ActionFrameInspectionResult>((value) =>
  object(value) && (value.canceled === true || (
    value.canceled === false && typeof value.selectionId === 'string' && value.selectionId.length > 0
    && object(value.inspection) && typeof value.inspection.valid === 'boolean'
  ))
)
const importResultSchema = z.custom<ActionFrameImportResult>((value) => {
  if (!object(value)) return false
  if (value.canceled === true) return true
  if (value.ok === false) return inspectionSchema.safeParse(value.inspectionResult).success
  return value.ok === true && actionsSchema.safeParse(value.animations).success
    && object(value.result) && object(value.result.importedAction) && typeof value.result.importedAction.id === 'string'
})
const jobStartSchema = z.object({ jobId: z.string().min(1) })
const importRequestSchema = z.object({
  selectionId: z.string().min(1), actionId: z.string().min(1), label: z.string().optional(),
})
const selectionSchema = z.object({ selectionId: z.string().min(1), actionId: z.string().min(1) })

export type ActionImportStart = { jobId: string } | { result: ActionFrameImportResult }
export type ActionImportResolution =
  | { kind: 'pending' }
  | { kind: 'succeeded'; result: ActionFrameImportResult }
  | { kind: 'failed'; message: string }

export function nextActionsEventId(
  event: { lastEventId: string | null; lastEventName: string | null },
  lastHandledEventId: string | null,
): string | null {
  return event.lastEventName === EVENT_ACTIONS_CHANGED && event.lastEventId !== lastHandledEventId
    ? event.lastEventId : null
}

export function resolveActionImportJob(job: Job | null): ActionImportResolution {
  if (!job || job.status === 'queued' || job.status === 'running') return { kind: 'pending' }
  if (job.status === 'succeeded') {
    const parsed = importResultSchema.safeParse(job.result)
    return parsed.success ? { kind: 'succeeded', result: parsed.data }
      : { kind: 'failed', message: '动作导入返回结果不完整' }
  }
  return { kind: 'failed', message: job.error?.message || (job.status === 'canceled' ? '已取消导入' : '动作导入失败或被中断') }
}

export function createActionsHttpApi(client: ApiClient = backendClient) {
  const send = <T>(method: string, path: string, responseSchema: z.ZodType<T>, body?: unknown, job = false): Promise<T> =>
    body === undefined
      ? client.request({ method, path, responseSchema, retry: false })
      : client.request({ method, path, responseSchema, requestSchema: z.unknown(), body, job, retry: false })
  return {
    getActions: () => send('GET', '/actions', actionsSchema),
    saveActionsConfig: (input: ActionsSaveConfigRequest) => send('PUT', '/actions/config', mutationSchema, input),
    previewActionTriggerProposal: (input: ActionTriggerProposalAcceptanceRequest) => send('POST', '/actions/triggers/preview', previewSchema, input),
    submitActionTriggerProposal: (input: ActionTriggerProposalAcceptanceRequest) => send('POST', '/actions/triggers/proposals', mutationSchema, input),
    acceptActionTriggerProposal: (id: string) => send('POST', '/actions/triggers/proposals/' + encodeURIComponent(id) + '/accept', mutationSchema, {}),
    rejectActionTriggerProposal: (id: string, reason = '') => send('POST', '/actions/triggers/proposals/' + encodeURIComponent(id) + '/reject', mutationSchema, { reason }),
    setActionTriggerRuleStatus: (id: string, status: ActionTriggerRuleStatus) => send('PATCH', '/actions/triggers/rules/' + encodeURIComponent(id), ruleMutationSchema, { status }),
    updateActionTriggerRule: ({ ruleId, ...patch }: ActionTriggerRuleUpdateRequest) => send('PATCH', '/actions/triggers/rules/' + encodeURIComponent(ruleId), ruleMutationSchema, patch),
    deleteActionTriggerRule: (id: string) => send('DELETE', '/actions/triggers/rules/' + encodeURIComponent(id), ruleMutationSchema),
    reinspectActionFrames: (input: ActionFrameReinspectRequest) => send('POST', '/actions/frames/reinspect', inspectionSchema, selectionSchema.parse(input)),
    clearActionFrameSelection: ({ selectionId }: ActionFrameClearRequest) => send('DELETE', '/actions/frames/selection?selectionId=' + encodeURIComponent(selectionId), z.object({ ok: z.boolean() })),
    importActionFrames: (input: ActionFrameImportRequest) => send('POST', '/actions/frames/import', jobStartSchema, importRequestSchema.parse(input), true),
    deleteAction: (id: string) => send('DELETE', '/actions/' + encodeURIComponent(id), mutationSchema),
  }
}

const http = createActionsHttpApi()
const useDemoApi = () => import.meta.env?.DEV === true && !Boolean((globalThis as { openpetBackend?: unknown }).openpetBackend)

export const actionsHttpApi = {
  inspectActionFrames: (input: ActionFrameInspectRequest = {}) => controlCenterAPI.inspectActionFrames(input),
  getActions: () => useDemoApi() ? controlCenterAPI.getActions() : http.getActions(),
  saveActionsConfig: (input: ActionsSaveConfigRequest) => useDemoApi() ? controlCenterAPI.saveActionsConfig(input) : http.saveActionsConfig(input),
  previewActionTriggerProposal: (input: ActionTriggerProposalAcceptanceRequest) => useDemoApi() ? controlCenterAPI.previewActionTriggerProposal(input) : http.previewActionTriggerProposal(input),
  submitActionTriggerProposal: (input: ActionTriggerProposalAcceptanceRequest) => useDemoApi() ? controlCenterAPI.submitActionTriggerProposal(input) : http.submitActionTriggerProposal(input),
  acceptActionTriggerProposal: (id: string) => useDemoApi() ? controlCenterAPI.acceptActionTriggerProposal(id) : http.acceptActionTriggerProposal(id),
  rejectActionTriggerProposal: (id: string, reason = '') => useDemoApi() ? controlCenterAPI.rejectActionTriggerProposal(id, reason) : http.rejectActionTriggerProposal(id, reason),
  setActionTriggerRuleStatus: (id: string, status: ActionTriggerRuleStatus) => useDemoApi() ? controlCenterAPI.setActionTriggerRuleStatus(id, status) : http.setActionTriggerRuleStatus(id, status),
  updateActionTriggerRule: (input: ActionTriggerRuleUpdateRequest) => useDemoApi() ? controlCenterAPI.updateActionTriggerRule(input) : http.updateActionTriggerRule(input),
  deleteActionTriggerRule: (id: string) => useDemoApi() ? controlCenterAPI.deleteActionTriggerRule(id) : http.deleteActionTriggerRule(id),
  reinspectActionFrames: (input: ActionFrameReinspectRequest) => useDemoApi() ? controlCenterAPI.reinspectActionFrames(input) : http.reinspectActionFrames(input),
  clearActionFrameSelection: (input: ActionFrameClearRequest) => useDemoApi() ? controlCenterAPI.clearActionFrameSelection(input) : http.clearActionFrameSelection(input),
  importActionFrames: async (input: ActionFrameImportRequest): Promise<ActionImportStart> => useDemoApi()
    ? { result: await controlCenterAPI.importActionFrames(input) } : http.importActionFrames(input),
  deleteAction: (id: string) => useDemoApi() ? controlCenterAPI.deleteAction(id) : http.deleteAction(id),
}
