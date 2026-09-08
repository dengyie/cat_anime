import { useCallback, useEffect, useRef, useState } from 'react'
import { actionsHttpApi, nextActionsEventId, resolveActionImportJob } from '../features/actions/api.ts'
import { nextPetPackActivationEventId, petPackApi, resolvePetPackJob, type PetPackJobKind } from '../features/pet-packs/api.ts'
import { useJob } from './useJob.ts'
import { useSse } from './useSse.ts'
import { cloneActionsConfig, clonePetPacks, defaultActionsConfig, defaultPetPacks } from '../lib/defaults'
import { messageFromError } from '../lib/errors'
import type {
  ActionFrameImportResult,
  ActionTriggerProposalAcceptanceResult,
  ActionTriggerProposalPreviewResult,
  ActionTriggerRuleStatus,
  ActionTriggerRuleUpdateRequest,
  ActionTriggerProposalType,
  ActionsConfigViewState,
  CompletedActionFrameInspectionResult,
  PetPackExportResult,
  PetPackInspectionResult,
  PetPackMutationResult,
  PetPacksViewState
} from '../../../shared/openpet-contracts'
import type { ActionImportDraft, ActionsPaneProps } from '../panes/ActionsPane'

export function useActionsPane() {
  const [loading, setLoading] = useState(true)
  const [actionsConfig, setActionsConfig] = useState<ActionsConfigViewState>(defaultActionsConfig)
  const [petPacks, setPetPacks] = useState<PetPacksViewState>(defaultPetPacks)
  const [petPackInspection, setPetPackInspection] = useState<PetPackInspectionResult | null>(null)
  const [selectedActionId, setSelectedActionId] = useState('')
  const [importDraft, setImportDraft] = useState<ActionImportDraft>({ actionId: '', label: '' })
  const [importInspection, setImportInspection] = useState<CompletedActionFrameInspectionResult | null>(null)
  const [triggerProposalType, setTriggerProposalType] = useState<ActionTriggerProposalType>('click')
  const [triggerProposalNotes, setTriggerProposalNotes] = useState('')
  const [triggerProposalPreview, setTriggerProposalPreview] = useState<ActionTriggerProposalPreviewResult | null>(null)
  const [lastTriggerProposalResult, setLastTriggerProposalResult] = useState<ActionTriggerProposalAcceptanceResult | null>(null)
  const [status, setStatus] = useState('')
  const [working, setWorking] = useState(false)
  const [petPackJobRequest, setPetPackJobRequest] = useState<{ jobId: string; kind: PetPackJobKind; packId?: string } | null>(null)
  const { job: petPackJob } = useJob(petPackJobRequest?.jobId || null)
  const [actionImportRequest, setActionImportRequest] = useState<{ jobId: string; actionId: string } | null>(null)
  const { job: actionImportJob } = useJob(actionImportRequest?.jobId || null)
  const petPackEvents = useSse(['pet'])
  const lastHandledPetPackEventIdRef = useRef<string | null>(null)
  const lastHandledActionsEventIdRef = useRef<string | null>(null)

  const finishActionImport = useCallback((response: ActionFrameImportResult, actionId: string) => {
    if (response.ok === false) {
      if (response.inspectionResult && !response.inspectionResult.canceled) setImportInspection(response.inspectionResult)
      setStatus('帧文件夹需要修正')
    } else if (response.canceled) {
      setStatus('已取消导入')
    } else if (response.animations && response.result?.importedAction) {
      setActionsConfig(cloneActionsConfig(response.animations))
      setSelectedActionId(response.result.importedAction.id || actionId)
      setImportInspection(null)
      setStatus(`已导入 ${response.result.importedAction.label || actionId}`)
    } else {
      setStatus('导入返回结果不完整')
    }
  }, [])

  useEffect(() => {
    let mounted = true
    Promise.all([
      actionsHttpApi.getActions(),
      petPackApi.list()
    ]).then(([loadedActions, loadedPetPacks]) => {
      if (!mounted) return
      setActionsConfig(cloneActionsConfig(loadedActions))
      setPetPacks(clonePetPacks(loadedPetPacks))
      setLoading(false)
    }).catch((error) => {
      if (!mounted) return
      setStatus(messageFromError(error, '动作与 Pet pack 加载失败'))
      setLoading(false)
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const eventId = nextPetPackActivationEventId(petPackEvents, lastHandledPetPackEventIdRef.current)
    if (!eventId) return
    lastHandledPetPackEventIdRef.current = eventId
    let mounted = true
    Promise.all([actionsHttpApi.getActions(), petPackApi.list()]).then(([loadedActions, loadedPetPacks]) => {
      if (!mounted) return
      setActionsConfig(cloneActionsConfig(loadedActions))
      setPetPacks(clonePetPacks(loadedPetPacks))
    }).catch((error) => {
      if (mounted) setStatus(messageFromError(error, 'Pet pack 事件刷新失败'))
    })
    return () => { mounted = false }
  }, [petPackEvents.lastEventId, petPackEvents.lastEventName])

  useEffect(() => {
    const eventId = nextActionsEventId(petPackEvents, lastHandledActionsEventIdRef.current)
    if (!eventId) return
    lastHandledActionsEventIdRef.current = eventId
    let mounted = true
    actionsHttpApi.getActions().then((actions) => {
      if (mounted) setActionsConfig(cloneActionsConfig(actions))
    }).catch((error) => {
      if (mounted) setStatus(messageFromError(error, '动作事件刷新失败'))
    })
    return () => { mounted = false }
  }, [petPackEvents.lastEventId, petPackEvents.lastEventName])

  useEffect(() => {
    if (!actionImportRequest || !actionImportJob || actionImportJob.jobId !== actionImportRequest.jobId) return
    const resolved = resolveActionImportJob(actionImportJob)
    if (resolved.kind === 'pending') {
      setStatus(actionImportJob.progress?.message || '正在导入动作…')
      return
    }
    if (resolved.kind === 'failed') setStatus(resolved.message)
    else finishActionImport(resolved.result, actionImportRequest.actionId)
    setActionImportRequest(null)
    setWorking(false)
  }, [actionImportJob, actionImportRequest, finishActionImport])

  useEffect(() => {
    if (!petPackJobRequest || !petPackJob || petPackJob.jobId !== petPackJobRequest.jobId) return
    const resolved = resolvePetPackJob(petPackJob, petPackJobRequest.kind)
    if (resolved.kind === 'pending') return
    if (resolved.kind === 'failed') {
      setStatus(resolved.message)
    } else if (petPackJobRequest.kind === 'import') {
      const result = resolved.result as PetPackMutationResult
      setPetPacks(clonePetPacks(result.petPacks))
      if (result.animations) setActionsConfig(cloneActionsConfig(result.animations))
      setPetPackInspection(null)
      setStatus(`已导入 ${result.pack?.displayName || result.pack?.id || 'Pet pack'}`)
    } else {
      const result = resolved.result as PetPackExportResult
      setStatus(result.canceled ? '已取消导出' : `已导出 ${result.fileName || petPackJobRequest.packId || 'Pet pack'}`)
    }
    setPetPackJobRequest(null)
    setWorking(false)
  }, [petPackJob, petPackJobRequest])

  useEffect(() => {
    if (actionsConfig.actions.some((action) => action.id === selectedActionId)) return
    setSelectedActionId(actionsConfig.defaultAction || actionsConfig.actions[0]?.id || '')
  }, [actionsConfig, selectedActionId])

  useEffect(() => {
    const actionId = selectedActionId || actionsConfig.defaultAction || actionsConfig.actions[0]?.id || ''
    if (!actionId) {
      setTriggerProposalPreview(null)
      return undefined
    }
    let canceled = false
    actionsHttpApi.previewActionTriggerProposal({
      actionId,
      type: triggerProposalType,
      binding: triggerProposalType === 'click' ? 'clickAction' : undefined,
      notes: triggerProposalNotes.trim() || undefined
    }).then((preview) => {
      if (!canceled) setTriggerProposalPreview(preview)
    }).catch(() => {
      if (!canceled) setTriggerProposalPreview(null)
    })
    return () => { canceled = true }
  }, [actionsConfig, selectedActionId, triggerProposalType, triggerProposalNotes])

  const onChangeImportDraft = (partial: Partial<ActionImportDraft>, clearInspection = false) => {
    setImportDraft({ ...importDraft, ...partial })
    if (status) setStatus('')
    if (clearInspection && importInspection?.selectionId) {
      actionsHttpApi.clearActionFrameSelection({ selectionId: importInspection.selectionId }).catch(() => {})
      setImportInspection(null)
    }
  }

  const onSelectAction = (actionId: string) => {
    setSelectedActionId(actionId)
    setLastTriggerProposalResult(null)
  }

  const onChangeTriggerProposalType = (value: ActionTriggerProposalType) => {
    setTriggerProposalType(value)
    setLastTriggerProposalResult(null)
  }

  const onChangeTriggerProposalNotes = (value: string) => {
    setTriggerProposalNotes(value)
    setLastTriggerProposalResult(null)
  }

  const onSaveConfig = async () => {
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.saveActionsConfig({
        defaultAction: actionsConfig.defaultAction,
        clickAction: actionsConfig.clickAction
      })
      setActionsConfig(cloneActionsConfig(response.animations))
      setStatus('动作配置已保存')
    } catch (error) {
      setStatus(messageFromError(error, '保存失败'))
    } finally {
      setWorking(false)
    }
  }

  const onApplyTriggerProposal = async () => {
    const actionId = selectedActionId || actionsConfig.defaultAction || actionsConfig.actions[0]?.id || ''
    if (!actionId) {
      setStatus('请先选择一个动作')
      return
    }
    setWorking(true)
    setStatus('')
    setLastTriggerProposalResult(null)
    try {
      const response = await actionsHttpApi.saveActionsConfig({
        triggerProposal: {
          actionId,
          type: triggerProposalType,
          binding: triggerProposalType === 'click' ? 'clickAction' : undefined,
          notes: triggerProposalNotes.trim() || undefined
        }
      })
      setActionsConfig(cloneActionsConfig(response.animations))
      const triggerProposal = response.triggerProposal
      setLastTriggerProposalResult(triggerProposal || null)
      setStatus(triggerProposal
        ? `${triggerProposal.applied ? '已应用' : '已确认'} 触发建议：${triggerProposal.message}`
        : '触发建议已保存')
    } catch (error) {
      setStatus(messageFromError(error, '应用触发建议失败'))
    } finally {
      setWorking(false)
    }
  }

  const onAcceptTriggerProposal = async (proposalId: string) => {
    if (!proposalId) return
    setWorking(true)
    setStatus('')
    setLastTriggerProposalResult(null)
    try {
      const response = await actionsHttpApi.acceptActionTriggerProposal(proposalId)
      setActionsConfig(cloneActionsConfig(response.animations))
      setLastTriggerProposalResult(response.triggerProposal || null)
      const proposal = response.proposal
      const actionLabel = proposal?.actionId || proposalId
      const outcome = proposal?.status === 'applied'
        ? '已应用'
        : (proposal?.status === 'pending-host-rule' ? '已标记待规则' : '已接受')
      setStatus(`${outcome}触发提案：${actionLabel}`)
    } catch (error) {
      setStatus(messageFromError(error, '接受触发提案失败'))
    } finally {
      setWorking(false)
    }
  }

  const onRejectTriggerProposal = async (proposalId: string) => {
    if (!proposalId) return
    const reason = window.prompt('拒绝原因（可选）', '') || ''
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.rejectActionTriggerProposal(proposalId, reason.trim())
      setActionsConfig(cloneActionsConfig(response.animations))
      setStatus(`已拒绝触发提案：${response.proposal?.actionId || proposalId}`)
    } catch (error) {
      setStatus(messageFromError(error, '拒绝触发提案失败'))
    } finally {
      setWorking(false)
    }
  }

  const onSetTriggerRuleStatus = async (ruleId: string, status: ActionTriggerRuleStatus) => {
    if (!ruleId) return
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.setActionTriggerRuleStatus(ruleId, status)
      setActionsConfig(cloneActionsConfig(response.animations))
      setStatus(`${status === 'disabled' ? '已停用' : '已启用'}触发规则：${ruleId}`)
    } catch (error) {
      setStatus(messageFromError(error, '更新触发规则失败'))
    } finally {
      setWorking(false)
    }
  }

  const onDeleteTriggerRule = async (ruleId: string) => {
    if (!ruleId) return
    if (!window.confirm(`删除触发规则 ${ruleId}？`)) return
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.deleteActionTriggerRule(ruleId)
      setActionsConfig(cloneActionsConfig(response.animations))
      setStatus(`已删除触发规则：${ruleId}`)
    } catch (error) {
      setStatus(messageFromError(error, '删除触发规则失败'))
    } finally {
      setWorking(false)
    }
  }

  const onUpdateTriggerRule = async (payload: ActionTriggerRuleUpdateRequest) => {
    if (!payload.ruleId) return false
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.updateActionTriggerRule(payload)
      setActionsConfig(cloneActionsConfig(response.animations))
      setStatus(`已保存触发规则：${payload.ruleId}`)
      return true
    } catch (error) {
      setStatus(messageFromError(error, '保存触发规则失败'))
      return false
    } finally {
      setWorking(false)
    }
  }

  const onInspect = async () => {
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.inspectActionFrames({ actionId: importDraft.actionId.trim() })
      if (response.canceled) {
        setStatus('已取消选择')
      } else {
        setImportInspection(response)
        setStatus(response.inspection.valid ? '帧文件夹检查通过' : '帧文件夹需要修正')
      }
    } catch (error) {
      setImportInspection(null)
      setStatus(messageFromError(error, '检查失败'))
    } finally {
      setWorking(false)
    }
  }

  const onReinspect = async () => {
    if (!importInspection?.selectionId) return
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.reinspectActionFrames({
        selectionId: importInspection.selectionId,
        actionId: importDraft.actionId.trim()
      })
      if (response.canceled) {
        setImportInspection(null)
        setStatus('已取消选择')
        return
      }
      setImportInspection(response)
      setStatus(response.inspection.valid ? '帧文件夹检查通过' : '帧文件夹需要修正')
    } catch (error) {
      setImportInspection(null)
      setStatus(messageFromError(error, '重新检查失败'))
    } finally {
      setWorking(false)
    }
  }

  const onClearInspection = async () => {
    const selectionId = importInspection?.selectionId
    setImportInspection(null)
    setStatus('已清除选择')
    if (!selectionId) return
    try {
      await actionsHttpApi.clearActionFrameSelection({ selectionId })
    } catch (_) {}
  }

  const onImport = async () => {
    if (!importInspection?.selectionId) return
    const actionId = importDraft.actionId.trim()
    setWorking(true)
    setStatus('')
    try {
      const started = await actionsHttpApi.importActionFrames({
        selectionId: importInspection.selectionId,
        actionId,
        label: importDraft.label
      })
      if ('jobId' in started) {
        setActionImportRequest({ jobId: started.jobId, actionId })
        setStatus('正在导入动作…')
        return
      }
      finishActionImport(started.result, actionId)
    } catch (error) {
      setStatus(messageFromError(error, '导入失败'))
    }
    setWorking(false)
  }

  const onDelete = async (actionId: string) => {
    if (!window.confirm(`删除动作 ${actionId}？`)) return
    setWorking(true)
    setStatus('')
    try {
      const response = await actionsHttpApi.deleteAction(actionId)
      setActionsConfig(cloneActionsConfig(response.animations))
      setStatus(`已删除 ${actionId}`)
    } catch (error) {
      setStatus(messageFromError(error, '删除失败'))
    } finally {
      setWorking(false)
    }
  }

  const onInspectPetPack = async () => {
    setWorking(true)
    setStatus('')
    try {
      const response = await petPackApi.inspect()
      if (response.canceled) {
        setStatus('已取消选择')
      } else {
        setPetPackInspection(response)
        setStatus(response.valid ? 'Pet pack 检查通过' : 'Pet pack 需要修正')
      }
    } catch (error) {
      setPetPackInspection(null)
      setStatus(messageFromError(error, 'Pet pack 检查失败'))
    } finally {
      setWorking(false)
    }
  }

  const onClearPetPackInspection = async () => {
    const selectionId = petPackInspection?.selectionId
    setPetPackInspection(null)
    setStatus('已清除 Pet pack 选择')
    if (!selectionId) return
    try {
      await petPackApi.clearSelection(selectionId)
    } catch (_) {}
  }

  const onImportPetPack = async () => {
    if (!petPackInspection?.selectionId) return
    setWorking(true)
    setStatus('')
    setPetPackJobRequest(null)
    try {
      const started = await petPackApi.import(petPackInspection.selectionId)
      if ('jobId' in started) {
        setPetPackJobRequest({ jobId: started.jobId, kind: 'import' })
        return
      }
      setPetPacks(clonePetPacks(started.result.petPacks))
      if (started.result.animations) setActionsConfig(cloneActionsConfig(started.result.animations))
      setPetPackInspection(null)
      setStatus(`已导入 ${started.result.pack?.displayName || started.result.pack?.id || 'Pet pack'}`)
    } catch (error) {
      setStatus(messageFromError(error, 'Pet pack 导入失败'))
      setWorking(false)
    }
    setWorking(false)
  }

  const onExportPetPack = async (packId: string) => {
    setWorking(true)
    setStatus('')
    setPetPackJobRequest(null)
    try {
      const started = await petPackApi.export(packId)
      if ('jobId' in started) {
        setPetPackJobRequest({ jobId: started.jobId, kind: 'export', packId })
        return
      }
      if (started.result.canceled) {
        setStatus('已取消导出')
      } else {
        setStatus(`已导出 ${started.result.fileName || packId}`)
      }
    } catch (error) {
      setStatus(messageFromError(error, 'Pet pack 导出失败'))
      setWorking(false)
    }
    setWorking(false)
  }

  const onSetActivePetPack = async (packId: string) => {
    setWorking(true)
    setStatus('')
    try {
      const response = await petPackApi.activate(packId)
      setPetPacks(clonePetPacks(response.petPacks))
      setActionsConfig(cloneActionsConfig(response.animations))
      setStatus(`已启用 ${response.pack?.displayName || packId}`)
    } catch (error) {
      setStatus(messageFromError(error, 'Pet pack 启用失败'))
    } finally {
      setWorking(false)
    }
  }

  const onRemovePetPack = async (packId: string) => {
    if (!window.confirm(`删除 Pet pack ${packId}？`)) return
    setWorking(true)
    setStatus('')
    try {
      const response = await petPackApi.remove(packId)
      setPetPacks(clonePetPacks(response.petPacks))
      setStatus(`已删除 ${packId}`)
    } catch (error) {
      setStatus(messageFromError(error, 'Pet pack 删除失败'))
    } finally {
      setWorking(false)
    }
  }

  const paneProps = {
    actionsConfig,
    petPacks,
    selectedActionId,
    importDraft,
    importInspection,
    petPackInspection,
    status,
    working,
    onSelectAction,
    onChangeImportDraft,
    onChangeConfig: (partial: Partial<ActionsConfigViewState>) => setActionsConfig({ ...actionsConfig, ...partial }),
    onSaveConfig,
    onInspect,
    onReinspect,
    onClearInspection,
    onImport,
    onDelete,
    onInspectPetPack,
    onClearPetPackInspection,
    onImportPetPack,
    onExportPetPack,
    onSetActivePetPack,
    onRemovePetPack,
    onApplyTriggerProposal,
    onAcceptTriggerProposal,
    onRejectTriggerProposal,
    onSetTriggerRuleStatus,
    onUpdateTriggerRule,
    onDeleteTriggerRule,
    triggerProposalType,
    setTriggerProposalType: onChangeTriggerProposalType,
    triggerProposalNotes,
    setTriggerProposalNotes: onChangeTriggerProposalNotes,
    triggerProposalPreview,
    lastTriggerProposalResult
  } satisfies ActionsPaneProps

  return { loading, paneProps }
}
