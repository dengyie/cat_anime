import { requestBackend } from '../../hooks/useSse.ts'
import { controlCenterAPI } from '../../api/control-center-api.ts'

type ActionResponse = { data?: any }
const data = (response: ActionResponse) => response?.data ?? response
const unwrapAnimations = (value: any) => ({ animations: value?.animations ?? value })

const selectionPaths = new Map<string, string>()
const hasBackend = () => Boolean(
  (globalThis as { openpetBackend?: { getBackend?: () => unknown } }).openpetBackend?.getBackend?.()
  || (globalThis as { window?: { controlCenterAPI?: unknown } }).window?.controlCenterAPI
)
const demo = (method: keyof typeof controlCenterAPI, ...args: any[]): Promise<any> =>
  (controlCenterAPI[method] as (...values: any[]) => Promise<any>)(...args)

export const actionsHttpApi = {
  async getActions() {
    if (!hasBackend()) return demo('getActions')
    return data(await requestBackend('/actions'))
  },
  async saveActionsConfig(patch: Record<string, unknown>): Promise<any> {
    if (!hasBackend()) return demo('saveActionsConfig', patch)
    const result = data(await requestBackend('/actions/config', { method: 'PUT', body: JSON.stringify(patch), headers: { 'content-type': 'application/json' } }))
    return { ...unwrapAnimations(result), ...result }
  },
  async previewActionTriggerProposal(input: Record<string, unknown>) {
    if (!hasBackend()) return demo('previewActionTriggerProposal', input as any)
    return data(await requestBackend('/actions/triggers/preview', { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }))
  },
  async submitActionTriggerProposal(input: Record<string, unknown>) {
    if (!hasBackend()) return demo('submitActionTriggerProposal', input as any)
    return data(await requestBackend('/actions/triggers/proposals', { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }))
  },
  async acceptActionTriggerProposal(proposalId: string) {
    if (!hasBackend()) return demo('acceptActionTriggerProposal', proposalId)
    return data(await requestBackend(`/actions/triggers/proposals/${encodeURIComponent(proposalId)}/accept`, { method: 'POST' }))
  },
  async rejectActionTriggerProposal(proposalId: string, reason = '') {
    if (!hasBackend()) return demo('rejectActionTriggerProposal', proposalId, reason)
    return data(await requestBackend(`/actions/triggers/proposals/${encodeURIComponent(proposalId)}/reject`, { method: 'POST', body: JSON.stringify({ reason }), headers: { 'content-type': 'application/json' } }))
  },
  async setActionTriggerRuleStatus(ruleId: string, status: string) {
    if (!hasBackend()) return demo('setActionTriggerRuleStatus', ruleId, status as any)
    return data(await requestBackend(`/actions/triggers/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: JSON.stringify({ status }), headers: { 'content-type': 'application/json' } }))
  },
  async updateActionTriggerRule(payload: any) {
    if (!hasBackend()) return demo('updateActionTriggerRule', payload)
    const { ruleId, ...body } = payload
    return data(await requestBackend(`/actions/triggers/rules/${encodeURIComponent(String(ruleId))}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
  },
  async deleteActionTriggerRule(ruleId: string) {
    if (!hasBackend()) return demo('deleteActionTriggerRule', ruleId)
    return data(await requestBackend(`/actions/triggers/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }))
  },
  async inspectActionFrames(input: { path?: string; actionId?: string } = {}) {
    if (!hasBackend()) return demo('inspectActionFrames', input)
    const result = data(await requestBackend('/actions/frames/inspect', { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }))
    if (result?.path) {
      const selectionId = `actions:${Date.now()}`
      selectionPaths.set(selectionId, result.path)
      return { ...result, selectionId }
    }
    return result
  },
  async reinspectActionFrames(input: { selectionId?: string; actionId?: string } = {}) {
    if (!hasBackend()) return demo('reinspectActionFrames', input)
    const path = input.selectionId ? selectionPaths.get(input.selectionId) : undefined
    return this.inspectActionFrames({ path, actionId: input.actionId })
  },
  async clearActionFrameSelection(input: { selectionId?: string } = {}) {
    if (!hasBackend()) return demo('clearActionFrameSelection', input as any)
    if (input.selectionId) selectionPaths.delete(input.selectionId)
    return data(await requestBackend('/actions/frames/selection', { method: 'DELETE' }))
  },
  async importActionFrames(input: { path?: string; selectionId?: string; actionId?: string; label?: string } = {}) {
    if (!hasBackend()) return demo('importActionFrames', input)
    const path = input.path ?? (input.selectionId ? selectionPaths.get(input.selectionId) : undefined)
    const result = data(await requestBackend('/actions/frames/import', { method: 'POST', body: JSON.stringify({ path, actionId: input.actionId, label: input.label }), headers: { 'content-type': 'application/json' } }))
    return { ...result, ok: true, canceled: false }
  },
  async deleteAction(actionId: string) {
    if (!hasBackend()) return demo('deleteAction', actionId)
    return unwrapAnimations(data(await requestBackend(`/actions/${encodeURIComponent(actionId)}`, { method: 'DELETE' })))
  },
}
