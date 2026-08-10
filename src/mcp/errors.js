const { ZodError } = require('zod/v4')

const {
  boundedNextActions,
  conciseText,
  resultContext,
  sanitizeMcpObject,
  scopeNextActions,
} = require('./results')

const LOCAL_PATH_KEY_PATTERN = /^(?:absolutePath|dir|file|promptPath|sourceDir|summaryPath)$/i
const RECOVERABLE_CODES = new Set([
  'agent_run_not_found',
  'ambiguous_agent_run',
  'ambiguous_cancel_target',
  'ambiguous_followup_target',
  'ambiguous_retry_target',
  'artifact_not_found',
  'bad_token',
  'cancel_run_not_active',
  'dashboard_not_running',
  'dashboard_auth_failed',
  'dashboard_timeout',
  'dashboard_unreachable',
  'dashboard_version_mismatch',
  'duplicate_run',
  'idempotency_conflict',
  'invalid_arguments',
  'invalid_cursor',
  'invalid_instance_contract',
  'mutation_in_progress',
  'no_access',
  'no_review_gate',
  'no_site',
  'no_token',
  'not_found',
  'project_scope_mismatch',
  'project_ambiguous',
  'project_not_found',
  'request_cancelled',
  'review_gate_not_found',
  'retry_run_not_found',
  'run_plan_expired',
  'run_start_in_progress',
  'scope_forbidden',
  'unsupported_capability',
  'unsupported_instance_lineup',
  'workflow_not_found',
])

/**
 * @typedef {import('../contracts').ControlPlaneContext} ControlPlaneContext
 * @typedef {import('../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject
 * @typedef {import('../contracts').ControlPlaneNextAction} ControlPlaneNextAction
 * @typedef {import('./results').McpResultContext} McpResultContext
 *
 * @typedef {{
 *   toolName?: import('../contracts').ControlPlaneToolName,
 *   context?: McpResultContext | ControlPlaneContext,
 *   candidates?: string[],
 * }} McpErrorOptions
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} error @param {string} field */
function errorField(error, field) {
  const record = objectValue(error)
  return record[field]
}

/** @param {unknown} error */
function expectedApplicationError(error) {
  return error instanceof ZodError || typeof errorField(error, 'code') === 'string'
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @param {number} [depth]
 * @returns {unknown}
 */
function stripUnsafeErrorPaths(value, key = '', depth = 0) {
  if (LOCAL_PATH_KEY_PATTERN.test(key)) return undefined
  if (key.toLowerCase() === 'path' && typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|[~/\\])/.test(value)) return undefined
  if (depth >= 10 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => stripUnsafeErrorPaths(entry, key, depth + 1))
  const result = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const item = stripUnsafeErrorPaths(childValue, childKey, depth + 1)
    if (item !== undefined) result[childKey] = item
  }
  return result
}

/** @param {string} left @param {string} right */
function editDistance(left, right) {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * @param {string} requested
 * @param {string[]} candidates
 * @param {number} [limit]
 */
function closestCandidates(requested, candidates, limit = 3) {
  if (!requested) return []
  return [...new Set(candidates.filter(Boolean))]
    .map((candidate) => ({ candidate, distance: editDistance(requested, candidate) }))
    .filter(({ candidate, distance }) => distance <= Math.max(2, Math.floor(Math.max(requested.length, candidate.length) * 0.3)))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, limit)
    .map(({ candidate }) => candidate)
}

/** @param {Record<string, unknown>} details */
function requestedId(details) {
  for (const key of ['requestedId', 'workflowId', 'runId', 'agentRunId', 'reviewGateId', 'artifactId', 'id']) {
    if (typeof details[key] === 'string') return details[key]
  }
  return ''
}

/** @param {Record<string, unknown>} details @param {string[]} provided */
function errorCandidates(details, provided) {
  const candidates = [...provided]
  for (const key of ['candidates', 'candidateIds', 'workflowIds', 'runIds', 'agentRunIds', 'reviewGateIds']) {
    const value = details[key]
    if (!Array.isArray(value)) continue
    for (const candidate of value) {
      if (typeof candidate === 'string') candidates.push(candidate)
      else if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const record = /** @type {Record<string, unknown>} */ (candidate)
        for (const idKey of ['id', 'workflowId', 'runId', 'agentRunId', 'reviewGateId']) {
          if (typeof record[idKey] === 'string') candidates.push(record[idKey])
        }
      }
    }
  }
  return [...new Set(candidates.filter(Boolean))].slice(0, 50)
}

/** @param {import('../contracts').ControlPlaneToolName | undefined} toolName @param {Record<string, unknown>} details */
function discoveryAction(toolName, details) {
  if (toolName?.startsWith('workflow_')) return /** @type {ControlPlaneNextAction} */ ({ kind: 'tool', tool: 'workflow_list', arguments: { limit: 50 } })
  if (toolName === 'context_get') return /** @type {ControlPlaneNextAction} */ ({ kind: 'command', command: 'nax dashboard --no-open' })
  if (details.runId) return /** @type {ControlPlaneNextAction} */ ({ kind: 'tool', tool: 'run_get', arguments: { run_id: String(details.runId), view: 'summary' } })
  return /** @type {ControlPlaneNextAction} */ ({ kind: 'tool', tool: 'run_list', arguments: { limit: 50 } })
}

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * @param {string} code
 * @param {import('../contracts').ControlPlaneToolName | undefined} toolName
 * @param {Record<string, unknown>} details
 * @returns {{ fix: string, actions: ControlPlaneNextAction[] }}
 */
function recoveryGuidance(code, toolName, details) {
  if (code === 'dashboard_not_running') {
    const projectRoot = typeof details.projectRoot === 'string' ? details.projectRoot : ''
    const quotedRoot = projectRoot ? ` --project-root ${shellQuote(projectRoot)}` : ''
    return { fix: 'Start the nax control plane for this project.', actions: [{ kind: 'command', command: `nax dashboard${quotedRoot} --no-open` }] }
  }
  if (code === 'project_not_found') return { fix: 'Call context_get with an exact absolute project directory, or start that project dashboard so its short alias becomes discoverable.', actions: [{ kind: 'tool', tool: 'context_get', arguments: {} }] }
  if (code === 'project_ambiguous') return { fix: 'Choose one exact returned scope_id and call context_get again.', actions: [{ kind: 'tool', tool: 'context_get', arguments: {} }] }
  if (code === 'dashboard_auth_failed') return { fix: 'Restart the dashboard so the private MCP registry and dashboard token are refreshed together.', actions: [{ kind: 'command', command: 'nax dashboard --no-open' }] }
  if (['dashboard_unreachable', 'dashboard_timeout'].includes(code)) return { fix: 'Restart the dashboard in the scoped project, then retry the same read.', actions: [{ kind: 'command', command: 'nax dashboard --no-open' }] }
  if (code === 'dashboard_version_mismatch') return { fix: 'Restart Claude and the dashboard from the same installed nax version.', actions: [{ kind: 'command', command: 'nax dashboard --no-open' }] }
  if (['no_token', 'bad_token'].includes(code)) return { fix: 'Authenticate the Netlify CLI for the selected account.', actions: [{ kind: 'command', command: 'netlify login' }, { kind: 'tool', tool: 'context_get', arguments: {} }] }
  if (['no_site', 'no_access'].includes(code)) return { fix: 'Link or select a Netlify site accessible to the authenticated account.', actions: [{ kind: 'command', command: 'netlify link' }, { kind: 'tool', tool: 'context_get', arguments: {} }] }
  if (['invalid_instance_contract', 'unsupported_instance_lineup'].includes(code) || code.includes('agent_configuration')) return { fix: 'Read context_get and choose structured agent/model/effort identifiers from the catalog.', actions: [{ kind: 'tool', tool: 'context_get', arguments: {} }] }
  if (code === 'run_plan_expired') {
    const agentPlan = details.planKind === 'agent-run'
    return {
      fix: 'Create a fresh immutable plan and review it before starting.',
      actions: [{
        kind: 'tool',
        tool: agentPlan ? 'agent_run_plan' : 'workflow_plan',
        arguments: agentPlan || !details.workflowId ? {} : { workflow_id: String(details.workflowId) },
      }],
    }
  }
  if (code === 'idempotency_conflict') return { fix: 'Review the differing intent, then generate a new request_id instead of reusing the old key.', actions: [] }
  if (code === 'mutation_in_progress') return {
    fix: 'Do not submit the mutation again; refresh the durable run while the original request is reconciled.',
    actions: details.runId
      ? [{ kind: 'tool', tool: 'run_get', arguments: { run_id: String(details.runId), view: 'summary' } }]
      : [{ kind: 'tool', tool: 'run_list', arguments: { limit: 50 } }],
  }
  if (code === 'run_start_in_progress') {
    const runId = details.runId || details.existingRunId
    return { fix: 'Wait for the existing plan start to bind its durable run.', actions: runId ? [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: String(runId), timeout_ms: 5000 } }] : [] }
  }
  if (code === 'duplicate_run') {
    const runId = details.runId || details.existingRunId
    return { fix: 'Inspect and wait for the existing run instead of creating another.', actions: runId ? [{ kind: 'tool', tool: 'run_get', arguments: { run_id: String(runId), view: 'summary' } }, { kind: 'tool', tool: 'run_wait', arguments: { run_id: String(runId), timeout_ms: 30000 } }] : [{ kind: 'tool', tool: 'run_list', arguments: { status: 'running' } }] }
  }
  if (code === 'no_review_gate' || code === 'review_gate_not_found') return { fix: 'Refresh the run and use only the currently awaiting review_gate_id.', actions: details.runId ? [{ kind: 'tool', tool: 'run_get', arguments: { run_id: String(details.runId), view: 'summary' } }] : [{ kind: 'tool', tool: 'run_list', arguments: { status: 'awaiting_review' } }] }
  if (code.startsWith('ambiguous_')) return { fix: 'Read the run again and choose one exact returned target ID.', actions: details.runId ? [{ kind: 'tool', tool: 'run_get', arguments: { run_id: String(details.runId), view: 'details' } }] : [{ kind: 'tool', tool: 'run_list', arguments: { limit: 50 } }] }
  if (code === 'unsupported_capability') return { fix: 'Refresh context and use an operation whose capability is available.', actions: [{ kind: 'tool', tool: 'context_get', arguments: {} }] }
  if (['scope_forbidden', 'project_scope_mismatch'].includes(code)) return { fix: 'Resolve the intended project with context_get and copy its exact returned scope_id into the next tool call.', actions: [{ kind: 'tool', tool: 'context_get', arguments: {} }] }
  if (code === 'invalid_arguments' || code === 'invalid_cursor') return { fix: 'Use exact IDs and cursors returned by discovery tools, and follow the tool input schema.', actions: [discoveryAction(toolName, details)] }
  if (code === 'not_found' || code.endsWith('_not_found') || code.startsWith('unknown_')) {
    const action = toolName === 'run_get' || toolName === 'run_wait'
      ? /** @type {ControlPlaneNextAction} */ ({ kind: 'tool', tool: 'run_list', arguments: { limit: 50 } })
      : discoveryAction(toolName, details)
    return { fix: 'Refresh discovery and copy one exact current entity ID.', actions: [action] }
  }
  return { fix: 'Refresh the relevant entity and retry only after correcting the reported state.', actions: [discoveryAction(toolName, details)] }
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string, recoverable: boolean, details: Record<string, unknown> }}
 */
function normalizeMcpError(error) {
  if (error instanceof ZodError) {
    return {
      code: 'invalid_arguments',
      message: 'Tool arguments did not match the NAX MCP schema.',
      recoverable: true,
      details: {
        issues: error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })),
      },
    }
  }
  if (!expectedApplicationError(error)) throw error
  const code = String(errorField(error, 'code'))
  const messageValue = errorField(error, 'message')
  const statusCode = Number(errorField(error, 'statusCode') || 0)
  const explicitRecoverable = errorField(error, 'recoverable')
  return {
    code,
    message: typeof messageValue === 'string' && messageValue ? messageValue : 'The NAX control-plane operation failed.',
    recoverable: typeof explicitRecoverable === 'boolean'
      ? explicitRecoverable
      : RECOVERABLE_CODES.has(code) || statusCode > 0 && statusCode < 500,
    details: objectValue(errorField(error, 'details')),
  }
}

/**
 * @param {unknown} error
 * @param {McpErrorOptions} [options]
 */
function errorResult(error, { toolName, context, candidates = [] } = {}) {
  const normalized = normalizeMcpError(error)
  const allCandidates = errorCandidates(normalized.details, candidates)
  const suggestions = closestCandidates(requestedId(normalized.details), allCandidates)
  const guidance = recoveryGuidance(normalized.code, toolName, normalized.details)
  const detailsValue = stripUnsafeErrorPaths({
    ...normalized.details,
    ...(allCandidates.length > 0 ? { candidates: allCandidates } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    fix: guidance.fix,
  })
  const details = sanitizeMcpObject(detailsValue)
  const structuredContent = {
    ok: /** @type {const} */ (false),
    error: {
      code: normalized.code,
      message: conciseText(normalized.message, 2048),
      recoverable: normalized.recoverable,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
    ...(resultContext(context) ? { context: resultContext(context) } : {}),
    next_actions: boundedNextActions(scopeNextActions(guidance.actions, context)),
  }
  const text = conciseText(`${normalized.code}: ${normalized.message}\nFix: ${guidance.fix}`)
  return {
    isError: true,
    content: [{ type: /** @type {const} */ ('text'), text }],
    structuredContent,
  }
}

module.exports = {
  RECOVERABLE_CODES,
  closestCandidates,
  editDistance,
  errorCandidates,
  errorResult,
  expectedApplicationError,
  normalizeMcpError,
  recoveryGuidance,
  requestedId,
  shellQuote,
  stripUnsafeErrorPaths,
}
