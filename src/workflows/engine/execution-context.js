const {
  joinContext,
  readAutoContext,
  readManualContext,
} = require('../../integrations/github/issue-plan')

const DEFAULT_OUTPUT_BUDGET_BYTES = 64000

/**
 * Workflow execution options that affect context and output budgeting.
 * @typedef {import('../../types').JsonMap & {
 *   outputBudget?: boolean,
 *   outputBudgetBytes?: number | string,
 *   context?: string,
 *   contextFile?: string,
 *   autoContext?: boolean,
 * }} ExecutionContextOptions
 *
 * Saved workflow step state used for source selection.
 * @typedef {import('../../types').WorkflowStep & {
 *   runs?: import('../../types').AgentRun[],
 * }} ExecutionStepState
 *
 * Workflow run state with optional saved context.
 * @typedef {import('../../types').WorkflowRunState & {
 *   context?: {
 *     combined?: string,
 *   },
 * }} ExecutionRunState
 */

/**
 * Parses a positive integer option with fallback.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Checks whether downstream-output budget guidance should be added.
 * @param {ExecutionContextOptions} [options]
 * @returns {boolean}
 */
function outputBudgetEnabled(options = {}) {
  if (options.outputBudget === true) return true
  if (options.outputBudget === false) return false
  const raw = String(process.env.NAX_OUTPUT_BUDGET || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  if (options.outputBudgetBytes || process.env.NAX_OUTPUT_BUDGET_BYTES) return true
  return false
}

/**
 * Resolves the downstream-output budget in bytes.
 * @param {ExecutionContextOptions} [options]
 * @returns {number}
 */
function outputBudgetBytes(options = {}) {
  return parsePositiveInteger(
    options.outputBudgetBytes || process.env.NAX_OUTPUT_BUDGET_BYTES,
    DEFAULT_OUTPUT_BUDGET_BYTES,
  )
}

/**
 * Builds the instruction block that caps agent output size for fan-in workflows.
 * @param {{ bytes?: number }} [input]
 * @returns {string}
 */
function buildOutputBudgetContext({ bytes = DEFAULT_OUTPUT_BUDGET_BYTES } = {}) {
  return [
    '## Output Budget',
    '',
    `Your response will be reused as input to later workflow steps. Keep the final answer concise and aim to stay under ${bytes.toLocaleString()} bytes.`,
    '',
    'Prioritize:',
    '',
    '1. Required structured JSON blocks, scores, rankings, and final recommendations.',
    '2. Concise evidence that changes downstream decisions.',
    '3. Links or references instead of repeated long prose when possible.',
    '',
    'Omit:',
    '',
    '- repeated repository state, git status, and architecture inventories',
    '- prompt recaps, methodology narration, and generic preamble',
    '- long file lists unless they directly affect the result',
    '- duplicate rationale already captured in structured output',
  ].join('\n')
}

/**
 * Determines if output-budget context applies to the current step.
 * @param {{
 *   options?: ExecutionContextOptions,
 *   hasPriorResults?: boolean,
 *   hasFutureSteps?: boolean,
 * }} [input]
 * @returns {boolean}
 */
function shouldApplyOutputBudget({ options = {}, hasPriorResults = false, hasFutureSteps = false } = {}) {
  return outputBudgetEnabled(options) && (hasPriorResults || hasFutureSteps)
}

/**
 * Appends output-budget context when a step feeds later agents.
 * @param {string} context
 * @param {ExecutionContextOptions} [options]
 * @param {{ hasPriorResults?: boolean, hasFutureSteps?: boolean }} [details]
 * @returns {string}
 */
function contextWithOutputBudget(context, options = {}, details = {}) {
  if (!shouldApplyOutputBudget({ options, ...details })) return context || ''
  return joinContext(context, buildOutputBudgetContext({ bytes: outputBudgetBytes(options) }))
}

/**
 * Extracts saved manual/automatic context from a prior prompt.
 * @param {unknown} promptText
 * @returns {string}
 */
function extractSavedContextFromPrompt(promptText) {
  const marker = '\n## Additional Context\n\n'
  const index = String(promptText || '').lastIndexOf(marker)
  if (index === -1) return ''
  return String(promptText).slice(index + marker.length).trim()
}

/**
 * Resolves the workflow context from saved state or current options.
 * @param {ExecutionRunState} runState
 * @param {ExecutionContextOptions} options
 * @returns {string}
 */
function contextForRunState(runState, options) {
  if (runState.context?.combined) return runState.context.combined
  for (const step of runState.steps || []) {
    for (const run of step.runs || []) {
      const saved = extractSavedContextFromPrompt(run.promptText)
      if (saved) return saved
    }
  }
  return joinContext(readAutoContext(options), readManualContext(options))
}

/**
 * Builds a map of completed or dry-run step states by id.
 * @param {ExecutionRunState} runState
 * @returns {Map<string, ExecutionStepState>}
 */
function completedStepMapFromRunState(runState) {
  const completed = new Map()
  for (const step of runState.steps || []) {
    if (step.status === 'completed' || step.status === 'dry-run') {
      completed.set(step.id, step)
    }
  }
  return completed
}

/**
 * Finds the first flow step that still needs work.
 * @param {import('../../types').WorkflowFlow} flow
 * @param {ExecutionRunState} runState
 * @returns {number}
 */
function firstRunnableStepIndex(flow, runState) {
  const byId = new Map((runState.steps || []).map((step) => [step.id, step]))
  for (let index = 0; index < flow.steps.length; index += 1) {
    const saved = byId.get(flow.steps[index].id)
    if (!saved || saved.status !== 'completed' && saved.status !== 'dry-run') return index
  }
  return flow.steps.length
}

/**
 * Returns finite GitHub issue numbers from one saved step.
 * @param {ExecutionStepState} [stepState]
 * @returns {number[]}
 */
function issueNumbersFromStep(stepState) {
  return (stepState?.runs || [])
    .map((run) => run.issueNumber)
    .filter((number) => Number.isFinite(number))
}

/**
 * Returns saved runs from one step.
 * @param {ExecutionStepState} [stepState]
 * @returns {import('../../types').AgentRun[]}
 */
function runsFromStep(stepState) {
  return Array.isArray(stepState?.runs) ? stepState.runs : []
}

/**
 * Deduplicates finite numbers while preserving order.
 * @param {number[]} numbers
 * @returns {number[]}
 */
function uniqueNumbers(numbers) {
  return [...new Set(numbers.filter((number) => Number.isFinite(number)))]
}

/**
 * Resolves source issue numbers requested by a workflow step.
 * @param {import('../../types').WorkflowStep} step
 * @param {Map<string, ExecutionStepState>} completedStepStates
 * @returns {number[]}
 */
function sourceIssueNumbersForStep(step, completedStepStates) {
  if (!Array.isArray(step.input)) return []
  const numbers = []
  for (const input of step.input) {
    numbers.push(...issueNumbersFromStep(completedStepStates.get(input.step)))
  }
  return uniqueNumbers(numbers)
}

/**
 * Resolves source local runs requested by a workflow step.
 * @param {import('../../types').WorkflowStep} step
 * @param {Map<string, ExecutionStepState>} completedStepStates
 * @returns {import('../../types').AgentRun[]}
 */
function sourceRunsForStep(step, completedStepStates) {
  if (!Array.isArray(step.input)) return []
  const runs = []
  for (const input of step.input) {
    const seen = new Set()
    for (const run of runsFromStep(completedStepStates.get(input.step))) {
      const runWithStepId = /** @type {import('../../types').AgentRun & { stepId?: string }} */ (run)
      const key = run.runnerId || `${run.agent}:${runWithStepId.stepId || input.step}:${runs.length}`
      if (seen.has(key)) continue
      seen.add(key)
      runs.push({ ...run, sourceStep: input.step })
    }
  }
  return runs
}

module.exports = {
  DEFAULT_OUTPUT_BUDGET_BYTES,
  buildOutputBudgetContext,
  completedStepMapFromRunState,
  contextForRunState,
  contextWithOutputBudget,
  extractSavedContextFromPrompt,
  firstRunnableStepIndex,
  issueNumbersFromStep,
  outputBudgetBytes,
  outputBudgetEnabled,
  parsePositiveInteger,
  runsFromStep,
  shouldApplyOutputBudget,
  sourceIssueNumbersForStep,
  sourceRunsForStep,
  uniqueNumbers,
}
