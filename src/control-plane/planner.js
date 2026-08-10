const { resolveLineup } = require('../core/agents/instances')
const { findStepRange, resolvedLineupForStep } = require('../core/planning/workflow')

const REMOTE_TRANSPORT = 'netlify-api'
const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000
const MAX_CONTEXT_BYTES = 64 * 1024
const MAX_PROMPT_BYTES = 80 * 1024
const PROMPT_OFFLOAD_WARNING_BYTES = 70 * 1024

/** @typedef {import('../contracts').ControlPlaneAgentInstance} ControlPlaneAgentInstance */
/** @typedef {import('../contracts').ControlPlaneAgentInstanceInput} ControlPlaneAgentInstanceInput */
/** @typedef {import('../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject */
/** @typedef {import('../contracts').ControlPlanePlan} ControlPlanePlan */
/** @typedef {import('../contracts').ControlPlanePlanWarning} ControlPlanePlanWarning */
/** @typedef {import('../contracts').ControlPlaneScope} ControlPlaneScope */
/** @typedef {import('../contracts').ControlPlaneTarget} ControlPlaneTarget */
/** @typedef {import('../contracts').ControlPlaneWorkflowPlanInput} ControlPlaneWorkflowPlanInput */
/** @typedef {import('../contracts').ControlPlaneAgentRunPlanInput} ControlPlaneAgentRunPlanInput */

/**
 * @typedef {{
 *   plan: ControlPlanePlan,
 *   normalizedInput: ControlPlaneJsonObject,
 *   requestHash: string,
 *   transport: 'netlify-api',
 * }} PreparedControlPlanePlan
 */

/** @param {string} code @param {string} message @param {ControlPlaneJsonObject} [details] */
function plannerError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, recoverable: true, details })
}

/** @param {unknown} value */
function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || '')).byteLength
}

/** @param {import('../types').WorkflowStep} step */
function isHumanReviewStep(step) {
  return String(step.type || step.action || '').trim() === 'human-review'
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** @param {unknown} value @returns {unknown} */
function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]))
}

/** @param {unknown} value */
function stableJson(value) {
  return JSON.stringify(sortedJsonValue(value))
}

const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** @param {number} value @param {number} bits */
function rotateRight(value, bits) {
  return value >>> bits | value << 32 - bits
}

/**
 * Portable synchronous SHA-256 used only for canonical plan identity. It uses
 * Web-platform primitives so the control-plane domain stays Node-independent.
 * @param {string} text
 */
function sha256(text) {
  const input = new TextEncoder().encode(text)
  const bitLength = BigInt(input.length) * 8n
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(input)
  bytes[input.length] = 0x80
  for (let index = 0; index < 8; index += 1) bytes[paddedLength - 1 - index] = Number(bitLength >> BigInt(index * 8) & 0xffn)

  /** @type {number[]} */
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4
      words[index] = bytes[position] << 24 | bytes[position + 1] << 16 | bytes[position + 2] << 8 | bytes[position + 3]
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]
      const right = words[index - 2]
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ left >>> 3
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ right >>> 10
      words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1
    }

    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = e & f ^ ~e & g
      const temp1 = h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = a & b ^ a & c ^ b & c
      const temp2 = sum0 + majority
      h = g
      g = f
      f = e
      e = d + temp1 >>> 0
      d = c
      c = b
      b = a
      a = temp1 + temp2 >>> 0
    }
    hash[0] = hash[0] + a >>> 0
    hash[1] = hash[1] + b >>> 0
    hash[2] = hash[2] + c >>> 0
    hash[3] = hash[3] + d >>> 0
    hash[4] = hash[4] + e >>> 0
    hash[5] = hash[5] + f >>> 0
    hash[6] = hash[6] + g >>> 0
    hash[7] = hash[7] + h >>> 0
  }
  return hash.map((value) => value.toString(16).padStart(8, '0')).join('')
}

/** @param {unknown} value */
function requestHash(value) {
  return sha256(stableJson(value))
}

/**
 * @param {ControlPlaneScope} scope
 * @param {ControlPlaneTarget} target
 * @param {string | undefined} requestedBranch
 */
function assertPlanBinding(scope, target, requestedBranch) {
  if (!scope?.scopeId || !scope.projectId) throw plannerError('invalid_scope', 'Planning requires a stable project scope.')
  if (!target?.siteId || !target.siteName) throw plannerError('no_site', 'Planning requires one selected Netlify site.')
  if (!target.verified) throw plannerError('unverified_target', 'Remote Agent Runner planning requires a verified Netlify target.', { siteId: target.siteId })
  if (!target.branch) throw plannerError('invalid_target', 'Remote Agent Runner planning requires a concrete target branch.', { siteId: target.siteId })
  if (scope.siteId && scope.siteId !== target.siteId) {
    throw plannerError('project_scope_mismatch', 'The selected Netlify site does not match the immutable control-plane scope.', {
      scopeSiteId: scope.siteId,
      targetSiteId: target.siteId,
    })
  }
  if (scope.accountId && target.accountId && scope.accountId !== target.accountId) {
    throw plannerError('project_scope_mismatch', 'The selected Netlify account does not match the immutable control-plane scope.', {
      scopeAccountId: scope.accountId,
      targetAccountId: target.accountId,
    })
  }
  if (requestedBranch && requestedBranch !== target.branch) {
    throw plannerError('target_branch_mismatch', 'The verified target branch does not match the requested plan branch.', {
      requestedBranch,
      targetBranch: target.branch,
    })
  }
}

/** @param {string} transport */
function assertRemoteTransport(transport) {
  if (transport !== REMOTE_TRANSPORT) {
    throw plannerError('unsupported_transport', `Control-plane plans require "${REMOTE_TRANSPORT}"; "${transport || 'auto'}" is not supported.`, {
      requestedTransport: transport || 'auto',
      supportedTransport: REMOTE_TRANSPORT,
    })
  }
}

/**
 * @param {Record<string, unknown>} input
 * @param {string[]} allowed
 */
function assertPlanInputKeys(input, allowed) {
  const extra = Object.keys(input).filter((key) => !allowed.includes(key))
  if (extra.length === 0) return
  const instanceContractFields = extra.filter((key) => ['agents', 'models', 'efforts', 'stepAgents', 'stepModels', 'stepEfforts'].includes(key))
  if (instanceContractFields.length > 0) {
    throw plannerError('invalid_instance_contract', 'Plans accept only structured instances with inline agent, model, effort, and label fields.', { fields: instanceContractFields })
  }
  throw plannerError('invalid_arguments', `Unsupported plan input field${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}.`, { fields: extra })
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {ControlPlaneAgentInstanceInput[]}
 */
function structuredInstances(value, path) {
  if (!Array.isArray(value)) throw plannerError('invalid_instance_contract', `${path} must be an array of agent instance objects.`)
  /** @type {ControlPlaneAgentInstanceInput[]} */
  const result = []
  const labels = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (!isObject(item)) {
      throw plannerError('invalid_instance_contract', `${path}[${index}] must be an object such as { agent, model, effort }; provider-only arrays are not accepted.`)
    }
    const extraKeys = Object.keys(item).filter((key) => !['agent', 'model', 'effort', 'label'].includes(key))
    if (extraKeys.length > 0 || 'models' in item || 'efforts' in item) {
      throw plannerError('invalid_instance_contract', `${path}[${index}] must use singular agent, model, effort, and label fields.`, { fields: extraKeys })
    }
    const agent = String(item.agent || '').trim()
    if (!agent) throw plannerError('invalid_instance_contract', `${path}[${index}].agent is required.`)
    const model = item.model === undefined ? '' : String(item.model).trim()
    const effort = item.effort === undefined ? '' : String(item.effort).trim()
    const label = item.label === undefined ? '' : String(item.label).trim()
    if (label && labels.has(label)) throw plannerError('duplicate_instance_label', `Instance label "${label}" appears more than once in ${path}.`)
    if (label) labels.add(label)
    result.push({ agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(label ? { label } : {}) })
  }
  if (result.length === 0) throw plannerError('invalid_instance_contract', `${path} must contain at least one agent instance.`)
  return result
}

/**
 * @param {ControlPlaneAgentInstanceInput[]} entries
 * @returns {{ instances: ControlPlaneAgentInstance[], warnings: ControlPlanePlanWarning[] }}
 */
function resolveStructuredInstances(entries) {
  const resolved = resolveLineup(entries, { requestedTransport: REMOTE_TRANSPORT })
  return {
    instances: resolved.instances.map((instance) => ({
      instanceId: instance.id,
      agent: instance.agent,
      ...(instance.model ? { model: instance.model } : {}),
      ...(instance.effort ? { effort: instance.effort } : {}),
      ...(instance.label ? { label: instance.label } : {}),
      resolvedFrom: instance.resolvedFrom,
    })),
    warnings: resolved.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
  }
}

/** @param {import('../types').WorkflowStep} step */
function declaredProviders(step) {
  return new Set((Array.isArray(step.agents) ? step.agents : []).map(String))
}

/**
 * @param {ControlPlaneAgentInstanceInput[]} entries
 * @param {import('../types').WorkflowStep} step
 * @param {string} path
 */
function assertStepProviders(entries, step, path) {
  const declared = declaredProviders(step)
  for (const entry of entries) {
    if (!declared.has(entry.agent)) {
      throw plannerError('invalid_step_agent', `Agent "${entry.agent}" is not configured for step "${step.id}".`, {
        stepId: String(step.id || ''),
        path,
      })
    }
  }
}

/**
 * @param {import('../types').AgentInstance[]} instances
 * @returns {ControlPlaneAgentInstance[]}
 */
function controlPlaneInstances(instances) {
  return instances.map((instance) => ({
    instanceId: instance.id,
    agent: instance.agent,
    ...(instance.model ? { model: instance.model } : {}),
    ...(instance.effort ? { effort: instance.effort } : {}),
    ...(instance.label ? { label: instance.label } : {}),
    resolvedFrom: instance.resolvedFrom,
  }))
}

/** @param {ControlPlanePlanWarning[]} warnings */
function uniqueWarnings(warnings) {
  const seen = new Set()
  return warnings.filter((warning) => {
    const key = `${warning.code}\u0000${warning.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * @param {{
 *   planId: string,
 *   now: Date,
 *   ttlMs?: number,
 *   scope: ControlPlaneScope,
 *   target: ControlPlaneTarget,
 *   flow: import('../types').WorkflowFlow,
 *   input: ControlPlaneWorkflowPlanInput,
 *   transport?: string,
 *   promptBytesByStep?: Record<string, number>,
 * }} options
 * @returns {PreparedControlPlanePlan}
 */
function prepareWorkflowPlan({
  planId,
  now,
  ttlMs = DEFAULT_PLAN_TTL_MS,
  scope,
  target,
  flow,
  input,
  transport = REMOTE_TRANSPORT,
  promptBytesByStep = {},
}) {
  assertRemoteTransport(transport)
  assertPlanInputKeys(/** @type {Record<string, unknown>} */ (input), ['workflowId', 'branch', 'instances', 'stepInstances', 'context', 'onlyStep', 'fromStep'])
  assertPlanBinding(scope, target, input.branch)
  if (!planId) throw plannerError('invalid_plan_id', 'Planning requires an explicit plan ID.')
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw plannerError('invalid_clock', 'Planning requires an explicit valid clock.')
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw plannerError('invalid_plan_ttl', 'Plan TTL must be a positive integer.')
  if (!flow?.id || flow.id !== input.workflowId) {
    throw plannerError('workflow_not_found', `Workflow "${input.workflowId}" does not match the loaded workflow.`, { workflowId: input.workflowId })
  }
  if (input.context && utf8Bytes(input.context) > MAX_CONTEXT_BYTES) {
    throw plannerError('context_too_large', `Workflow context must be at most ${MAX_CONTEXT_BYTES} UTF-8 bytes.`)
  }

  const allSteps = Array.isArray(flow.steps) ? flow.steps : []
  const stepsById = new Map(allSteps.map((step) => [String(step.id || ''), step]))
  const stepInput = input.stepInstances || {}
  for (const stepId of Object.keys(stepInput)) {
    const step = stepsById.get(stepId)
    if (!step) throw plannerError('invalid_step', `Unknown step "${stepId}" in workflow "${flow.id}".`, { workflowId: String(flow.id), stepId })
    if (step.submit === 'follow-up') {
      throw plannerError('invalid_instance_contract', `step_instances cannot override follow-up step "${stepId}"; configure its first input step instead.`, { stepId })
    }
  }

  const globalEntries = input.instances ? structuredInstances(input.instances, 'instances') : null
  if (globalEntries) {
    const available = new Set(allSteps.flatMap((step) => [...declaredProviders(step)]))
    for (const entry of globalEntries) {
      if (!available.has(entry.agent)) {
        throw plannerError('invalid_agent', `Agent "${entry.agent}" is not configured anywhere in workflow "${flow.id}".`)
      }
    }
  }

  /** @type {Map<string, ControlPlaneAgentInstance[]>} */
  const plannedInstances = new Map()
  /** @type {ControlPlanePlanWarning[]} */
  const warnings = []
  for (const warning of flow.warnings || []) {
    warnings.push({ code: String(warning.code || 'workflow_warning'), message: `${warning.stepId ? `${warning.stepId}: ` : ''}${warning.message || warning.hint || 'Workflow warning'}` })
  }
  for (const caveat of target.caveats || []) warnings.push({ code: `target_${caveat.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`, message: `Target caveat: ${caveat}.` })

  for (const step of allSteps) {
    const stepId = String(step.id || '')
    if (isHumanReviewStep(step)) {
      plannedInstances.set(stepId, [])
      continue
    }
    if (step.submit === 'follow-up') {
      const sourceId = String(step.input?.[0]?.step || '')
      const inherited = plannedInstances.get(sourceId)
      if (!sourceId || !inherited) {
        throw plannerError('invalid_followup_source', `Follow-up step "${stepId}" requires an earlier input step with a resolved lineup.`, { stepId, sourceStepId: sourceId })
      }
      plannedInstances.set(stepId, inherited.map((instance) => ({ ...instance })))
      continue
    }

    let resolved
    if (stepInput[stepId]) {
      const entries = structuredInstances(stepInput[stepId], `step_instances.${stepId}`)
      assertStepProviders(entries, step, `step_instances.${stepId}`)
      resolved = resolveStructuredInstances(entries)
    } else if (globalEntries) {
      const declared = declaredProviders(step)
      const entries = globalEntries.filter((entry) => declared.has(entry.agent))
      resolved = entries.length > 0 ? resolveStructuredInstances(entries) : { instances: [], warnings: [] }
    } else {
      const lineup = resolvedLineupForStep(flow, step, {}, REMOTE_TRANSPORT)
      resolved = {
        instances: controlPlaneInstances(lineup.instances),
        warnings: lineup.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
      }
    }
    plannedInstances.set(stepId, resolved.instances)
    for (const warning of resolved.warnings) warnings.push({ code: warning.code, message: `${stepId}: ${warning.message}` })
    const promptBytes = Number(promptBytesByStep[stepId] || 0)
    if (promptBytes > PROMPT_OFFLOAD_WARNING_BYTES) {
      warnings.push({
        code: promptBytes > MAX_PROMPT_BYTES ? 'prompt_offload_required' : 'prompt_near_inline_limit',
        message: `${stepId}: ${promptBytes} prompt bytes require bounded delivery${promptBytes > MAX_PROMPT_BYTES ? ' via artifact/blob offload' : ''}.`,
      })
    }
  }

  const selected = findStepRange(flow, { onlyStep: input.onlyStep, fromStep: input.fromStep })
    .filter((step) => isHumanReviewStep(step) || step.submit === 'follow-up' || (plannedInstances.get(String(step.id || ''))?.length || 0) > 0)
  if (selected.length === 0) throw plannerError('no_runnable_steps', 'No workflow steps have selected remote agent instances.')
  const steps = selected.map((step) => {
    const instances = plannedInstances.get(String(step.id || '')) || []
    return {
      stepId: String(step.id || ''),
      title: String(step.title || step.id || ''),
      ...(step.description ? { description: String(step.description) } : {}),
      action: String(step.action || step.type || ''),
      submit: String(step.submit || ''),
      waitFor: String(step.waitFor || ''),
      agents: [...new Set(instances.map((instance) => instance.agent))],
      instances: instances.map((instance) => ({ ...instance })),
      reviewGate: isHumanReviewStep(step),
    }
  })
  const instances = [...new Map(steps.flatMap((step) => step.instances).map((instance) => [instance.instanceId, instance])).values()]
  const expectedAgentRuns = steps.reduce((total, step) => total + step.instances.length, 0)
  const normalizedInput = /** @type {ControlPlaneJsonObject} */ ({
    workflowId: input.workflowId,
    branch: target.branch,
    transport: REMOTE_TRANSPORT,
    ...(globalEntries ? { instances: globalEntries } : {}),
    ...(Object.keys(stepInput).length > 0 ? { stepInstances: Object.fromEntries(Object.entries(stepInput).map(([stepId, entries]) => [stepId, structuredInstances(entries, `step_instances.${stepId}`)])) } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.onlyStep ? { onlyStep: input.onlyStep } : {}),
    ...(input.fromStep ? { fromStep: input.fromStep } : {}),
  })
  const plan = /** @type {ControlPlanePlan} */ ({
    planId,
    kind: 'workflow',
    status: 'prepared',
    scope: { ...scope },
    target: { ...target, caveats: [...(target.caveats || [])] },
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    workflowId: input.workflowId,
    steps,
    instances,
    expectedAgentRuns,
    warnings: uniqueWarnings(warnings),
    summary: `${flow.title || flow.id} will run ${steps.length} step${steps.length === 1 ? '' : 's'} with ${expectedAgentRuns} remote Agent Runner submission${expectedAgentRuns === 1 ? '' : 's'} on ${target.siteName} (${target.siteId}), branch ${target.branch}.`,
  })
  const hash = requestHash({ kind: 'workflow', scope, target, normalizedInput })
  return /** @type {PreparedControlPlanePlan} */ (deepFreeze({ plan, normalizedInput, requestHash: hash, transport: REMOTE_TRANSPORT }))
}

/**
 * @param {{
 *   planId: string,
 *   now: Date,
 *   ttlMs?: number,
 *   scope: ControlPlaneScope,
 *   target: ControlPlaneTarget,
 *   input: ControlPlaneAgentRunPlanInput,
 *   transport?: string,
 * }} options
 * @returns {PreparedControlPlanePlan}
 */
function prepareAgentRunPlan({ planId, now, ttlMs = DEFAULT_PLAN_TTL_MS, scope, target, input, transport = REMOTE_TRANSPORT }) {
  assertRemoteTransport(transport)
  assertPlanInputKeys(/** @type {Record<string, unknown>} */ (input), ['prompt', 'instance', 'branch'])
  assertPlanBinding(scope, target, input.branch)
  if (!planId) throw plannerError('invalid_plan_id', 'Planning requires an explicit plan ID.')
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw plannerError('invalid_clock', 'Planning requires an explicit valid clock.')
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw plannerError('invalid_plan_ttl', 'Plan TTL must be a positive integer.')
  const prompt = String(input.prompt || '').trim()
  if (!prompt) throw plannerError('invalid_prompt', 'Agent Runner prompt cannot be empty.')
  if (utf8Bytes(prompt) > MAX_PROMPT_BYTES) throw plannerError('prompt_too_large', `Agent Runner prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes.`)
  const entries = structuredInstances([input.instance], 'instance')
  const resolved = resolveStructuredInstances(entries)
  const instance = resolved.instances[0]
  const step = {
    stepId: 'agent-run',
    title: 'Remote agent run',
    action: 'agent-run',
    submit: 'new-run',
    waitFor: 'agent-results',
    agents: [instance.agent],
    instances: [instance],
    reviewGate: false,
  }
  /** @type {ControlPlanePlanWarning[]} */
  const warnings = resolved.warnings
  for (const caveat of target.caveats || []) warnings.push({ code: `target_${caveat.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`, message: `Target caveat: ${caveat}.` })
  const normalizedInput = /** @type {ControlPlaneJsonObject} */ ({ prompt, instance: entries[0], branch: target.branch, transport: REMOTE_TRANSPORT })
  const plan = /** @type {ControlPlanePlan} */ ({
    planId,
    kind: 'agent-run',
    status: 'prepared',
    scope: { ...scope },
    target: { ...target, caveats: [...(target.caveats || [])] },
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    steps: [step],
    instances: [instance],
    expectedAgentRuns: 1,
    warnings: uniqueWarnings(warnings),
    summary: `${instance.agent}${instance.model ? `/${instance.model}` : ''} will run remotely on ${target.siteName} (${target.siteId}), branch ${target.branch}.`,
  })
  const hash = requestHash({ kind: 'agent-run', scope, target, normalizedInput })
  return /** @type {PreparedControlPlanePlan} */ (deepFreeze({ plan, normalizedInput, requestHash: hash, transport: REMOTE_TRANSPORT }))
}

module.exports = {
  DEFAULT_PLAN_TTL_MS,
  MAX_CONTEXT_BYTES,
  MAX_PROMPT_BYTES,
  PROMPT_OFFLOAD_WARNING_BYTES,
  REMOTE_TRANSPORT,
  deepFreeze,
  prepareAgentRunPlan,
  prepareWorkflowPlan,
  requestHash,
  sha256,
  stableJson,
  structuredInstances,
}
