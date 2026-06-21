/** @type {string[]} */
const DEFAULT_MODELS = ['claude', 'gemini', 'codex']
const DEFAULT_MODEL_CSV = DEFAULT_MODELS.join(',')
/** @type {string[]} */
const DEFAULT_FOLLOWUP_MODELS = ['codex']

/** @type {string[]} */
const TERMINAL_RUN_STATUS_VALUES = ['complete', 'completed', 'failed', 'timeout', 'cancelled', 'canceled', 'dry-run']
/** @type {string[]} */
const CANCELLED_RUN_STATUS_VALUES = ['cancelled', 'canceled']
/** @type {string[]} */
const FAILED_RUN_STATUS_VALUES = ['failed', 'timeout']

module.exports = {
  CANCELLED_RUN_STATUS_VALUES,
  DEFAULT_FOLLOWUP_MODELS,
  DEFAULT_MODEL_CSV,
  DEFAULT_MODELS,
  FAILED_RUN_STATUS_VALUES,
  TERMINAL_RUN_STATUS_VALUES,
}
