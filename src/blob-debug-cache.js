const fs = require('fs')
const path = require('path')

/** @param {unknown} value */
function safeBlobFileName(value) {
  return String(value || 'blob')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+|-+$/g, '') || 'blob'
}

/**
 * Options for resolving the local blob debug directory.
 * @typedef {{
 *   runState?: import('./types').WorkflowRunState,
 *   projectRoot?: string,
 * }} WorkflowBlobDebugDirInput
 */

/** @param {WorkflowBlobDebugDirInput} param0 */
function workflowBlobDebugDir({ runState, projectRoot } = {}) {
  const root = projectRoot || runState?.projectRoot || ''
  if (!runState?.dir && (!root || !runState?.runId)) return ''
  const runDir = runState?.dir || path.join(root, '.nax', 'workflows', runState.runId)
  return path.join(runDir, 'blobs')
}

/** @param {string} filePath @param {string} [projectRoot] */
function relativeIfPossible(filePath, projectRoot) {
  if (!projectRoot) return filePath
  const relative = path.relative(projectRoot, filePath)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath
}

/**
 * Options for writing a local copy of an offloaded blob payload.
 * @typedef {{
 *   runState?: import('./types').WorkflowRunState,
 *   stepState?: import('./types').WorkflowStep,
 *   ref?: import('./types').BlobRef,
 *   payload?: unknown,
 *   kind?: string,
 *   projectRoot?: string,
 * }} WriteLocalBlobDebugPayloadInput
 */

/** @param {WriteLocalBlobDebugPayloadInput} param0 */
function writeLocalBlobDebugPayload({
  runState,
  stepState,
  ref,
  payload,
  kind,
  projectRoot,
} = {}) {
  const dir = workflowBlobDebugDir({ runState, projectRoot })
  if (!dir || !ref?.key) return {}
  fs.mkdirSync(dir, { recursive: true })
  const base = safeBlobFileName(ref.key)
  const payloadPath = path.join(dir, `${base}.md`)
  const metadataPath = path.join(dir, `${base}.json`)
  const now = new Date().toISOString()
  const payloadText = String(payload || '')
  const metadata = {
    runId: runState?.runId || ref.runId || '',
    stepId: stepState?.id || ref.stepId || '',
    store: ref.store || '',
    key: ref.key || '',
    marker: ref.marker || '',
    sentinel: ref.sentinel || '',
    kind: kind || ref.kind || '',
    payloadBytes: Buffer.byteLength(payloadText, 'utf8'),
    writtenAt: now,
  }
  fs.writeFileSync(payloadPath, payloadText.endsWith('\n') ? payloadText : `${payloadText}\n`)
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return {
    localPath: relativeIfPossible(payloadPath, projectRoot || runState?.projectRoot),
    localMetadataPath: relativeIfPossible(metadataPath, projectRoot || runState?.projectRoot),
    localBytes: metadata.payloadBytes,
  }
}

module.exports = {
  safeBlobFileName,
  writeLocalBlobDebugPayload,
  workflowBlobDebugDir,
}
