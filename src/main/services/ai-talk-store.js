// Compatibility export for integrations and regression tests. Production AI
// engines are assembled only in the backend; Shell uses ai-sidecar-client.
module.exports = require('../../../services/backend/domains/ai/talk-store.js')
