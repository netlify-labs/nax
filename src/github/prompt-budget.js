const { titleCase } = require('../prompts')

const GITHUB_ISSUE_BODY_LIMIT = 65536
const BODY_SAFETY_MARGIN = 536
const BODY_FALLBACK_THRESHOLD = GITHUB_ISSUE_BODY_LIMIT - BODY_SAFETY_MARGIN
const GITHUB_ACTION_TRIGGER_TEXT_WARNING_BYTES = 70 * 1024
const GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES = 80000
const GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX = 'TRIGGER_TEXT='

/**
 * GitHub issue or comment prompt payload measured before submission.
 * @typedef {{
 *   agent?: string,
 *   model?: string,
 *   promptName?: string,
 *   prompt?: string,
 *   issueTitle?: string,
 *   title?: string,
 *   body?: string,
 * }} GithubPromptBudgetIssue
 *
 * GitHub prompt plan containing issue/comment bodies to measure.
 * @typedef {{
 *   issues?: GithubPromptBudgetIssue[],
 * }} GithubPromptBudgetPlan
 *
 * Byte metrics for one GitHub Actions trigger text payload.
 * @typedef {{
 *   bodyChars: number,
 *   bodyBytes: number,
 *   envBytes: number,
 *   warningBytes: number,
 *   safeMaxBytes: number,
 * }} GithubPromptBudgetMetrics
 *
 * Labeled budget result for one issue/comment prompt.
 * @typedef {GithubPromptBudgetMetrics & {
 *   issue: GithubPromptBudgetIssue,
 *   label: string,
 * }} GithubPromptBudgetResult
 *
 * Budget enforcement result grouped by severity.
 * @typedef {{
 *   violations: GithubPromptBudgetResult[],
 *   warnings: GithubPromptBudgetResult[],
 * }} GithubPromptBudgetEnforcement
 *
 * Local prompt budget resolver used to cap GitHub prompt bytes.
 * @typedef {(options?: Record<string, unknown>) => number} LocalSafePromptBytes
 */

/** @param {unknown} value @returns {number} */
function utf8ByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8')
}

/** @param {string | null | undefined} body @returns {GithubPromptBudgetMetrics} */
function githubActionTriggerTextMetrics(body) {
  const bodyBytes = utf8ByteLength(body)
  return {
    bodyChars: String(body || '').length,
    bodyBytes,
    envBytes: utf8ByteLength(GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX) + bodyBytes,
    warningBytes: GITHUB_ACTION_TRIGGER_TEXT_WARNING_BYTES,
    safeMaxBytes: GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES,
  }
}

/** @param {GithubPromptBudgetIssue} issue @returns {string} */
function githubActionPromptBudgetLabel(issue) {
  const agent = issue.model || issue.agent || 'agent'
  const prompt = issue.promptName || issue.prompt || 'prompt'
  const title = issue.issueTitle || issue.title || ''
  return `${title ? `${title}: ` : ''}${titleCase(agent)} ${prompt}`
}

/** @param {GithubPromptBudgetPlan} plan @returns {GithubPromptBudgetResult[]} */
function githubActionPromptBudgetViolations(plan) {
  return (plan.issues || [])
    .map((issue) => ({
      issue,
      label: githubActionPromptBudgetLabel(issue),
      ...githubActionTriggerTextMetrics(issue.body),
    }))
    .filter((item) => item.envBytes > GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES)
}

/** @param {GithubPromptBudgetPlan} plan @returns {GithubPromptBudgetResult[]} */
function githubActionPromptBudgetWarnings(plan) {
  return (plan.issues || [])
    .map((issue) => ({
      issue,
      label: githubActionPromptBudgetLabel(issue),
      ...githubActionTriggerTextMetrics(issue.body),
    }))
    .filter((item) =>
      item.envBytes > GITHUB_ACTION_TRIGGER_TEXT_WARNING_BYTES
      && item.envBytes <= GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES)
}

/** @param {GithubPromptBudgetResult[]} violations @returns {string} */
function formatGithubActionPromptBudgetError(violations) {
  const lines = [
    'Prompt too large for GitHub Actions Agent Runner.',
    '',
    `Safe max: ${GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES.toLocaleString()} bytes for the estimated ${GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX} environment string.`,
    `Warning threshold: ${GITHUB_ACTION_TRIGGER_TEXT_WARNING_BYTES.toLocaleString()} bytes.`,
    '',
  ]
  for (const violation of violations) {
    lines.push(`${violation.label}:`)
    lines.push(`  Body: ${violation.bodyChars.toLocaleString()} chars / ${violation.bodyBytes.toLocaleString()} bytes`)
    lines.push(`  Estimated ${GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX} env string: ${violation.envBytes.toLocaleString()} bytes`)
    lines.push(`  Over safe max by: ${(violation.envBytes - GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES).toLocaleString()} bytes`)
  }
  lines.push('')
  lines.push('This would likely fail in GitHub Actions with: Argument list too long.')
  return lines.join('\n')
}

/**
 * Enforces the GitHub Actions trigger text budget for a prompt plan.
 * @param {GithubPromptBudgetPlan} plan
 * @param {{ dryRun?: boolean }} [options]
 * @returns {GithubPromptBudgetEnforcement}
 */
function enforceGithubActionPromptBudget(plan, { dryRun = false } = {}) {
  const violations = githubActionPromptBudgetViolations(plan)
  if (violations.length > 0) {
    const message = formatGithubActionPromptBudgetError(violations)
    if (!dryRun) throw new Error(message)
    console.error(`\n${message}`)
    return { violations, warnings: [] }
  }

  const warnings = githubActionPromptBudgetWarnings(plan)
  for (const warning of warnings) {
    console.error(
      [
        `Warning: ${warning.label} is close to the GitHub Actions Agent Runner prompt limit.`,
        `  Body: ${warning.bodyChars.toLocaleString()} chars / ${warning.bodyBytes.toLocaleString()} bytes`,
        `  Estimated ${GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX} env string: ${warning.envBytes.toLocaleString()} bytes`,
      ].join('\n'),
    )
  }
  return { violations, warnings }
}

/**
 * Caps local prompt safety by the GitHub Actions environment-string ceiling.
 * @param {Record<string, unknown>} [options]
 * @param {{ localSafePromptBytes?: LocalSafePromptBytes }} [dependencies]
 * @returns {number}
 */
function githubSafePromptBytes(options = {}, { localSafePromptBytes } = {}) {
  if (typeof localSafePromptBytes !== 'function') {
    throw new Error('githubSafePromptBytes requires a localSafePromptBytes dependency.')
  }
  const envPrefixBytes = utf8ByteLength(GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX)
  return Math.min(
    localSafePromptBytes(options),
    GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES - envPrefixBytes,
  )
}

module.exports = {
  BODY_FALLBACK_THRESHOLD,
  BODY_SAFETY_MARGIN,
  GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX,
  GITHUB_ACTION_TRIGGER_TEXT_SAFE_MAX_BYTES,
  GITHUB_ACTION_TRIGGER_TEXT_WARNING_BYTES,
  GITHUB_ISSUE_BODY_LIMIT,
  enforceGithubActionPromptBudget,
  formatGithubActionPromptBudgetError,
  githubActionPromptBudgetLabel,
  githubActionPromptBudgetViolations,
  githubActionPromptBudgetWarnings,
  githubActionTriggerTextMetrics,
  githubSafePromptBytes,
  utf8ByteLength,
}
