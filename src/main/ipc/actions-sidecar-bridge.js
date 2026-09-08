const { randomUUID } = require('node:crypto')
const path = require('node:path')
const {
  createActionFrameImportResult,
  createActionTriggerProposalPreviewResult,
  createActionsMutationResult
} = require('../control-center-adapters')

// The Shell owns the active pack and opaque native selections. Backend Jobs
// schedule these operations but must never create a second action writer.
const createActionsSidecarBridge = ({
  actionService, actionImportService, petService, getPetWindow, getActivePackId = () => '',
  showOpenDialogForEvent, createActionsViewState, reloadAndSendAnimations,
  refreshTriggerRuleRuntime, recordAppLog
}) => {
  let pendingActionFrameSelection = null
  const createSelectionId = () => randomUUID()
  const getPendingActionFrameSelection = (selectionId) => {
    if (!pendingActionFrameSelection || pendingActionFrameSelection.id !== selectionId) {
      throw Object.assign(new Error('Selected frame folder is no longer available'), { code: 'NOT_FOUND' })
    }
    if (pendingActionFrameSelection.packId !== getActivePackId()) {
      throw Object.assign(new Error('Active pet pack changed; select the frame folder again'), { code: 'CONFLICT' })
    }
    return pendingActionFrameSelection
  }
  const inspectPendingActionFrameSelection = async ({ selectionId, actionId }) => {
    const selection = getPendingActionFrameSelection(selectionId)
    const result = await actionImportService.inspectActionFrames({ sourceDir: selection.sourceDir, actionId })
    return { canceled: false, selectionId: selection.id, ...result }
  }
  const operations = {
    get: async () => createActionsViewState(),
    'inspect': async (payload = {}, event = null) => {
      if (payload.path !== undefined && (typeof payload.path !== 'string' || !path.isAbsolute(payload.path))) throw Object.assign(new Error('Frame path must be absolute'), { code: 'VALIDATION_FAILED' })
      const selected = payload.path ? { canceled: false, filePaths: [payload.path] } : await showOpenDialogForEvent(event, {
        title: '选择动作帧文件夹',
        properties: ['openDirectory']
      })
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true }

      const selectionId = createSelectionId()
      const sourceDir = selected.filePaths[0]
      const packId = getActivePackId()
      const result = await actionImportService.inspectActionFrames({ sourceDir, actionId: payload.actionId })
      if (packId !== getActivePackId()) throw Object.assign(new Error('Active pet pack changed during inspection'), { code: 'CONFLICT' })
      pendingActionFrameSelection = { id: selectionId, sourceDir, packId }
      return { canceled: false, selectionId, ...result }
    },
    'reinspect': async (payload = {}, event = null) => {
      return inspectPendingActionFrameSelection({ selectionId: payload.selectionId, actionId: payload.actionId })
    },
    'clear-selection': async (payload = {}, event = null) => {
      if (!payload?.selectionId || pendingActionFrameSelection?.id === payload.selectionId) {
        pendingActionFrameSelection = null
      }
      return { ok: true }
    },
    'import': async (payload = {}, event = null) => {
      const selection = getPendingActionFrameSelection(payload.selectionId)
      const inspectionResult = await inspectPendingActionFrameSelection({ selectionId: payload.selectionId, actionId: payload.actionId })
      if (!inspectionResult.inspection.valid) {
        return createActionFrameImportResult({ ok: false, inspectionResult })
      }
      getPendingActionFrameSelection(payload.selectionId)

      const result = await actionImportService.importActionFrames({
        sourceDir: selection.sourceDir,
        actionId: payload.actionId,
        label: payload.label
      })
      if (pendingActionFrameSelection?.id === selection.id) pendingActionFrameSelection = null
      reloadAndSendAnimations(getPetWindow, petService)
      return createActionFrameImportResult(
        { ok: true, canceled: false, result },
        createActionsViewState()
      )
    },
    'save-config': async (payload = {}, event = null) => {
      if (payload?.triggerProposal) {
        if (!actionService?.acceptTriggerProposal) throw new Error('Action trigger proposal acceptance is not available')
        const triggerProposal = actionService.acceptTriggerProposal(payload.triggerProposal)
        const animations = triggerProposal.applied
          ? reloadAndSendAnimations(getPetWindow, petService)
          : petService.getPreviewAnimations()
        if (triggerProposal.applied) refreshTriggerRuleRuntime()
        recordAppLog({
          scope: 'actions',
          level: 'info',
          actor: 'user',
          event: 'actions.trigger-proposal.accepted',
          message: 'Action trigger proposal accepted',
          details: {
            actionId: triggerProposal.actionId,
            type: triggerProposal.type,
            binding: triggerProposal.binding,
            applied: triggerProposal.applied,
            code: triggerProposal.code,
            sourcePluginId: triggerProposal.sourcePluginId || '',
            sourceRunId: triggerProposal.sourceRunId || '',
            sourceCommandId: triggerProposal.sourceCommandId || ''
          }
        })
        return createActionsMutationResult(createActionsViewState(animations), { triggerProposal })
      }
      if (!actionService?.applyCreatorActionMutation) throw new Error('Action config persistence is not available')
      actionService.applyCreatorActionMutation(payload)
      const animations = reloadAndSendAnimations(getPetWindow, petService)
      refreshTriggerRuleRuntime()
      return createActionsMutationResult(createActionsViewState(animations))
    },
    'preview-proposal': async (payload = {}, event = null) => {
      if (!actionService?.previewTriggerProposal) throw new Error('Action trigger proposal preview is not available')
      const triggerProposal = actionService.previewTriggerProposal(payload)
      return createActionTriggerProposalPreviewResult(triggerProposal)
    },
    'submit-proposal': async (payload = {}, event = null) => {
      if (!actionService?.submitTriggerProposal) throw new Error('Action trigger proposal inbox is not available')
      const result = actionService.submitTriggerProposal(payload)
      recordAppLog({
        scope: 'actions',
        level: 'info',
        actor: 'plugin',
        event: 'actions.trigger-proposal.submitted',
        message: 'Action trigger proposal submitted',
        details: {
          proposalId: result.proposal.id,
          actionId: result.proposal.actionId,
          type: result.proposal.type,
          sourcePluginId: result.proposal.sourcePluginId || '',
          sourceRunId: result.proposal.sourceRunId || '',
          sourceCommandId: result.proposal.sourceCommandId || ''
        }
      })
      return createActionsMutationResult(
        createActionsViewState(result.animations),
        { proposal: result.proposal }
      )
    },
    'accept-proposal': async (payload = {}, event = null) => {
      if (!actionService?.acceptTriggerProposalItem) throw new Error('Action trigger proposal inbox is not available')
      const result = actionService.acceptTriggerProposalItem(payload?.proposalId)
      const animations = result.triggerProposal?.applied
        ? reloadAndSendAnimations(getPetWindow, petService)
        : result.animations
      if (result.triggerProposal?.applied) refreshTriggerRuleRuntime()
      recordAppLog({
        scope: 'actions',
        level: 'info',
        actor: 'user',
        event: 'actions.trigger-proposal.inbox.accepted',
        message: 'Action trigger proposal accepted from inbox',
        details: {
          proposalId: result.proposal.id,
          actionId: result.proposal.actionId,
          type: result.proposal.type,
          applied: Boolean(result.triggerProposal?.applied),
          code: result.triggerProposal?.code || ''
        }
      })
      return createActionsMutationResult(
        createActionsViewState(animations),
        { proposal: result.proposal, triggerProposal: result.triggerProposal }
      )
    },
    'reject-proposal': async (payload = {}, event = null) => {
      if (!actionService?.rejectTriggerProposalItem) throw new Error('Action trigger proposal inbox is not available')
      const result = actionService.rejectTriggerProposalItem(payload?.proposalId, payload?.reason)
      recordAppLog({
        scope: 'actions',
        level: 'info',
        actor: 'user',
        event: 'actions.trigger-proposal.inbox.rejected',
        message: 'Action trigger proposal rejected from inbox',
        details: {
          proposalId: result.proposal.id,
          actionId: result.proposal.actionId,
          type: result.proposal.type
        }
      })
      return createActionsMutationResult(
        createActionsViewState(result.animations),
        { proposal: result.proposal }
      )
    },
    'update-rule': async (payload = {}, event = null) => {
      const supportsRuleUpdates = typeof actionService?.updateTriggerRule === 'function'
      const supportsStatusUpdates = typeof actionService?.setTriggerRuleStatus === 'function'
      if (!supportsRuleUpdates && !supportsStatusUpdates) throw new Error('Action trigger rule management is not available')
      const result = supportsRuleUpdates
        ? actionService.updateTriggerRule(payload?.ruleId, {
            ...(payload?.status !== undefined ? { status: payload.status } : {}),
            ...(payload?.ruleSpec && typeof payload.ruleSpec === 'object' ? { ruleSpec: payload.ruleSpec } : {})
          })
        : actionService.setTriggerRuleStatus(payload?.ruleId, payload?.status)
      recordAppLog({
        scope: 'actions',
        level: 'info',
        actor: 'user',
        event: 'actions.trigger-rule.updated',
        message: 'Action trigger rule status updated',
        details: {
          ruleId: result.rule.id,
          actionId: result.rule.actionId,
          type: result.rule.type,
          status: result.rule.status,
          updatedFields: [
            ...(payload?.status !== undefined ? ['status'] : []),
            ...(payload?.ruleSpec && typeof payload.ruleSpec === 'object' ? ['ruleSpec'] : [])
          ]
        }
      })
      refreshTriggerRuleRuntime()
      return {
        animations: createActionsViewState(result.animations),
        rule: result.rule
      }
    },
    'delete-rule': async (payload = {}, event = null) => {
      if (!actionService?.deleteTriggerRule) throw new Error('Action trigger rule management is not available')
      const result = actionService.deleteTriggerRule(payload?.ruleId)
      recordAppLog({
        scope: 'actions',
        level: 'info',
        actor: 'user',
        event: 'actions.trigger-rule.deleted',
        message: 'Action trigger rule deleted',
        details: {
          ruleId: result.rule.id,
          actionId: result.rule.actionId,
          type: result.rule.type,
          status: result.rule.status
        }
      })
      refreshTriggerRuleRuntime()
      return {
        animations: createActionsViewState(result.animations),
        rule: result.rule
      }
    },
    'remove': async (payload = {}, event = null) => {
      await actionImportService.deleteAction(payload.actionId)
      reloadAndSendAnimations(getPetWindow, petService)
      refreshTriggerRuleRuntime()
      return createActionsMutationResult(createActionsViewState())
    },
  }
  const handle = async ({ operation, payload = {} } = {}) => {
    if (!Object.hasOwn(operations, operation) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw Object.assign(new Error('Invalid Actions operation'), { code: 'VALIDATION_FAILED' })
    }
    try {
      return await operations[operation](payload)
    } catch (error) {
      if (typeof error?.code === 'string') throw error
      const message = String(error?.message || 'Actions operation failed')
      const code = /does not exist|not found|no longer available/i.test(message) ? 'NOT_FOUND'
        : /already exists|last action|read-only|not (?:pending|active)/i.test(message) ? 'CONFLICT'
        : /invalid|unsupported|required|must be|does not match/i.test(message) ? 'VALIDATION_FAILED' : 'INTERNAL'
      throw Object.assign(new Error(message, { cause: error }), { code })
    }
  }
  return { handle, inspect: (event, payload = {}) => operations.inspect(payload, event) }
}

module.exports = { createActionsSidecarBridge }
