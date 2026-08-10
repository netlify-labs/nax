const { createNaxControlPlane } = require('../../control-plane/service')
const { controlPlaneAgentRunId, controlPlaneReviewGateId } = require('../../control-plane/entity-ids')
const {
  canonicalProjectRoot,
} = require('../../runtime/local/mcp-instance-registry')
const { localControlPlaneIdentity } = require('../../runtime/local/control-plane-identity')
const { createLocalControlPlaneAuditSink } = require('../../runtime/local/control-plane-audit')
const { createMcpControlPlaneClient } = require('../client')
const { isSecretKey, redactSecretText } = require('../security')
const {
  LocalDashboardAdapterError,
  discoverDashboardSession,
  requestDashboardJson,
} = require('./local-dashboard-http')

const MAX_WORKFLOW_PAGE = 100
const MAX_RUN_PAGE = 100
const MAX_EVENT_PAGE = 200
const MAX_WAIT_MS = 30000
const WAIT_POLL_MS = 250
const TERMINAL_STATUSES = new Set([
  'abandoned',
  'cancelled',
  'completed',
  'completed_with_failures',
  'dismissed',
  'dry-run',
  'failed',
  'skipped',
])
const LOCAL_FIELD_PATTERN = /^(?:absolutePath|dir|file|path|promptPath|sourceDir|summaryPath)$/i

/**
 * @typedef {import('../../contracts').ControlPlaneActor} ControlPlaneActor
 * @typedef {import('../../contracts').ControlPlaneAgentCatalog} ControlPlaneAgentCatalog
 * @typedef {import('../../contracts').ControlPlaneAgentInstanceInput} ControlPlaneAgentInstanceInput
 * @typedef {import('../../contracts').ControlPlaneAgentRunSummary} ControlPlaneAgentRunSummary
 * @typedef {import('../../contracts').ControlPlaneCapabilities} ControlPlaneCapabilities
 * @typedef {import('../../contracts').ControlPlaneEvent} ControlPlaneEvent
 * @typedef {import('../../contracts').ControlPlaneEventPage} ControlPlaneEventPage
 * @typedef {import('../../contracts').ControlPlaneGraph} ControlPlaneGraph
 * @typedef {import('../../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject
 * @typedef {import('../../contracts').ControlPlaneJsonValue} ControlPlaneJsonValue
 * @typedef {import('../../contracts').ControlPlaneReviewGate} ControlPlaneReviewGate
 * @typedef {import('../../contracts').ControlPlaneRunDetails} ControlPlaneRunDetails
 * @typedef {import('../../contracts').ControlPlaneRunSummary} ControlPlaneRunSummary
 * @typedef {import('../../contracts').ControlPlaneScope} ControlPlaneScope
 * @typedef {import('../../contracts').ControlPlaneTarget} ControlPlaneTarget
 * @typedef {import('../../contracts').ControlPlaneWorkflow} ControlPlaneWorkflow
 * @typedef {import('../../contracts').ControlPlaneWorkflowSummary} ControlPlaneWorkflowSummary
 * @typedef {import('../../contracts').NaxControlPlane} NaxControlPlane
 * @typedef {import('../../contracts').NaxControlPlaneClient} NaxControlPlaneClient
 * @typedef {import('../../contracts').NaxControlPlanePorts} NaxControlPlanePorts
 *
 * @typedef {import('./local-dashboard-http').LocalDashboardHttpOptions & {
 *   userId?: string,
 *   auditSink?: import('../../contracts').ControlPlaneAuditSink,
 *   auditContext?: import('../../contracts').ControlPlaneAuditContext,
 * }} LocalDashboardAdapterOptions
 *
 * @typedef {{
 *   scope: ControlPlaneScope,
 *   actor: ControlPlaneActor,
 * }} LocalDashboardIdentity
 *
 * @typedef {{
 *   run: Record<string, unknown>,
 *   step: Record<string, unknown>,
 *   agentRun: Record<string, unknown>,
 *   stepId: string,
 *   instanceId: string,
 *   agentRunId: string,
 *   index: number,
 * }} DashboardAgentRunCandidate
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} value @returns {string} */
function stringValue(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

/** @param {unknown} value @param {number} fallback @param {number} maximum */
function positiveLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(stringValue(value), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @param {number} [depth]
 * @returns {ControlPlaneJsonValue | undefined}
 */
function safeJsonValue(value, key = '', depth = 0) {
  if (isSecretKey(key) || LOCAL_FIELD_PATTERN.test(key)) return undefined
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const redacted = redactSecretText(value)
    return redacted.length > 65536 ? `${redacted.slice(0, 65536)}\n[truncated]` : redacted
  }
  if (depth >= 10) return '[maximum depth reached]'
  if (Array.isArray(value)) {
    return value.slice(0, 500).flatMap((entry) => {
      const item = safeJsonValue(entry, key, depth + 1)
      return item === undefined ? [] : [item]
    })
  }
  if (!value || typeof value !== 'object') return undefined
  /** @type {ControlPlaneJsonObject} */
  const result = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const item = safeJsonValue(childValue, childKey, depth + 1)
    if (item !== undefined) result[childKey] = item
  }
  return result
}

/** @param {unknown} value @returns {ControlPlaneJsonObject} */
function safeJsonObject(value) {
  const result = safeJsonValue(value)
  return result && typeof result === 'object' && !Array.isArray(result)
    ? /** @type {ControlPlaneJsonObject} */ (result)
    : {}
}

/** @param {unknown} value @returns {string[]} */
function stringList(value) {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : []
}

/** @param {unknown} value @returns {boolean} */
function booleanValue(value) {
  return value === true
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function objectList(value) {
  return Array.isArray(value) ? value.map(objectValue) : []
}

/**
 * @param {string} message
 * @param {string} capability
 * @param {string[]} alternatives
 * @returns {never}
 */
function unsupported(message, capability, alternatives) {
  throw new LocalDashboardAdapterError('unsupported_capability', message, {
    statusCode: 501,
    details: { capability, alternatives },
  })
}

/** @param {Record<string, unknown>} capabilities @param {string} capability @param {string[]} [alternatives] */
function requireDashboardCapability(capabilities, capability, alternatives = []) {
  if (capabilities[capability] !== true) {
    unsupported(`Dashboard capability "${capability}" is not available in this runtime.`, capability, alternatives)
  }
}

/** @param {number} offset */
function workflowCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url')
}

/** @param {unknown} cursor */
function workflowOffset(cursor) {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(stringValue(cursor), 'base64url').toString('utf8'))
    const offset = Number(parsed?.offset)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid offset')
    return offset
  } catch (_error) {
    throw new LocalDashboardAdapterError('invalid_cursor', 'The workflow cursor is invalid.', { statusCode: 400 })
  }
}

/** @param {unknown} value @returns {ControlPlaneAgentInstanceInput & { instanceId: string, status?: string, resolvedFrom?: 'latest' | 'default' | 'open' | 'pinned' }} */
function mapInstance(value) {
  const instance = objectValue(value)
  const resolvedFrom = ['latest', 'default', 'open', 'pinned'].includes(stringValue(instance.resolvedFrom))
    ? /** @type {'latest' | 'default' | 'open' | 'pinned'} */ (stringValue(instance.resolvedFrom))
    : undefined
  return {
    instanceId: stringValue(instance.id || instance.instanceId || instance.agent),
    agent: stringValue(instance.agent),
    ...(instance.model ? { model: stringValue(instance.model) } : {}),
    ...(instance.effort ? { effort: stringValue(instance.effort) } : {}),
    ...(instance.label ? { label: stringValue(instance.label) } : {}),
    ...(instance.status ? { status: stringValue(instance.status) } : {}),
    ...(resolvedFrom ? { resolvedFrom } : {}),
  }
}

/** @param {Record<string, unknown>} workflow @returns {string[]} */
function workflowAgents(workflow) {
  const agents = []
  const seen = new Set()
  for (const step of objectList(workflow.steps)) {
    const candidates = [
      ...stringList(step.agents),
      ...objectList(step.instances).map((instance) => stringValue(instance.agent)),
    ]
    for (const agent of candidates) {
      if (!agent || seen.has(agent)) continue
      seen.add(agent)
      agents.push(agent)
    }
  }
  return agents
}

/** @param {unknown} value @returns {ControlPlaneWorkflowSummary} */
function mapWorkflowSummary(value) {
  const workflow = objectValue(value)
  const steps = objectList(workflow.steps)
  return {
    workflowId: stringValue(workflow.id),
    title: stringValue(workflow.title),
    description: stringValue(workflow.description),
    source: stringValue(workflow.source),
    sourceLabel: stringValue(workflow.sourceLabel),
    stepCount: steps.length,
    agents: workflowAgents(workflow),
  }
}

/** @param {unknown} value @returns {ControlPlaneWorkflow} */
function mapWorkflow(value) {
  const workflow = objectValue(value)
  const summary = mapWorkflowSummary(workflow)
  return {
    ...summary,
    defaults: safeJsonObject(workflow.defaults),
    options: safeJsonObject(workflow.options),
    steps: objectList(workflow.steps).map((step) => {
      const action = stringValue(step.action || step.type)
      return {
        stepId: stringValue(step.id),
        title: stringValue(step.title),
        ...(step.description ? { description: stringValue(step.description) } : {}),
        action,
        submit: stringValue(step.submit),
        waitFor: stringValue(step.waitFor),
        agents: stringList(step.agents),
        instances: objectList(step.instances).map(mapInstance),
        reviewGate: action === 'human-review' || stringValue(step.waitFor) === 'human-review' || Boolean(step.review),
      }
    }),
  }
}

/** @param {unknown} value @returns {ControlPlaneGraph} */
function mapGraph(value) {
  const graph = objectValue(value)
  return {
    nodes: objectList(graph.nodes).map((node) => ({
      id: stringValue(node.id),
      kind: stringValue(node.type || objectValue(node.data).kind || 'node'),
      data: safeJsonObject(node.data),
    })),
    edges: objectList(graph.edges).map((edge) => ({
      id: stringValue(edge.id),
      source: stringValue(edge.source),
      target: stringValue(edge.target),
      kind: stringValue(edge.type || objectValue(edge.data).kind || 'edge'),
      data: safeJsonObject(edge.data),
    })),
    metadata: safeJsonObject(graph.metadata),
  }
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} health
 * @returns {ControlPlaneTarget | null}
 */
function mapTarget(value, health) {
  const target = objectValue(value)
  const netlifyContext = objectValue(health.netlifyContext)
  const healthTarget = objectValue(netlifyContext.target)
  const netlifyAccess = objectValue(health.netlifyAccess)
  const accessSite = objectValue(netlifyAccess.site)
  const siteId = stringValue(target.siteId || target.id || healthTarget.siteId || accessSite.id)
  if (!siteId) return null
  const caveats = [
    ...stringList(target.caveats),
    stringValue(healthTarget.reason),
    stringValue(netlifyContext.targetError),
  ].filter(Boolean)
  return {
    ...(target.accountId || healthTarget.accountId || accessSite.accountId ? { accountId: stringValue(target.accountId || healthTarget.accountId || accessSite.accountId) } : {}),
    ...(target.accountSlug || healthTarget.accountSlug || accessSite.accountSlug ? { accountSlug: stringValue(target.accountSlug || healthTarget.accountSlug || accessSite.accountSlug) } : {}),
    siteId,
    siteName: stringValue(target.siteName || target.name || healthTarget.name || accessSite.name || siteId),
    branch: stringValue(target.branch || health.currentBranch),
    ...(target.ref ? { ref: stringValue(target.ref) } : {}),
    ...(Object.hasOwn(target, 'sha') ? { sha: target.sha === null ? null : stringValue(target.sha) } : {}),
    verified: target.verified === true || healthTarget.accessible === true,
    caveats: [...new Set(caveats)],
  }
}

/** @param {string} runId @param {string} stepId @param {Record<string, unknown>} agentRun @param {number} index */
function agentRunIdFor(runId, stepId, agentRun, index) {
  return controlPlaneAgentRunId(runId, stepId, agentRun, index)
}

/** @param {Record<string, unknown>} run @returns {DashboardAgentRunCandidate[]} */
function agentRunCandidates(run) {
  const runId = stringValue(run.runId || run.id)
  /** @type {DashboardAgentRunCandidate[]} */
  const candidates = []
  for (const step of objectList(run.steps)) {
    const stepId = stringValue(step.id || step.stepId)
    objectList(step.runs).forEach((agentRun, index) => {
      const instanceId = stringValue(agentRun.instanceId) || [
        stringValue(agentRun.agent).toLowerCase(),
        stringValue(agentRun.model || 'auto'),
        stringValue(agentRun.effort || 'auto'),
      ].join(':')
      candidates.push({
        run,
        step,
        agentRun,
        stepId,
        instanceId,
        agentRunId: agentRunIdFor(runId, stepId, agentRun, index),
        index,
      })
    })
  }
  return candidates
}

/** @param {DashboardAgentRunCandidate} candidate @returns {ControlPlaneAgentRunSummary} */
function mapAgentRunCandidate(candidate) {
  const raw = candidate.agentRun
  const runId = stringValue(candidate.run.runId || candidate.run.id)
  return {
    agentRunId: candidate.agentRunId,
    runId,
    ...(candidate.stepId ? { stepId: candidate.stepId } : {}),
    ...(candidate.instanceId ? { instanceId: candidate.instanceId } : {}),
    agent: stringValue(raw.agent),
    ...(raw.model ? { model: stringValue(raw.model) } : {}),
    ...(raw.effort ? { effort: stringValue(raw.effort) } : {}),
    ...(raw.runnerId ? { runnerId: stringValue(raw.runnerId) } : {}),
    ...(raw.sessionId ? { sessionId: stringValue(raw.sessionId) } : {}),
    status: stringValue(raw.status || 'unknown'),
  }
}

/** @param {Record<string, unknown>} run @returns {ControlPlaneReviewGate | null} */
function reviewGateForRun(run) {
  const runId = stringValue(run.runId || run.id)
  const steps = objectList(run.steps)
  const candidates = steps.filter((step) => {
    const review = objectValue(step.review)
    return stringValue(step.action || step.type) === 'human-review' || Boolean(review.status) || stringValue(step.status) === 'awaiting_review'
  })
  const step = candidates.find((candidate) => stringValue(candidate.status) === 'awaiting_review' || stringValue(objectValue(candidate.review).status) === 'awaiting_review') || candidates.at(-1)
  if (!step) return null
  const stepId = stringValue(step.id || step.stepId)
  const review = objectValue(step.review)
  const rawStatus = stringValue(review.status || step.status)
  const status = rawStatus === 'approved' || rawStatus === 'completed'
    ? 'approved'
    : rawStatus === 'cancelled'
      ? 'cancelled'
      : 'awaiting'
  return {
    reviewGateId: controlPlaneReviewGateId(runId, stepId),
    runId,
    stepId,
    status,
    ...(review.reason ? { reason: stringValue(review.reason) } : {}),
  }
}

/** @param {unknown} value @param {Record<string, unknown>} health @returns {ControlPlaneRunSummary} */
function mapRun(value, health) {
  const run = objectValue(value)
  const runId = stringValue(run.runId || run.id)
  const candidates = agentRunCandidates(run)
  const target = mapTarget(run.target, health)
  const usage = objectValue(run.usageTotals)
  return {
    runId,
    ...(run.flowId ? { workflowId: stringValue(run.flowId) } : {}),
    ...(run.flowTitle ? { title: stringValue(run.flowTitle) } : {}),
    ...(run.transport ? { source: stringValue(run.transport) } : {}),
    status: stringValue(run.status || 'unknown'),
    ...(run.branch ? { branch: stringValue(run.branch) } : {}),
    ...(target ? { target } : {}),
    ...(run.createdAt ? { createdAt: stringValue(run.createdAt) } : {}),
    ...(run.updatedAt ? { updatedAt: stringValue(run.updatedAt) } : {}),
    ...(run.lastEventAt ? { lastEventAt: stringValue(run.lastEventAt) } : {}),
    ...(Object.hasOwn(run, 'stalled') ? { stalled: booleanValue(run.stalled) } : {}),
    ...(Object.hasOwn(run, 'cancellable') ? { cancellable: booleanValue(run.cancellable) } : {}),
    ...(candidates.length > 0 ? { agentRuns: candidates.map(mapAgentRunCandidate) } : {}),
    ...(reviewGateForRun(run) ? { reviewGate: reviewGateForRun(run) } : {}),
    ...(Object.keys(usage).length > 0 ? {
      usageTotals: {
        ...(Number.isFinite(Number(usage.totalTokens)) ? { totalTokens: Number(usage.totalTokens) } : {}),
        ...(Number.isFinite(Number(usage.totalCreditsCost)) ? { totalCreditsCost: Number(usage.totalCreditsCost) } : {}),
        ...(Number.isFinite(Number(usage.stepsCount)) ? { stepsCount: Number(usage.stepsCount) } : {}),
        ...(Object.hasOwn(usage, 'creditLimitExceeded') ? { creditLimitExceeded: booleanValue(usage.creditLimitExceeded) } : {}),
      },
    } : {}),
  }
}

/** @param {Record<string, unknown>} run @param {string} agentRunId */
function exactAgentRun(run, agentRunId) {
  const candidates = agentRunCandidates(run)
  const matches = candidates.filter((candidate) => candidate.agentRunId === agentRunId)
  if (matches.length === 0) {
    throw new LocalDashboardAdapterError('agent_run_not_found', `Agent run "${agentRunId}" was not found in this workflow run.`, {
      statusCode: 404,
      details: { runId: stringValue(run.runId || run.id), agentRunId, agentRunIds: candidates.map((candidate) => candidate.agentRunId) },
    })
  }
  if (matches.length > 1) {
    throw new LocalDashboardAdapterError('ambiguous_agent_run', `Agent run "${agentRunId}" is ambiguous in legacy run data.`, {
      statusCode: 409,
      details: { runId: stringValue(run.runId || run.id), agentRunId, agentRunIds: matches.map((candidate) => candidate.agentRunId) },
    })
  }
  return matches[0]
}

/** @param {unknown} value @returns {ControlPlaneAgentCatalog} */
function mapAgentCatalog(value) {
  const catalog = objectValue(value)
  const provenance = objectValue(catalog.provenance)
  return {
    provenance: {
      source: stringValue(provenance.source || 'nax-dashboard'),
      commit: stringValue(provenance.commit || 'unknown'),
      syncedAt: stringValue(provenance.syncedAt || new Date(0).toISOString()),
    },
    providers: objectList(catalog.providers).map((provider) => ({
      id: stringValue(provider.id),
      label: stringValue(provider.label || provider.id),
      defaultModel: stringValue(provider.defaultModel),
      models: objectList(provider.models).map((model) => ({
        id: stringValue(model.id),
        label: stringValue(model.label || model.id),
        efforts: objectList(model.efforts).map((effort) => ({
          id: stringValue(effort.id),
          label: stringValue(effort.label || effort.id),
          ...(effort.wireValue ? { wireValue: stringValue(effort.wireValue) } : {}),
        })),
        ...(model.aliasFor ? { aliasFor: stringValue(model.aliasFor) } : {}),
        ...(model.upstreamDefaultEffort ? { upstreamDefaultEffort: stringValue(model.upstreamDefaultEffort) } : {}),
      })),
    })),
  }
}

/** @param {Record<string, unknown>} dashboard @returns {ControlPlaneCapabilities} */
function mapCapabilities(dashboard) {
  const available = (condition, reason) => condition ? { available: true } : { available: false, reason }
  const noWorkflows = 'Workflow discovery is unavailable in this dashboard runtime.'
  const noRuns = 'Run storage is unavailable in this dashboard runtime.'
  const noPlanning = 'Run planning is not exposed by this dashboard version yet.'
  return {
    context_get: { available: true },
    workflow_list: available(dashboard.canListWorkflows === true, noWorkflows),
    workflow_get: available(dashboard.canListWorkflows === true, noWorkflows),
    workflow_plan: available(dashboard.canPlanRuns === true, noPlanning),
    agent_run_plan: available(dashboard.canPlanRuns === true, noPlanning),
    run_start: available(dashboard.canPlanRuns === true && dashboard.canStartRuns === true, noPlanning),
    run_list: available(dashboard.canReadRuns === true, noRuns),
    run_get: available(dashboard.canReadRuns === true, noRuns),
    run_wait: available(dashboard.canReadRuns === true && dashboard.canReadEventsJson === true, 'Bounded event reads are unavailable in this dashboard runtime.'),
    run_cancel: available(dashboard.canCancelRuns === true, 'Run cancellation is unavailable in this dashboard runtime.'),
    agent_run_retry: available(dashboard.canStartRuns === true, 'Agent retry is unavailable in this dashboard runtime.'),
    agent_run_followup: available(dashboard.canSubmitFollowups === true, 'Agent follow-up is unavailable in this dashboard runtime.'),
    review_gate_resolve: available(dashboard.canReviewGates === true, 'Review gates are unavailable in this dashboard runtime.'),
    resource_read: available(dashboard.canReadRunArtifacts === true, 'Artifact content reads are not exposed by this dashboard version yet.'),
  }
}

/** @param {unknown} value */
function eventCursor(value) {
  const event = objectValue(value)
  return stringValue(event.seq || event.id || '0')
}

/** @param {unknown} value @param {string} fallbackRunId @returns {ControlPlaneEvent} */
function mapEvent(value, fallbackRunId) {
  const event = objectValue(value)
  const cursor = eventCursor(event)
  const data = { ...event }
  for (const key of ['seq', 'id', 'eventId', 'type', 'at', 'runId', 'stepId', 'status', 'message']) delete data[key]
  const agentRun = event.runnerId || event.sessionId
    ? {
        runId: stringValue(event.runId || fallbackRunId),
        stepId: stringValue(event.stepId),
        runnerId: stringValue(event.runnerId),
        sessionId: stringValue(event.sessionId),
        instanceId: stringValue(event.instanceId),
        agent: stringValue(event.agent),
      }
    : null
  return {
    cursor,
    eventId: stringValue(event.eventId || `${fallbackRunId}:${cursor}`),
    type: stringValue(event.type || 'unknown'),
    at: stringValue(event.at || new Date(0).toISOString()),
    runId: stringValue(event.runId || fallbackRunId),
    ...(event.stepId ? { stepId: stringValue(event.stepId) } : {}),
    ...(agentRun ? { agentRunId: agentRunIdFor(agentRun.runId, agentRun.stepId, agentRun, 0) } : {}),
    ...(event.status ? { status: stringValue(event.status) } : {}),
    ...(event.message ? { message: redactSecretText(event.message) } : {}),
    ...(Object.keys(data).length > 0 ? { data: safeJsonObject(data) } : {}),
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} runId
 * @param {number} limit
 * @returns {ControlPlaneEventPage}
 */
function mapEventPage(payload, runId, limit) {
  const all = objectList(payload.events).map((event) => mapEvent(event, runId))
  const events = all.slice(0, limit)
  return {
    events,
    nextCursor: events.at(-1)?.cursor || '0',
    truncated: all.length > events.length,
  }
}

/** @param {string} scopeId @param {string} runId @param {string} artifactId */
function artifactUri(scopeId, runId, artifactId) {
  return `nax://scopes/${encodeURIComponent(scopeId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`
}

/**
 * @param {Record<string, unknown>} response
 * @param {ControlPlaneRunSummary} run
 * @param {string} scopeId
 * @param {string} [sectionId]
 * @returns {ControlPlaneRunDetails}
 */
function mapRunDetails(response, run, scopeId, sectionId = '') {
  const details = objectValue(response.details)
  const rawRun = objectValue(response.run)
  const candidates = agentRunCandidates(rawRun)
  const sections = objectList(details.sections).map((section) => {
    const target = candidates.find((candidate) => {
      if (section.runnerId && stringValue(candidate.agentRun.runnerId) !== stringValue(section.runnerId)) return false
      if (section.sessionId && stringValue(candidate.agentRun.sessionId) !== stringValue(section.sessionId)) return false
      if (section.instanceId && candidate.instanceId !== stringValue(section.instanceId)) return false
      return Boolean(section.runnerId || section.sessionId || section.instanceId)
    })
    const id = stringValue(section.id)
    const resourceUri = target
      ? `nax://scopes/${encodeURIComponent(scopeId)}/runs/${encodeURIComponent(run.runId)}/details`
      : undefined
    return {
      sectionId: id,
      kind: section.kind === 'session' ? /** @type {const} */ ('session') : /** @type {const} */ ('step'),
      title: stringValue(section.title),
      status: stringValue(section.status || 'unknown'),
      ...(target ? { agentRunId: target.agentRunId } : {}),
      ...(resourceUri ? { resourceUri } : {}),
      ...(section.markdown ? { markdown: redactSecretText(section.markdown) } : {}),
    }
  }).filter((section) => !sectionId || section.sectionId === sectionId)
  const artifacts = objectList(details.followupArtifacts).map((artifact) => ({
    artifactId: stringValue(artifact.id),
    label: stringValue(artifact.label),
    kind: stringValue(artifact.kind),
    sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : 0,
    resourceUri: artifactUri(scopeId, run.runId, stringValue(artifact.id)),
  }))
  return {
    ...(details.summaryMarkdown ? { summary: redactSecretText(details.summaryMarkdown) } : {}),
    sections,
    artifacts,
  }
}

/** @param {Record<string, unknown>} run */
function waitReason(run) {
  const status = stringValue(run.status).toLowerCase()
  if (status === 'awaiting_review' || status === 'interrupted') return /** @type {const} */ ('review')
  if (run.stalled === true) return /** @type {const} */ ('stalled')
  if (TERMINAL_STATUSES.has(status)) return /** @type {const} */ ('terminal')
  return null
}

/** @param {number} milliseconds @param {AbortSignal | undefined} signal */
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LocalDashboardAdapterError('request_cancelled', 'The MCP client cancelled this wait.', { statusCode: 499 }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new LocalDashboardAdapterError('request_cancelled', 'The MCP client cancelled this wait.', { statusCode: 499 }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * @param {string} projectRoot
 * @param {{ userId?: string }} [options]
 * @returns {LocalDashboardIdentity}
 */
function localDashboardIdentity(projectRoot, options = {}) {
  return localControlPlaneIdentity(projectRoot, options)
}

/**
 * @param {LocalDashboardAdapterOptions} config
 * @param {LocalDashboardIdentity} identity
 * @returns {NaxControlPlanePorts}
 */
function createLocalDashboardPorts(config, identity) {
  const httpConfig = { ...config, projectRoot: canonicalProjectRoot(config.projectRoot) }
  const audit = config.auditSink || createLocalControlPlaneAuditSink(httpConfig.projectRoot)

  /** @returns {Promise<import('./local-dashboard-http').LocalDashboardSession>} */
  const session = () => discoverDashboardSession(httpConfig)

  /**
   * @param {import('./local-dashboard-http').LocalDashboardSession} current
   * @param {string} apiPath
   * @param {import('./local-dashboard-http').DashboardJsonRequestOptions} [request]
   */
  const request = (current, apiPath, request) => requestDashboardJson(current.record, apiPath, httpConfig, request)

  /** @param {import('./local-dashboard-http').LocalDashboardSession} current @param {string} runId */
  async function rawRun(current, runId) {
    const payload = await request(current, `/api/runs/${encodeURIComponent(runId)}`)
    return objectValue(payload.run)
  }

  return {
    audit,
    auditContext: { runtime: 'local-dashboard', clientName: 'mcp-stdio', ...config.auditContext },
    authorize({ scope, actor }) {
      if (
        scope.scopeId !== identity.scope.scopeId ||
        scope.projectId !== identity.scope.projectId ||
        actor.actorId !== identity.actor.actorId ||
        actor.kind !== identity.actor.kind ||
        actor.authenticated !== true
      ) {
        throw new LocalDashboardAdapterError('scope_forbidden', 'The MCP invocation identity does not match this local dashboard project.', { statusCode: 403 })
      }
    },
    async getContext() {
      const current = await session()
      const dashboardCapabilities = objectValue(current.health.capabilities)
      const agentConfiguration = objectValue(dashboardCapabilities.agentConfiguration)
      return {
        runtime: /** @type {const} */ ('local-dashboard'),
        scope: identity.scope,
        actor: {
          actorId: identity.actor.actorId,
          kind: identity.actor.kind,
          authenticated: true,
        },
        capabilities: mapCapabilities(dashboardCapabilities),
        agentCatalog: mapAgentCatalog(agentConfiguration.catalog),
        target: mapTarget(objectValue(current.health.netlifyContext).target, current.health),
        currentBranch: stringValue(current.health.currentBranch),
        branches: stringList(current.health.branches),
        local: {
          projectRoot: current.record.projectRoot,
          dashboardInstanceId: current.record.instanceId,
        },
      }
    },
    async listWorkflows(_scope, _actor, query = {}) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canListWorkflows', ['Start `nax dashboard` in a local project runtime.'])
      const payload = await request(current, '/api/workflows')
      const source = stringValue(query.source)
      const workflows = objectList(payload.items).filter((workflow) => !source || stringValue(workflow.source) === source)
      const offset = workflowOffset(query.cursor)
      const limit = positiveLimit(query.limit, 50, MAX_WORKFLOW_PAGE)
      const page = workflows.slice(offset, offset + limit).map(mapWorkflowSummary)
      return {
        workflows: page,
        nextCursor: offset + page.length < workflows.length ? workflowCursor(offset + page.length) : null,
      }
    },
    async getWorkflow(_scope, _actor, workflowId, options = {}) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canListWorkflows', ['Start `nax dashboard` in a local project runtime.'])
      if (options.includeGraph) {
        const payload = await request(current, `/api/workflows/${encodeURIComponent(workflowId)}/graph`)
        return { workflow: mapWorkflow(payload.workflow), graph: mapGraph(payload.graph) }
      }
      const workflow = await request(current, `/api/workflows/${encodeURIComponent(workflowId)}`)
      return { workflow: mapWorkflow(workflow) }
    },
    async createWorkflowPlan(_scope, _actor, input) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canPlanRuns', ['Use the dashboard UI to inspect a dry run until workflow planning is installed.'])
      const workflowId = stringValue(input.workflowId)
      const payload = await request(current, `/api/run-plans/workflows/${encodeURIComponent(workflowId)}`, {
        method: 'POST',
        body: {
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.instances ? { instances: input.instances } : {}),
          ...(input.stepInstances ? { stepInstances: input.stepInstances } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.onlyStep ? { onlyStep: input.onlyStep } : {}),
          ...(input.fromStep ? { fromStep: input.fromStep } : {}),
        },
      })
      return /** @type {import('../../contracts').ControlPlanePlan} */ (objectValue(payload.plan))
    },
    async createAgentRunPlan(_scope, _actor, input) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canPlanRuns', ['Use the dashboard UI to configure a single-agent run until planning is installed.'])
      const payload = await request(current, '/api/run-plans/agents', {
        method: 'POST',
        body: {
          prompt: input.prompt,
          instance: input.instance,
          ...(input.branch ? { branch: input.branch } : {}),
        },
      })
      return /** @type {import('../../contracts').ControlPlanePlan} */ (objectValue(payload.plan))
    },
    async startPlan(_scope, _actor, planId, requestId) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canPlanRuns', ['Create and start the run from the dashboard UI.'])
      return /** @type {import('../../contracts').ControlPlaneStartResult} */ (await request(
        current,
        `/api/run-plans/${encodeURIComponent(planId)}/start`,
        { method: 'POST', body: { requestId } },
      ))
    },
    async listRuns(_scope, _actor, query = {}) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canReadRuns')
      const limit = positiveLimit(query.limit, 50, MAX_RUN_PAGE)
      const params = new URLSearchParams({ limit: String(limit) })
      if (query.cursor) params.set('cursor', stringValue(query.cursor))
      const payload = await request(current, `/api/runs?${params}`)
      const status = stringValue(query.status)
      const workflowId = stringValue(query.workflowId)
      const runs = objectList(payload.runs)
        .filter((run) => !status || stringValue(run.status) === status)
        .filter((run) => !workflowId || stringValue(run.flowId) === workflowId)
        .map((run) => mapRun(run, current.health))
      const pagination = objectValue(payload.pagination)
      return {
        runs,
        nextCursor: pagination.nextCursor ? stringValue(pagination.nextCursor) : null,
        ...(Number.isFinite(Number(pagination.total)) ? { total: Number(pagination.total) } : {}),
      }
    },
    async getRun(_scope, _actor, runId, options = { view: 'summary' }) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canReadRuns')
      const view = options.view || 'summary'
      if (view === 'details') {
        requireDashboardCapability(capabilities, 'canReadRunDetails')
        const response = await request(current, `/api/runs/${encodeURIComponent(runId)}/details`)
        const run = mapRun(response.run, current.health)
        return { run, view, details: mapRunDetails(response, run, identity.scope.scopeId, options.sectionId) }
      }
      if (view === 'graph') {
        const response = await request(current, `/api/runs/${encodeURIComponent(runId)}/graph`)
        return { run: mapRun(response.run, current.health), view, graph: mapGraph(response.graph) }
      }
      if (view === 'events') {
        requireDashboardCapability(capabilities, 'canReadEventsJson')
        const since = stringValue(options.since || '0')
        if (!/^\d+$/.test(since)) throw new LocalDashboardAdapterError('invalid_cursor', 'The event cursor must be a non-negative integer.', { statusCode: 400 })
        const response = await request(current, `/api/runs/${encodeURIComponent(runId)}/events.json?since=${encodeURIComponent(since)}`)
        const limit = positiveLimit(options.limit, 100, MAX_EVENT_PAGE)
        return {
          run: mapRun(response.run, current.health),
          view,
          events: mapEventPage(response, runId, limit),
        }
      }
      const raw = await rawRun(current, runId)
      return { run: mapRun(raw, current.health), view: /** @type {const} */ ('summary') }
    },
    async waitForRun(_scope, _actor, runId, cursor = '0', timeoutMs = 10000, signal) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canReadRuns')
      requireDashboardCapability(capabilities, 'canReadEventsJson')
      const since = stringValue(cursor || '0')
      if (!/^\d+$/.test(since)) throw new LocalDashboardAdapterError('invalid_cursor', 'The event cursor must be a non-negative integer.', { statusCode: 400 })
      const boundedTimeout = Math.min(Math.max(Number(timeoutMs) || 0, 0), MAX_WAIT_MS)
      const deadline = Date.now() + boundedTimeout
      while (true) {
        if (signal?.aborted) throw new LocalDashboardAdapterError('request_cancelled', 'The MCP client cancelled this wait.', { statusCode: 499 })
        const response = await request(current, `/api/runs/${encodeURIComponent(runId)}/events.json?since=${encodeURIComponent(since)}`)
        const run = mapRun(response.run, current.health)
        const events = mapEventPage(response, runId, MAX_EVENT_PAGE)
        if (events.events.length > 0) return { run, reason: /** @type {const} */ ('events'), events: events.events, nextCursor: events.nextCursor }
        const reason = waitReason(objectValue(response.run))
        if (reason) return { run, reason, events: [], nextCursor: since }
        const remaining = deadline - Date.now()
        if (remaining <= 0) return { run, reason: /** @type {const} */ ('timeout'), events: [], nextCursor: since, retryAfterMs: 500 }
        await delay(Math.min(WAIT_POLL_MS, remaining), signal)
      }
    },
    async cancelRun(_scope, _actor, target) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canCancelRuns')
      let response
      if (target.agentRunId) {
        const run = await rawRun(current, target.runId)
        const candidate = exactAgentRun(run, target.agentRunId)
        if (TERMINAL_STATUSES.has(stringValue(candidate.agentRun.status).toLowerCase())) {
          return { run: mapRun(run, current.health), cancelled: false, agentRunId: target.agentRunId, warnings: [] }
        }
        response = await request(current, `/api/runs/${encodeURIComponent(target.runId)}/agents/cancel`, {
          method: 'POST',
          body: {
            stepId: candidate.stepId,
            instanceId: candidate.instanceId,
            agent: stringValue(candidate.agentRun.agent),
            ...(candidate.agentRun.runnerId ? { runnerId: stringValue(candidate.agentRun.runnerId) } : {}),
            ...(target.reason ? { reason: target.reason } : {}),
          },
        })
      } else {
        const run = await rawRun(current, target.runId)
        if (TERMINAL_STATUSES.has(stringValue(run.status).toLowerCase())) {
          return { run: mapRun(run, current.health), cancelled: false, warnings: [] }
        }
        response = await request(current, `/api/runs/${encodeURIComponent(target.runId)}/cancel`, {
          method: 'POST',
          body: target.reason ? { reason: target.reason } : {},
        })
      }
      return {
        run: mapRun(response.run, current.health),
        cancelled: response.cancelled === true,
        ...(target.agentRunId ? { agentRunId: target.agentRunId } : {}),
        warnings: stringList(response.warnings),
      }
    },
    async retryAgentRun(_scope, _actor, input) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canStartRuns')
      let candidate
      try {
        candidate = exactAgentRun(await rawRun(current, input.runId), input.agentRunId)
      } catch (error) {
        if (!(error instanceof LocalDashboardAdapterError) || error.code !== 'agent_run_not_found') throw error
      }
      const response = await request(current, `/api/runs/${encodeURIComponent(input.runId)}/retry`, {
        method: 'POST',
        body: {
          agentRunId: input.agentRunId,
          ...(candidate ? { stepId: candidate.stepId, agent: stringValue(candidate.agentRun.agent) } : {}),
          ...(candidate?.agentRun.runnerId ? { runnerId: stringValue(candidate.agentRun.runnerId) } : {}),
          ...(candidate?.agentRun.sessionId ? { sessionId: stringValue(candidate.agentRun.sessionId) } : {}),
          requestId: input.requestId,
          reason: 'MCP agent_run_retry',
        },
      })
      const mappedRun = mapRun(response.run, current.health)
      const replacement = agentRunCandidates(objectValue(response.run)).find((item) => {
        if (response.runnerId && stringValue(item.agentRun.runnerId) !== stringValue(response.runnerId)) return false
        if (response.sessionId && stringValue(item.agentRun.sessionId) !== stringValue(response.sessionId)) return false
        return !candidate || item.stepId === candidate.stepId && stringValue(item.agentRun.agent) === stringValue(candidate.agentRun.agent)
      })
      if (!replacement) throw new LocalDashboardAdapterError('retry_result_missing', 'The dashboard accepted the retry but did not return the replacement agent run.', { statusCode: 502 })
      return {
        run: mappedRun,
        previousAgentRunId: input.agentRunId,
        agentRun: mapAgentRunCandidate(replacement),
        replayed: response.replayed === true,
      }
    },
    async submitFollowup(_scope, _actor, input) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canSubmitFollowups')
      const detailsResponse = await request(current, `/api/runs/${encodeURIComponent(input.runId)}/details`)
      const raw = objectValue(detailsResponse.run)
      const candidate = exactAgentRun(raw, input.agentRunId)
      const details = objectValue(detailsResponse.details)
      const targets = objectList(details.followupTargets).filter((target) => {
        if (candidate.agentRun.runnerId && stringValue(target.runnerId) !== stringValue(candidate.agentRun.runnerId)) return false
        if (candidate.agentRun.sessionId && stringValue(target.sessionId) !== stringValue(candidate.agentRun.sessionId)) return false
        return stringValue(target.stepId) === candidate.stepId
      })
      if (targets.length !== 1) {
        throw new LocalDashboardAdapterError(
          targets.length === 0 ? 'followup_target_not_found' : 'ambiguous_followup_target',
          'The exact follow-up target could not be resolved from this agent run.',
          { statusCode: targets.length === 0 ? 404 : 409, details: { runId: input.runId, agentRunId: input.agentRunId } },
        )
      }
      const instances = input.instances && input.instances.length > 0
        ? input.instances
        : [{
            agent: stringValue(candidate.agentRun.agent),
            ...(candidate.agentRun.model ? { model: stringValue(candidate.agentRun.model) } : {}),
            ...(candidate.agentRun.effort ? { effort: stringValue(candidate.agentRun.effort) } : {}),
          }]
      const providers = instances.map((instance) => instance.agent)
      if (new Set(providers).size !== providers.length) {
        throw new LocalDashboardAdapterError('unsupported_instance_lineup', 'This dashboard follow-up route cannot preserve repeated instances of the same agent provider.', {
          statusCode: 409,
          details: { alternatives: ['Use one instance per provider.', 'Upgrade to the structured follow-up route.'] },
        })
      }
      const artifactsById = new Map(objectList(details.followupArtifacts).map((artifact) => [stringValue(artifact.id), artifact]))
      const requestedArtifacts = (input.artifactIds || []).map((artifactId) => {
        const artifact = artifactsById.get(artifactId)
        if (!artifact) throw new LocalDashboardAdapterError('artifact_not_found', `Artifact "${artifactId}" does not belong to this run.`, { statusCode: 404 })
        return { id: artifactId, kind: stringValue(artifact.kind) }
      })
      const response = await request(current, `/api/runs/${encodeURIComponent(input.runId)}/followups`, {
        method: 'POST',
        body: {
          prompt: input.prompt,
          targetId: stringValue(targets[0].id),
          mode: input.mode || stringValue(targets[0].defaultMode || 'follow-up-thread'),
          agents: providers,
          models: Object.fromEntries(instances.filter((instance) => instance.model).map((instance) => [instance.agent, stringValue(instance.model)])),
          efforts: Object.fromEntries(instances.filter((instance) => instance.effort).map((instance) => [instance.agent, stringValue(instance.effort)])),
          artifacts: requestedArtifacts,
          requestId: input.requestId,
          agentRunId: input.agentRunId,
          artifactIds: input.artifactIds || [],
          instances,
        },
      })
      const followupResponse = objectValue(response.followup || response)
      const resultRun = objectValue(followupResponse.persistedWorkflow || followupResponse.sourceWorkflow)
      const mappedRun = Object.keys(resultRun).length > 0
        ? mapRun(resultRun, current.health)
        : mapRun(await rawRun(current, input.runId), current.health)
      const submissions = objectList(followupResponse.submissions).map((submission, index) => {
        const synthetic = {
          ...submission,
          instanceId: stringValue(submission.instanceId || submission.agent),
        }
        return mapAgentRunCandidate({
          run: { runId: mappedRun.runId },
          step: {},
          agentRun: synthetic,
          stepId: '',
          instanceId: stringValue(synthetic.instanceId),
          agentRunId: agentRunIdFor(mappedRun.runId, '', synthetic, index),
          index,
        })
      })
      return {
        sourceRunId: input.runId,
        run: mappedRun,
        agentRuns: submissions,
        replayed: followupResponse.replayed === true,
        warnings: stringList(followupResponse.warnings),
      }
    },
    async resolveReviewGate(_scope, _actor, input) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canReviewGates')
      const raw = await rawRun(current, input.runId)
      const gate = reviewGateForRun(raw)
      if (!gate || gate.reviewGateId !== input.reviewGateId) {
        throw new LocalDashboardAdapterError('review_gate_not_found', `Review gate "${input.reviewGateId}" was not found in this workflow run.`, {
          statusCode: 404,
          details: { runId: input.runId, reviewGateId: input.reviewGateId, reviewGateIds: gate ? [gate.reviewGateId] : [] },
        })
      }
      const resolvedStatus = input.decision === 'approve' ? 'approved' : 'cancelled'
      if (gate.status !== 'awaiting') {
        if (gate.status !== resolvedStatus) {
          throw new LocalDashboardAdapterError('no_review_gate', `Review gate "${input.reviewGateId}" was already resolved as ${gate.status}.`, {
            statusCode: 409,
            details: { runId: input.runId, reviewGateId: input.reviewGateId, status: gate.status },
          })
        }
        return { run: mapRun(raw, current.health), reviewGate: gate, replayed: true }
      }
      const response = await request(current, `/api/runs/${encodeURIComponent(input.runId)}/review/${input.decision}`, {
        method: 'POST',
        body: {
          stepId: gate.stepId,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      })
      return {
        run: mapRun(response.run, current.health),
        reviewGate: { ...gate, status: resolvedStatus, ...(input.reason ? { reason: input.reason } : {}) },
        replayed: response.replayed === true,
      }
    },
    async getArtifact(_scope, _actor, runId, artifactId) {
      const current = await session()
      const capabilities = objectValue(current.health.capabilities)
      requireDashboardCapability(capabilities, 'canReadRunArtifacts', ['Use run_get with view "details" for bounded markdown summaries.'])
      const response = await request(current, `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`)
      const artifact = objectValue(response.artifact)
      const encoding = stringValue(artifact.encoding)
      const content = stringValue(artifact.content)
      return {
        runId: stringValue(artifact.runId || runId),
        artifactId: stringValue(artifact.artifactId || artifactId),
        contentType: stringValue(artifact.contentType || 'application/octet-stream'),
        sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : Buffer.byteLength(content, encoding === 'base64' ? 'base64' : 'utf8'),
        content: encoding === 'base64' ? Uint8Array.from(Buffer.from(content, 'base64')) : content,
      }
    },
  }
}

/**
 * @param {LocalDashboardAdapterOptions} options
 * @returns {{ controlPlane: NaxControlPlane, scope: ControlPlaneScope, actor: ControlPlaneActor }}
 */
function composeLocalDashboardControlPlane(options) {
  if (!options || !options.projectRoot) throw new TypeError('projectRoot is required.')
  const identity = localDashboardIdentity(options.projectRoot, { userId: options.userId })
  const controlPlane = createNaxControlPlane(createLocalDashboardPorts(options, identity))
  return { controlPlane, ...identity }
}

/** @param {LocalDashboardAdapterOptions} options @returns {NaxControlPlane} */
function createLocalDashboardControlPlane(options) {
  return composeLocalDashboardControlPlane(options).controlPlane
}

/** @param {LocalDashboardAdapterOptions} options @returns {NaxControlPlaneClient} */
function createLocalDashboardClient(options) {
  const binding = composeLocalDashboardControlPlane(options)
  return createMcpControlPlaneClient(binding)
}

module.exports = {
  LocalDashboardAdapterError,
  agentRunCandidates,
  composeLocalDashboardControlPlane,
  createLocalDashboardClient,
  createLocalDashboardControlPlane,
  createLocalDashboardPorts,
  localDashboardIdentity,
  mapCapabilities,
  mapEventPage,
  mapGraph,
  mapRun,
  mapWorkflow,
  mapWorkflowSummary,
  safeJsonObject,
}
