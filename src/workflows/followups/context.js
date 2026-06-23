const fs = require('fs')
const path = require('path')

class FollowupContextError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message)
    this.name = 'FollowupContextError'
    this.code = code
    this.statusCode = statusCode
  }
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function realpathSafe(filePath) {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return ''
  }
}

function projectNaxRoot(projectRoot) {
  return path.resolve(projectRoot || process.cwd(), '.nax')
}

function assertInsideNax(projectRoot, filePath) {
  const naxRoot = realpathSafe(projectNaxRoot(projectRoot))
  const realFile = realpathSafe(filePath)
  if (!naxRoot) {
    throw new FollowupContextError('missing_nax_root', `No .nax directory exists under ${path.resolve(projectRoot || process.cwd())}.`, 404)
  }
  if (!realFile) {
    throw new FollowupContextError('missing_artifact', `Selected artifact does not exist: ${filePath}`)
  }
  const relative = path.relative(naxRoot, realFile)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FollowupContextError('unsafe_artifact_path', `Selected artifact is outside .nax: ${filePath}`)
  }
  const stat = fs.statSync(realFile)
  if (!stat.isFile()) {
    throw new FollowupContextError('invalid_artifact_path', `Selected artifact is not a file: ${filePath}`)
  }
  return realFile
}

function artifactKey(artifact = {}) {
  return `${artifact.id || ''}\0${artifact.kind || ''}`
}

function artifactByRequest(details = {}, requested = {}) {
  const artifacts = Array.isArray(details.followupArtifacts) ? details.followupArtifacts : []
  return artifacts.find((artifact) => (
    artifact.id === requested.id &&
    (!requested.kind || artifact.kind === requested.kind)
  )) || null
}

function normalizeRequestedArtifacts(artifacts = []) {
  if (!Array.isArray(artifacts)) return []
  const seen = new Set()
  const normalized = []
  for (const artifact of artifacts) {
    const id = String(artifact?.id || '').trim()
    const kind = String(artifact?.kind || '').trim()
    if (!id) continue
    const key = `${id}\0${kind}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ id, kind })
  }
  return normalized
}

/**
 * Requested follow-up artifact descriptor.
 * @typedef {{
 *   id?: string,
 *   kind?: string,
 * }} FollowupArtifactRequest
 *
 * Follow-up context artifact options.
 * @typedef {{
 *   projectRoot?: string,
 *   details?: import('../../types').JsonMap,
 *   artifacts?: FollowupArtifactRequest[],
 * }} FollowupContextArtifactOptions
 *
 * @param {FollowupContextArtifactOptions} [options]
 */
function resolveFollowupArtifacts({ projectRoot, details, artifacts = [] } = {}) {
  const requested = normalizeRequestedArtifacts(artifacts)
  const resolved = []
  const seen = new Set()
  for (const item of requested) {
    const artifact = artifactByRequest(details, item)
    if (!artifact) {
      throw new FollowupContextError('unknown_artifact', `Unknown follow-up artifact "${item.id}".`)
    }
    const key = artifactKey(artifact)
    if (seen.has(key)) continue
    seen.add(key)
    const realPath = assertInsideNax(projectRoot, artifact.absolutePath)
    resolved.push({
      ...artifact,
      absolutePath: realPath,
      markdown: readFile(realPath),
    })
  }
  return resolved
}

function formatArtifactSection(projectRoot, artifact = {}) {
  const displayPath = artifact.path || path.relative(projectRoot || process.cwd(), artifact.absolutePath || '')
  return [
    `## Artifact: ${artifact.label || artifact.id}`,
    '',
    displayPath ? `Source: ${displayPath}` : '',
    '',
    String(artifact.markdown || '').trimEnd(),
  ].filter((line) => line !== '').join('\n')
}

/**
 * @param {FollowupContextArtifactOptions} [options]
 */
function buildFollowupContextPackage({ projectRoot, details, artifacts = [] } = {}) {
  const resolved = resolveFollowupArtifacts({ projectRoot, details, artifacts })
  const markdown = resolved
    .map((artifact) => formatArtifactSection(projectRoot, artifact))
    .filter(Boolean)
    .join('\n\n---\n\n')
  return {
    artifactCount: resolved.length,
    artifacts: resolved.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      label: artifact.label,
      path: artifact.path,
      absolutePath: artifact.absolutePath,
      sizeBytes: artifact.sizeBytes,
      advanced: artifact.advanced === true,
      source: artifact.source || {},
    })),
    markdown,
    totalBytes: Buffer.byteLength(markdown, 'utf8'),
  }
}

module.exports = {
  FollowupContextError,
  assertInsideNax,
  buildFollowupContextPackage,
  resolveFollowupArtifacts,
}
