const fs = require('fs')
const path = require('path')

/**
 * Callback that deletes one Netlify Blob reference.
 * @typedef {(input: {
 *   store?: string,
 *   key?: string,
 *   siteId?: string,
 *   token?: string,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   allowFailure?: boolean,
 * }) => unknown} DeleteBlob
 */

/** @param {string} projectRoot */
function registryPath(projectRoot) {
  return path.join(projectRoot, '.nax', 'blob-refs.jsonl')
}

/** @param {string} projectRoot */
function ensureRegistryDir(projectRoot) {
  fs.mkdirSync(path.dirname(registryPath(projectRoot)), { recursive: true })
}

/** @param {string} projectRoot @param {import('../../types').BlobRef} ref */
function appendBlobRef(projectRoot, ref) {
  ensureRegistryDir(projectRoot)
  fs.appendFileSync(registryPath(projectRoot), `${JSON.stringify(ref)}\n`)
  return ref
}

/** @param {string} projectRoot @returns {Array<import('../../types').BlobRef>} */
function readBlobRefs(projectRoot) {
  const filePath = registryPath(projectRoot)
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** @param {string} projectRoot @returns {Array<import('../../types').BlobRef>} */
function latestBlobRefs(projectRoot) {
  const byId = new Map()
  for (const ref of readBlobRefs(projectRoot)) {
    const id = ref.id || `${ref.runId}:${ref.store}:${ref.key}`
    byId.set(id, ref)
  }
  return [...byId.values()]
}

/** @param {string} projectRoot */
function compactBlobRefs(projectRoot) {
  const filePath = registryPath(projectRoot)
  if (!fs.existsSync(filePath)) return []
  const refs = latestBlobRefs(projectRoot)
  ensureRegistryDir(projectRoot)
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, refs.map((ref) => JSON.stringify(ref)).join('\n') + (refs.length > 0 ? '\n' : ''))
  fs.renameSync(tmp, filePath)
  return refs
}

/** @param {import('../../types').BlobRef} [ref] */
function blobRefId(ref = {}) {
  return ref.id || `${ref.runId || ''}:${ref.store || ''}:${ref.key || ''}`
}

/**
 * @param {string} projectRoot
 * @param {import('../../types').BlobRef} ref
 * @param {Partial<import('../../types').BlobRef>} patch
 */
function markBlobRef(projectRoot, ref, patch) {
  return appendBlobRef(projectRoot, {
    ...ref,
    ...patch,
    id: blobRefId(ref),
    updatedAt: new Date().toISOString(),
  })
}

/**
 * @param {import('../../types').WorkflowRunState} runState
 * @param {import('../../types').WorkflowStep} stepState
 * @param {import('../../types').BlobRef} ref
 */
function addRunBlobRef(runState, stepState, ref) {
  const now = new Date().toISOString()
  const entry = {
    id: blobRefId(ref),
    runId: runState.runId || '',
    stepId: stepState.id || '',
    store: ref.store,
    key: ref.key,
    marker: ref.marker || '',
    sentinel: ref.sentinel || '',
    kind: ref.kind || '',
    localPath: ref.localPath || '',
    localMetadataPath: ref.localMetadataPath || '',
    localBytes: Number(ref.localBytes || 0),
    status: ref.status || 'active',
    createdAt: ref.createdAt || now,
    cleanupAttempts: Number(ref.cleanupAttempts || 0),
    lastCleanupError: ref.lastCleanupError || '',
  }
  runState.blobRefs = [...(Array.isArray(runState.blobRefs) ? runState.blobRefs : []).filter((item) => blobRefId(item) !== entry.id), entry]
  stepState.blobRefs = [...(Array.isArray(stepState.blobRefs) ? stepState.blobRefs : []).filter((item) => blobRefId(item) !== entry.id), entry]
  if (runState.projectRoot) appendBlobRef(runState.projectRoot, entry)
  return entry
}

/** @param {import('../../types').BlobRef} ref */
function isBlobRefActive(ref) {
  return ref && !['cleaned', 'deleted'].includes(ref.status)
}

/** @param {import('../../types').BlobRef} ref @param {Map<string, import('../../types').BlobRef>} replacements */
function replaceBlobRef(ref, replacements) {
  const next = replacements.get(blobRefId(ref))
  return next ? { ...ref, ...next } : ref
}

/** @param {import('../../types').WorkflowRunState} runState @param {Map<string, import('../../types').BlobRef>} replacements */
function updateNestedBlobRefs(runState, replacements) {
  if (!runState || !Array.isArray(runState.steps)) return
  for (const step of runState.steps) {
    if (Array.isArray(step.blobRefs)) step.blobRefs = step.blobRefs.map((ref) => replaceBlobRef(ref, replacements))
    if (step.promptBlobRef) step.promptBlobRef = replaceBlobRef(step.promptBlobRef, replacements)
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      if (run.blobRef) run.blobRef = replaceBlobRef(run.blobRef, replacements)
      if (run.promptDelivery?.blobRef) run.promptDelivery.blobRef = replaceBlobRef(run.promptDelivery.blobRef, replacements)
    }
  }
}

/**
 * Options for cleaning active blob refs attached to one workflow run.
 * @typedef {{
 *   runState?: import('../../types').WorkflowRunState,
 *   projectRoot?: string,
 *   siteId?: string,
 *   token?: string,
 *   env?: NodeJS.ProcessEnv,
 *   deleteBlob?: DeleteBlob,
 *   log?: (message: string) => void,
 * }} CleanupRunBlobRefsInput
 */

/** @param {CleanupRunBlobRefsInput} param0 */
function cleanupRunBlobRefs({
  runState,
  projectRoot = runState?.projectRoot,
  siteId,
  token,
  env,
  deleteBlob,
  log = () => {},
} = {}) {
  const refs = (runState?.blobRefs || []).filter(isBlobRefActive)
  const results = []
  for (const ref of refs) {
    try {
      deleteBlob({
        store: ref.store,
        key: ref.key,
        siteId,
        token,
        env,
        cwd: projectRoot,
        allowFailure: false,
      })
      const cleaned = markBlobRef(projectRoot, ref, {
        status: 'cleaned',
        cleanedAt: new Date().toISOString(),
        cleanupAttempts: Number(ref.cleanupAttempts || 0) + 1,
        lastCleanupError: '',
      })
      results.push({ ref: cleaned, ok: true })
    } catch (error) {
      const failed = markBlobRef(projectRoot, ref, {
        status: 'pending-cleanup',
        cleanupAttempts: Number(ref.cleanupAttempts || 0) + 1,
        lastCleanupError: error?.message || String(error),
      })
      log(`Blob cleanup pending for ${ref.store}/${ref.key}: ${failed.lastCleanupError}`)
      results.push({ ref: failed, ok: false, error })
    }
  }
  if (runState) {
    const byId = new Map((runState.blobRefs || []).map((ref) => [blobRefId(ref), ref]))
    for (const result of results) byId.set(blobRefId(result.ref), result.ref)
    runState.blobRefs = [...byId.values()]
    updateNestedBlobRefs(runState, byId)
  }
  return results
}

/**
 * Options for sweeping stale blob refs from the registry.
 * @typedef {{
 *   projectRoot?: string,
 *   siteId?: string,
 *   token?: string,
 *   env?: NodeJS.ProcessEnv,
 *   deleteBlob?: DeleteBlob,
 *   ttlHours?: number,
 *   now?: Date,
 *   dryRun?: boolean,
 *   log?: (message: string) => void,
 * }} SweepBlobRefsInput
 */

/** @param {SweepBlobRefsInput} param0 */
function sweepBlobRefs({
  projectRoot,
  siteId,
  token,
  env,
  deleteBlob,
  ttlHours = Number(process.env.NAX_BLOB_CLEANUP_TTL_HOURS || 24),
  now = new Date(),
  dryRun = true,
  log = () => {},
} = {}) {
  const cutoffMs = now.getTime() - Math.max(0, ttlHours) * 60 * 60 * 1000
  const refs = latestBlobRefs(projectRoot).filter((ref) => {
    if (!isBlobRefActive(ref)) return false
    if (ref.status === 'pending-cleanup') return true
    const created = Date.parse(ref.createdAt || ref.updatedAt || '')
    return Number.isFinite(created) && created <= cutoffMs
  })
  const results = []
  for (const ref of refs) {
    if (dryRun) {
      results.push({ ref, ok: true, dryRun: true })
      continue
    }
    try {
      deleteBlob({ store: ref.store, key: ref.key, siteId, token, env, cwd: projectRoot })
      results.push({ ref: markBlobRef(projectRoot, ref, { status: 'cleaned', cleanedAt: now.toISOString(), lastCleanupError: '' }), ok: true })
    } catch (error) {
      const failed = markBlobRef(projectRoot, ref, {
        status: 'pending-cleanup',
        cleanupAttempts: Number(ref.cleanupAttempts || 0) + 1,
        lastCleanupError: error?.message || String(error),
      })
      log(`Blob sweep failed for ${ref.store}/${ref.key}: ${failed.lastCleanupError}`)
      results.push({ ref: failed, ok: false, error })
    }
  }
  return results
}

module.exports = {
  addRunBlobRef,
  appendBlobRef,
  blobRefId,
  compactBlobRefs,
  cleanupRunBlobRefs,
  latestBlobRefs,
  markBlobRef,
  readBlobRefs,
  registryPath,
  sweepBlobRefs,
}
