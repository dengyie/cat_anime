const { sanitizeDiagnosticText } = require('./pet-chat-state')

const createPetUtteranceRecorder = ({
  petUtteranceLogService = null,
  getActivePetPackId,
  recordAppLog
}) => {
  const safeRecordAppLog = (entry) => {
    try {
      recordAppLog?.(entry)
    } catch (_) {
      // Logging must never break the product flow that triggered it.
    }
  }

  const recordPetUtterance = async (payload = {}) => {
    if (!petUtteranceLogService?.record) return null
    try {
      return await petUtteranceLogService.record({
        petPackId: getActivePetPackId(),
        text: payload.text || payload.message || '',
        source: payload.source || '',
        ttlMs: payload.ttlMs
      })
    } catch (error) {
      safeRecordAppLog({
        scope: 'pet-utterance',
        level: 'error',
        actor: 'system',
        event: 'pet-utterance.record.failed',
        message: 'Pet utterance recording failed',
        details: {
          errorName: sanitizeDiagnosticText(error?.name || 'Error'),
          errorMessage: sanitizeDiagnosticText(error?.message)
        }
      })
      return null
    }
  }

  return {
    recordPetUtterance
  }
}

module.exports = {
  createPetUtteranceRecorder
}
