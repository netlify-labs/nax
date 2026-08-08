/** @type {string[]} */
const DEFAULT_AGENT_PROVIDERS = ['claude', 'gemini', 'codex']
const DEFAULT_AGENT_CSV = DEFAULT_AGENT_PROVIDERS.join(',')
/** @type {string[]} */
const DEFAULT_FOLLOWUP_AGENTS = ['codex']
/** Maximum resolved agent instances allowed in one workflow step. */
const MAX_STEP_AGENT_INSTANCES = 4

/** @type {string[]} */
const TERMINAL_RUN_STATUS_VALUES = ['complete', 'completed', 'failed', 'timeout', 'cancelled', 'canceled', 'dry-run']
/** @type {string[]} */
const CANCELLED_RUN_STATUS_VALUES = ['cancelled', 'canceled']
/** @type {string[]} */
const FAILED_RUN_STATUS_VALUES = ['failed', 'timeout']

module.exports = {
  CANCELLED_RUN_STATUS_VALUES,
  DEFAULT_AGENT_CSV,
  DEFAULT_AGENT_PROVIDERS,
  DEFAULT_FOLLOWUP_AGENTS,
  FAILED_RUN_STATUS_VALUES,
  MAX_STEP_AGENT_INSTANCES,
  TERMINAL_RUN_STATUS_VALUES,
}
