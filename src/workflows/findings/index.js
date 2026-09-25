// Builds, reads and writes the findings.json artifact from a workflow run's structured output.
// Adapter ids must match FINDINGS_ADAPTER_IDS in src/core/constants.js.
const fs = require('fs')
const path = require('path')
const { findStructuredBlocks } = require('./extract')
const { reviewConsensusAdapter } = require('./adapters/review-consensus')
const { writeJson } = require('../../storage/local/artifact-fs')
const { artifactsRootForRunState } = require('../artifacts/workflow-artifacts')

const FINDINGS_SCHEMA_VERSION = 1

/** @type {Record<string, typeof reviewConsensusAdapter>} */
const FINDINGS_ADAPTERS = {
  'review-consensus': reviewConsensusAdapter,
}

/**
 * @typedef {import('./adapters/review-consensus').AdaptedFinding & { key: string, sourceLocalId?: string }} Finding
 * @typedef {{ stepId: string, instanceId: string, code: string, message: string }} FindingsDiagnostic
 * @typedef {{
 *   schemaVersion: number,
 *   runId: string,
 *   flowId: string,
 *   adapter: string,
 *   generatedAt: string,
 *   source: { stepId: string, instanceId: string, runnerId: string, sessionId: string, resultUrl: string | null },
 *   target: { branch: string, sha: string | null, pullRequest?: { number: number, url: string, isCrossRepository: boolean } },
 *   findings: Finding[],
 *   diagnostics: FindingsDiagnostic[],
 * }} FindingsArtifact
 * @typedef {import('../../types').WorkflowRunState} WorkflowRunState
 * @typedef {import('../../types').WorkflowFlow} WorkflowFlow
 */

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** Percent-encodes characters that would make a findings key ambiguous. @param {string} value */
function encodeKeySegment(value) {
  return value.replace(/[%/:]/g, (char) => encodeURIComponent(char))
}

/** @param {import('../../types').AgentRun} run */
function runInstanceId(run) {
  return text(run.instanceId || run.agent)
}

/**
 * Provider names and instance labels across the run's steps, used to validate attribution.
 * @param {WorkflowRunState} runState
 * @param {WorkflowFlow} flow
 */
function knownAgentsFor(runState, flow) {
  const agents = new Set()
  for (const step of [...(flow.steps || []), ...(runState.steps || [])]) {
    for (const agent of step.agents || []) agents.add(text(agent))
    for (const run of step.runs || []) {
      if (run.agent) agents.add(text(run.agent))
      if (run.instanceLabel) agents.add(text(run.instanceLabel))
    }
  }
  return [...agents].filter(Boolean)
}

/** @param {WorkflowRunState} runState */
function artifactTarget(runState) {
  const target = /** @type {Record<string, unknown>} */ (runState.target || {})
  const pullRequest = target.pullRequest && typeof target.pullRequest === 'object'
    ? /** @type {{ number: number, url: string, isCrossRepository: boolean }} */ (target.pullRequest)
    : null
  return {
    branch: text(target.branch || runState.branch),
    sha: target.sha ? text(target.sha) : null,
    ...(pullRequest ? { pullRequest } : {}),
  }
}

/**
 * Builds the findings artifact purely from run state; returns null when the flow declares no findings.
 * Only current attempts (`step.runs`) are read.
 * @param {WorkflowRunState} runState
 * @param {WorkflowFlow | null} [flow]
 * @param {{ now?: Date }} [options]
 * @returns {FindingsArtifact | null}
 */
function buildFindings(runState, flow = runState.flow || null, { now = new Date() } = {}) {
  const declaration = flow && flow.findings
  if (!declaration) return null
  const adapter = FINDINGS_ADAPTERS[declaration.adapter]
  const stepId = declaration.step
  const step = (runState.steps || []).find((candidate) => candidate.id === stepId)
  const runs = (step?.runs || []).filter((run) => run.status === 'completed' && text(run.resultText).trim())
  const knownAgents = knownAgentsFor(runState, flow)
  /** @type {Finding[]} */
  const findings = []
  /** @type {FindingsDiagnostic[]} */
  const diagnostics = []
  if (!adapter) {
    diagnostics.push({ stepId, instanceId: '', code: 'unknown_findings_adapter', message: `Findings adapter "${declaration.adapter}" is not registered.` })
  } else if (runs.length === 0) {
    diagnostics.push({ stepId, instanceId: '', code: 'no_completed_source_run', message: `Step "${stepId}" has no completed run with results.` })
  }
  const fanOut = runs.length > 1
  for (const run of adapter ? runs : []) {
    const instanceId = runInstanceId(run)
    const result = adapter(findStructuredBlocks(text(run.resultText)), { knownAgents })
    for (const diagnostic of result.diagnostics) diagnostics.push({ stepId, instanceId, ...diagnostic })
    for (const finding of result.findings) {
      const localId = fanOut ? `${encodeKeySegment(instanceId)}:${finding.localId}` : finding.localId
      findings.push({
        ...finding,
        key: `${runState.runId}/${stepId}/${localId}`,
        localId,
        ...(fanOut ? { sourceLocalId: finding.localId, rank: null } : {}),
      })
    }
  }
  const sourceRun = runs[0]
  return {
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    runId: text(runState.runId),
    flowId: text(runState.flowId || flow.id),
    adapter: declaration.adapter,
    generatedAt: now.toISOString(),
    source: {
      stepId,
      instanceId: sourceRun ? runInstanceId(sourceRun) : '',
      runnerId: text(sourceRun?.runnerId),
      sessionId: text(sourceRun?.sessionId),
      resultUrl: text(sourceRun?.issueUrl || sourceRun?.commentUrl) || null,
    },
    target: artifactTarget(runState),
    findings,
    diagnostics,
  }
}

/** @param {WorkflowRunState} runState */
function findingsPath(runState) {
  const root = artifactsRootForRunState(runState)
  return root ? path.join(root, 'findings.json') : ''
}

/**
 * Returns the persisted findings artifact, or builds it in memory. Never writes.
 * @param {WorkflowRunState} runState
 * @param {WorkflowFlow | null} [flow]
 * @returns {FindingsArtifact | null}
 */
function readFindings(runState, flow = runState.flow || null) {
  const target = findingsPath(runState)
  if (target && fs.existsSync(target)) {
    try {
      return /** @type {FindingsArtifact} */ (JSON.parse(fs.readFileSync(target, 'utf8')))
    } catch (_error) {
      // A corrupt artifact is rebuilt from run state below.
    }
  }
  return buildFindings(runState, flow)
}

/**
 * Builds and atomically writes findings.json. Only terminal run transitions call this.
 * @param {WorkflowRunState} runState
 * @param {WorkflowFlow | null} [flow]
 * @param {{ now?: Date }} [options]
 * @returns {FindingsArtifact | null}
 */
function writeFindings(runState, flow = runState.flow || null, options = {}) {
  const artifact = buildFindings(runState, flow, options)
  const target = findingsPath(runState)
  if (!artifact || !target) return artifact
  writeJson(target, artifact)
  return artifact
}

module.exports = {
  FINDINGS_ADAPTERS,
  FINDINGS_SCHEMA_VERSION,
  buildFindings,
  findingsPath,
  readFindings,
  writeFindings,
}
