// @ts-nocheck
const fs = require('fs')
const path = require('path')

function registryPath(projectRoot) {
  return path.join(projectRoot, '.nax', 'blob-refs.jsonl')
}

function ensureRegistryDir(projectRoot) {
  fs.mkdirSync(path.dirname(registryPath(projectRoot)), { recursive: true })
}

function appendBlobRef(projectRoot, ref) {
  ensureRegistryDir(projectRoot)
  fs.appendFileSync(registryPath(projectRoot), `${JSON.stringify(ref)}\n`)
  return ref
}

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

function latestBlobRefs(projectRoot) {
  const byId = new Map()
  for (const ref of readBlobRefs(projectRoot)) {
    const id = ref.id || `${ref.runId}:${ref.store}:${ref.key}`
    byId.set(id, ref)
  }
  return [...byId.values()]
}

function blobRefId(ref = {}) {
  return ref.id || `${ref.runId || ''}:${ref.store || ''}:${ref.key || ''}`
}

function markBlobRef(projectRoot, ref, patch) {
  return appendBlobRef(projectRoot, {
    ...ref,
    ...patch,
    id: blobRefId(ref),
    updatedAt: new Date().toISOString(),
  })
}

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

function isBlobRefActive(ref) {
  return ref && !['cleaned', 'deleted'].includes(ref.status)
}

function replaceBlobRef(ref, replacements) {
  const next = replacements.get(blobRefId(ref))
  return next ? { ...ref, ...next } : ref
}

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
  cleanupRunBlobRefs,
  latestBlobRefs,
  markBlobRef,
  readBlobRefs,
  registryPath,
  sweepBlobRefs,
}
