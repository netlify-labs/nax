const path = require('node:path')
const { redactSecretText } = require('./security')

const MAX_CANARY_CREDITS = 100
const MAX_CANARY_TIMEOUT_MS = 30 * 60 * 1000
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,254}$/
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DIAGNOSTIC_FIELDS = new Set([
  'accountSlug', 'agentRuns', 'artifactBytes', 'branch', 'credits', 'cursor',
  'elapsedMs', 'error', 'eventCount', 'expectedAgentRuns', 'maxCredits',
  'maxRunners', 'planId', 'reason', 'repository', 'requestId', 'runId',
  'runtime', 'siteId', 'status', 'timeoutMs',
])

/**
 * @typedef {{
 *   projectRoot: string,
 *   repository: string,
 *   siteId: string,
 *   accountSlug: string,
 *   branch: string,
 *   agent: string,
 *   requestId: string,
 *   maxRunners: 1,
 *   maxCredits: number,
 *   timeoutMs: number,
 * }} McpCanaryConfig
 */

/** @param {NodeJS.ProcessEnv} env @param {string} name */
function requiredEnv(env, name) {
  const value = String(env[name] || '').trim()
  if (!value) throw new Error(`${name} is required for the real MCP Agent Runner canary.`)
  return value
}

/** @param {string} name @param {string} value @param {RegExp} pattern */
function safeValue(name, value, pattern) {
  if (!pattern.test(value) || value.includes('..') || value.includes('//')) {
    throw new Error(`${name} must be one concrete safe value.`)
  }
  return value
}

/** @param {string} name @param {string} value @param {{ minimum: number, maximum: number }} bounds */
function boundedNumber(name, value, { minimum, maximum }) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number from ${minimum} through ${maximum}.`)
  }
  return parsed
}

/**
 * Parses the explicit fail-closed opt-in contract for the real canary.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ canonicalize?: (projectRoot: string) => string }} [options]
 * @returns {McpCanaryConfig}
 */
function loadMcpCanaryConfig(env = process.env, { canonicalize = (projectRoot) => path.resolve(projectRoot) } = {}) {
  if (env.NAX_MCP_CANARY !== '1') {
    throw new Error('Set NAX_MCP_CANARY=1 only when authorizing one real, credit-consuming Agent Runner canary.')
  }
  const maxRunners = boundedNumber('NAX_MCP_CANARY_MAX_RUNNERS', requiredEnv(env, 'NAX_MCP_CANARY_MAX_RUNNERS'), { minimum: 1, maximum: 1 })
  const maxCredits = boundedNumber('NAX_MCP_CANARY_MAX_CREDITS', requiredEnv(env, 'NAX_MCP_CANARY_MAX_CREDITS'), { minimum: 0.000001, maximum: MAX_CANARY_CREDITS })
  const timeoutMs = boundedNumber('NAX_MCP_CANARY_TIMEOUT_MS', requiredEnv(env, 'NAX_MCP_CANARY_TIMEOUT_MS'), { minimum: 1000, maximum: MAX_CANARY_TIMEOUT_MS })
  return {
    projectRoot: canonicalize(requiredEnv(env, 'NAX_MCP_CANARY_PROJECT_ROOT')),
    repository: safeValue('NAX_MCP_CANARY_REPOSITORY', requiredEnv(env, 'NAX_MCP_CANARY_REPOSITORY'), REPOSITORY).toLowerCase(),
    siteId: safeValue('NAX_MCP_CANARY_SITE_ID', requiredEnv(env, 'NAX_MCP_CANARY_SITE_ID'), SAFE_NAME),
    accountSlug: safeValue('NAX_MCP_CANARY_ACCOUNT_SLUG', requiredEnv(env, 'NAX_MCP_CANARY_ACCOUNT_SLUG'), SAFE_NAME),
    branch: safeValue('NAX_MCP_CANARY_BRANCH', requiredEnv(env, 'NAX_MCP_CANARY_BRANCH'), SAFE_BRANCH),
    agent: safeValue('NAX_MCP_CANARY_AGENT', requiredEnv(env, 'NAX_MCP_CANARY_AGENT'), SAFE_NAME),
    requestId: safeValue('NAX_MCP_CANARY_REQUEST_ID', requiredEnv(env, 'NAX_MCP_CANARY_REQUEST_ID'), SAFE_NAME),
    maxRunners: /** @type {1} */ (maxRunners),
    maxCredits,
    timeoutMs,
  }
}

/**
 * Normalizes common GitHub remote URL forms to owner/name.
 * @param {string} remote
 */
function repositoryFromRemote(remote) {
  const trimmed = String(remote || '').trim().replace(/\.git$/, '')
  const match = trimmed.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+)$/i)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : ''
}

/** @param {McpCanaryConfig} config @param {string} remote */
function assertCanaryRepository(config, remote) {
  const actual = repositoryFromRemote(remote)
  if (!actual || actual !== config.repository) {
    throw new Error(`The project Git remote does not match the allowed canary repository ${config.repository}.`)
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {McpCanaryConfig} config @param {unknown} context */
function assertCanaryContext(config, context) {
  const value = objectValue(context)
  const target = objectValue(value.target)
  if (String(value.runtime || '') !== 'local-dashboard') throw new Error('The real canary requires the shipped local-dashboard runtime.')
  if (String(target.siteId || '') !== config.siteId) throw new Error(`context_get did not select the allowed site ${config.siteId}.`)
  if (String(target.accountSlug || '') !== config.accountSlug) throw new Error(`context_get did not select the allowed account ${config.accountSlug}.`)
  const capabilities = objectValue(value.capabilities)
  for (const name of ['agent_run_plan', 'run_start', 'run_wait', 'run_get', 'resource_read']) {
    if (objectValue(capabilities[name]).available !== true) throw new Error(`Required canary capability ${name} is unavailable.`)
  }
}

/** @param {McpCanaryConfig} config @param {unknown} plan */
function assertCanaryPlan(config, plan) {
  const value = objectValue(plan)
  const target = objectValue(value.target)
  if (String(value.kind || '') !== 'agent-run') throw new Error('The canary accepts only a single-agent plan.')
  if (Number(value.expectedAgentRuns) !== config.maxRunners) throw new Error(`The canary plan must contain exactly ${config.maxRunners} Agent Runner.`)
  if (String(target.siteId || '') !== config.siteId || String(target.accountSlug || '') !== config.accountSlug) {
    throw new Error('The canary plan target changed after context verification.')
  }
  if (String(target.branch || '') !== config.branch) throw new Error(`The canary plan did not resolve allowed branch ${config.branch}.`)
  if (!String(value.planId || '')) throw new Error('The canary plan omitted planId.')
}

/** @param {McpCanaryConfig} config @param {unknown} run */
function assertCanaryUsage(config, run) {
  const usage = objectValue(objectValue(run).usageTotals)
  const credits = Number(usage.totalCreditsCost)
  if (!Number.isFinite(credits)) throw new Error('The terminal canary run did not report totalCreditsCost.')
  if (credits > config.maxCredits) throw new Error(`The canary used ${credits} credits, above the asserted ${config.maxCredits}-credit ceiling.`)
  return credits
}

/**
 * Produces one value-free diagnostic record. Details must be counts, IDs,
 * statuses, cursors, or elapsed timings; prompt and artifact content are never accepted.
 * @param {string} phase
 * @param {Record<string, string | number | boolean | null>} details
 * @returns {Record<string, string | number | boolean | null>}
 */
function canaryDiagnostic(phase, details) {
  const safeDetails = /** @type {Record<string, string | number | boolean | null>} */ ({})
  for (const [key, value] of Object.entries(details)) {
    if (!DIAGNOSTIC_FIELDS.has(key)) throw new Error(`Unsupported canary diagnostic field ${key}.`)
    safeDetails[key] = typeof value === 'string' ? redactSecretText(value).slice(0, 512) : value
  }
  return { phase: redactSecretText(phase).slice(0, 100), at: new Date().toISOString(), ...safeDetails }
}

module.exports = {
  MAX_CANARY_CREDITS,
  MAX_CANARY_TIMEOUT_MS,
  assertCanaryContext,
  assertCanaryPlan,
  assertCanaryRepository,
  assertCanaryUsage,
  canaryDiagnostic,
  loadMcpCanaryConfig,
  repositoryFromRemote,
}
