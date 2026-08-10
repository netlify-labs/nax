const { sha256, stableJson } = require('./planner')

/** @typedef {import('../contracts').ControlPlaneErrorShape} ControlPlaneErrorShape */
/** @typedef {import('../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject */
/** @typedef {import('../contracts').ControlPlaneMutationStore} ControlPlaneMutationStore */

/** @param {string} code @param {string} message @param {ControlPlaneJsonObject} [details] @param {boolean} [recoverable] */
function mutationError(code, message, details = {}, recoverable = true) {
  return Object.assign(new Error(message), { code, details, recoverable })
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
}

/** @param {string} operation @param {ControlPlaneJsonObject} intent */
function mutationIntentHash(operation, intent) {
  return sha256(stableJson({ operation, intent }))
}

/** @param {unknown} value @returns {ControlPlaneJsonObject} */
function serializableMutationResult(value) {
  let parsed
  try {
    parsed = JSON.parse(JSON.stringify(value))
  } catch (error) {
    throw mutationError('invalid_mutation_result', 'The mutation result could not be persisted as JSON.', {
      reason: error instanceof Error ? error.message : String(error),
    }, false)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw mutationError('invalid_mutation_result', 'The mutation result must be a JSON object.', {}, false)
  }
  return /** @type {ControlPlaneJsonObject} */ (parsed)
}

/** @param {unknown} error @returns {ControlPlaneErrorShape} */
function storedMutationFailure(error) {
  const value = objectValue(error)
  const sourceDetails = objectValue(value.details)
  /** @type {ControlPlaneJsonObject} */
  const details = {}
  for (const key of ['runId', 'agentRunId', 'reviewGateId', 'artifactId', 'mutationTransmitted', 'ambiguous']) {
    const item = sourceDetails[key]
    if (typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' || item === null) {
      details[key] = /** @type {string | boolean | number | null} */ (item)
    }
  }
  for (const key of ['agentRunIds', 'reviewGateIds', 'artifactIds', 'candidates']) {
    const item = sourceDetails[key]
    if (Array.isArray(item)) details[key] = item.filter((candidate) => typeof candidate === 'string').slice(0, 100)
  }
  return {
    code: typeof value.code === 'string' ? value.code : 'mutation_failed',
    message: error instanceof Error ? error.message : String(error || 'The control-plane mutation failed.'),
    recoverable: typeof value.recoverable === 'boolean' ? value.recoverable : false,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  }
}

/** @param {ControlPlaneErrorShape} failure @returns {Error} */
function replayFailure(failure) {
  return mutationError(failure.code, failure.message, { ...(failure.details || {}), replayed: true }, failure.recoverable)
}

/**
 * @template {Record<string, unknown>} T
 * @param {{
 *   store: ControlPlaneMutationStore,
 *   operation: string,
 *   requestId: string,
 *   intent: ControlPlaneJsonObject,
 *   execute: () => Promise<T>,
 * }} input
 * @returns {Promise<T & { replayed: boolean }>}
 */
async function runIdempotentMutation({ store, operation, requestId, intent, execute }) {
  if (!requestId) throw mutationError('invalid_arguments', 'requestId is required for this idempotent mutation.')
  const intentHash = mutationIntentHash(operation, intent)
  const claim = await store.claim({ operation, requestId, intentHash })
  if (!claim.claimed) {
    if (claim.record.status === 'completed' && claim.record.result) {
      return /** @type {T & { replayed: boolean }} */ ({ ...claim.record.result, replayed: true })
    }
    if (claim.record.status === 'failed' && claim.record.failure) throw replayFailure(claim.record.failure)
    throw mutationError('mutation_in_progress', `Mutation request "${requestId}" is already in progress and will not be submitted again.`, {
      operation,
      requestId,
      ...(typeof intent.runId === 'string' ? { runId: intent.runId } : {}),
      ...(typeof intent.agentRunId === 'string' ? { agentRunId: intent.agentRunId } : {}),
    })
  }

  try {
    const result = await execute()
    await store.complete(operation, requestId, serializableMutationResult(result))
    return /** @type {T & { replayed: boolean }} */ ({ ...result, replayed: false })
  } catch (error) {
    await store.fail(operation, requestId, storedMutationFailure(error))
    throw error
  }
}

module.exports = {
  mutationError,
  mutationIntentHash,
  replayFailure,
  runIdempotentMutation,
  serializableMutationResult,
  storedMutationFailure,
}
