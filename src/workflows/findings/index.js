// Findings registry: maps declared findings adapters to their implementations.
// Adapter ids must match FINDINGS_ADAPTER_IDS in src/core/constants.js.
const { reviewConsensusAdapter } = require('./adapters/review-consensus')

/** @type {Record<string, typeof reviewConsensusAdapter>} */
const FINDINGS_ADAPTERS = {
  'review-consensus': reviewConsensusAdapter,
}

module.exports = {
  FINDINGS_ADAPTERS,
}
