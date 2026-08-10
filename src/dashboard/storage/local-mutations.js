const fs = require('node:fs')
const path = require('node:path')

const { acquireStoreLock, assertSecretFree } = require('./local-run-plans')

/** @typedef {import('../../contracts').ControlPlaneErrorShape} ControlPlaneErrorShape */
/** @typedef {import('../../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject */
/** @typedef {import('../../contracts').ControlPlaneMutationStore} ControlPlaneMutationStore */
/** @typedef {import('../../contracts').StoredControlPlaneMutation} StoredControlPlaneMutation */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,254}$/

/** @param {string} code @param {string} message @param {ControlPlaneJsonObject} [details] */
function mutationStoreError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details, recoverable: true })
}

/** @param {string} projectRoot */
function mutationDirectory(projectRoot) {
  return path.join(path.resolve(projectRoot), '.nax', 'control-plane', 'mutations')
}

/** @param {string} value @param {string} field */
function assertId(value, field) {
  if (!ID_PATTERN.test(String(value || '')) || value.includes('..')) throw mutationStoreError('invalid_arguments', `${field} must be one concrete opaque identifier.`)
  return value
}

/** @param {string} projectRoot @param {string} operation @param {string} requestId */
function mutationPath(projectRoot, operation, requestId) {
  return path.join(mutationDirectory(projectRoot), `${assertId(operation, 'operation')}--${assertId(requestId, 'requestId')}.json`)
}

/** @param {string} filePath @returns {StoredControlPlaneMutation | null} */
function readMutation(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return /** @type {StoredControlPlaneMutation} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch (error) {
    throw mutationStoreError('mutation_store_corrupt', `Could not read mutation receipt "${path.basename(filePath, '.json')}".`, { reason: error instanceof Error ? error.message : String(error) })
  }
}

/** @param {string} filePath @param {StoredControlPlaneMutation} record */
function atomicWriteMutation(filePath, record) {
  assertSecretFree(record)
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, 0o600)
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw error
  }
}

/**
 * @param {{ projectRoot: string, now?: () => Date }} input
 * @returns {ControlPlaneMutationStore & { directory: string }}
 */
function createLocalMutationStore({ projectRoot, now = () => new Date() }) {
  const directory = mutationDirectory(projectRoot)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(path.join(path.resolve(projectRoot), '.nax', 'control-plane'), 0o700)
  fs.chmodSync(directory, 0o700)

  /** @template T @param {() => T} operation */
  function locked(operation) {
    const release = acquireStoreLock(directory)
    try {
      return operation()
    } finally {
      release()
    }
  }

  return {
    directory,
    async claim({ operation, requestId, intentHash }) {
      return locked(() => {
        const filePath = mutationPath(projectRoot, operation, requestId)
        const existing = readMutation(filePath)
        if (existing) {
          if (existing.intentHash !== intentHash) {
            throw mutationStoreError('idempotency_conflict', `Request ID "${requestId}" is already bound to different mutation intent.`, { operation, requestId })
          }
          return { claimed: false, record: existing }
        }
        const at = now().toISOString()
        const record = /** @type {StoredControlPlaneMutation} */ ({ operation, requestId, intentHash, status: 'starting', createdAt: at, updatedAt: at })
        atomicWriteMutation(filePath, record)
        return { claimed: true, record }
      })
    },
    async complete(operation, requestId, result) {
      return locked(() => {
        const filePath = mutationPath(projectRoot, operation, requestId)
        const existing = readMutation(filePath)
        if (!existing) throw mutationStoreError('mutation_receipt_not_found', `Mutation request "${requestId}" was not claimed.`, { operation, requestId })
        if (existing.status === 'completed') return existing
        if (existing.status !== 'starting') throw mutationStoreError('invalid_mutation_state', `Mutation request "${requestId}" cannot complete from ${existing.status}.`, { operation, requestId })
        const completed = /** @type {StoredControlPlaneMutation} */ ({ ...existing, status: 'completed', result, updatedAt: now().toISOString() })
        atomicWriteMutation(filePath, completed)
        return completed
      })
    },
    async fail(operation, requestId, failure) {
      return locked(() => {
        const filePath = mutationPath(projectRoot, operation, requestId)
        const existing = readMutation(filePath)
        if (!existing) throw mutationStoreError('mutation_receipt_not_found', `Mutation request "${requestId}" was not claimed.`, { operation, requestId })
        if (existing.status !== 'starting') return existing
        const failed = /** @type {StoredControlPlaneMutation} */ ({ ...existing, status: 'failed', failure: /** @type {ControlPlaneErrorShape} */ (failure), updatedAt: now().toISOString() })
        atomicWriteMutation(filePath, failed)
        return failed
      })
    },
  }
}

module.exports = {
  assertId,
  createLocalMutationStore,
  mutationDirectory,
  mutationPath,
  mutationStoreError,
  readMutation,
}
