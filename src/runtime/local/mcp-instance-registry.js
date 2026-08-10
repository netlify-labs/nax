const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { PACKAGE_VERSION, artifactMeta } = require('../../core/artifact-metadata')
const { ensureNaxGitignore } = require('../../storage/local/nax-gitignore')

const REGISTRY_VERSION = 1
const PROJECT_ID_VERSION = 1

/**
 * @typedef {{
 *   v: number,
 *   instanceId: string,
 *   pid: number,
 *   projectId: string,
 *   projectRoot: string,
 *   origin: string,
 *   token: string,
 *   startedAt: string,
 *   version: string,
 * }} DashboardInstanceRecord
 *
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   tempDir?: string,
 *   userId?: string,
 * }} RegistryPathOptions
 */

class DashboardRegistryError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DashboardRegistryError'
    this.code = code
    this.recoverable = true
    this.details = details
  }
}

/**
 * @param {string} projectRoot
 * @param {{ platform?: NodeJS.Platform, realpath?: (value: string) => string }} [options]
 */
function canonicalProjectRoot(projectRoot, { platform = process.platform, realpath = fs.realpathSync.native } = {}) {
  const resolved = realpath(path.resolve(projectRoot || process.cwd()))
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** @param {{ getuid?: (() => number) | null, username?: string, homedir?: string }} [options] */
function runtimeUserId(options = {}) {
  const getuid = Object.hasOwn(options, 'getuid')
    ? options.getuid
    : (typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined)
  const username = options.username ?? os.userInfo().username
  const homedir = options.homedir ?? os.homedir()
  if (typeof getuid === 'function') return String(getuid())
  return crypto.createHash('sha256').update(`${username}\0${homedir}`).digest('hex').slice(0, 16)
}

/**
 * @param {RegistryPathOptions} [options]
 */
function registryDirectory({ env = process.env, tempDir = os.tmpdir(), userId = runtimeUserId() } = {}) {
  const runtimeRoot = env.XDG_RUNTIME_DIR ? path.resolve(env.XDG_RUNTIME_DIR) : path.resolve(tempDir)
  return path.join(runtimeRoot, 'nax', userId, 'dashboards')
}

/**
 * @param {string} projectRoot
 * @param {RegistryPathOptions} [options]
 */
function dashboardInstancePath(projectRoot, options = {}) {
  const root = canonicalProjectRoot(projectRoot)
  const key = crypto.createHash('sha256').update(root).digest('hex')
  return path.join(registryDirectory(options), `${key}.json`)
}

/** @param {string} projectRoot */
function projectIdentityPath(projectRoot) {
  return path.join(canonicalProjectRoot(projectRoot), '.nax', 'project.json')
}

/** @param {string} value */
function isStableId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : null
  } catch {
    return null
  }
}

/**
 * @param {string} projectRoot
 * @param {{ projectId?: string, now?: () => string }} [options]
 */
function ensureStableProjectIdentity(projectRoot, {
  projectId = `project_${crypto.randomUUID().replaceAll('-', '')}`,
  now = () => new Date().toISOString(),
} = {}) {
  const root = canonicalProjectRoot(projectRoot)
  const filePath = projectIdentityPath(root)
  const existing = readJsonObject(filePath)
  if (existing) {
    const existingId = String(existing.projectId || '')
    if (!isStableId(existingId)) {
      throw new DashboardRegistryError('project_identity_invalid', 'The persisted nax project identity is invalid.', { projectRoot: root })
    }
    return { projectId: existingId, projectRoot: root, path: filePath, created: false }
  }
  if (fs.existsSync(filePath)) {
    throw new DashboardRegistryError('project_identity_invalid', 'The persisted nax project identity could not be read.', { projectRoot: root })
  }
  if (!isStableId(projectId)) throw new TypeError('projectId must be a stable opaque identifier.')

  ensureNaxGitignore({ projectRoot: root })
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const body = `${JSON.stringify({
    ...artifactMeta(),
    version: PROJECT_ID_VERSION,
    projectId,
    createdAt: now(),
  }, null, 2)}\n`

  try {
    const fd = fs.openSync(filePath, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, body, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    const raced = readJsonObject(filePath)
    const racedId = String(raced?.projectId || '')
    if (!isStableId(racedId)) {
      throw new DashboardRegistryError('project_identity_invalid', 'A concurrent nax project identity write produced invalid metadata.', { projectRoot: root })
    }
    return { projectId: racedId, projectRoot: root, path: filePath, created: false }
  }
  try { fs.chmodSync(filePath, 0o600) } catch (_error) { /* unsupported on some platforms */ }
  return { projectId, projectRoot: root, path: filePath, created: true }
}

/** @param {number} pid */
function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

/** @param {string} origin */
function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true
    if (!/^127(?:\.\d{1,3}){3}$/.test(host)) return false
    return host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  } catch {
    return false
  }
}

/**
 * @param {unknown} value
 * @param {{ projectRoot?: string }} [options]
 * @returns {DashboardInstanceRecord}
 */
function validateDashboardInstanceRecord(value, { projectRoot = '' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DashboardRegistryError('dashboard_registry_invalid', 'The nax dashboard registry record is invalid.')
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const normalized = {
    v: Number(record.v),
    instanceId: String(record.instanceId || ''),
    pid: Number(record.pid),
    projectId: String(record.projectId || ''),
    projectRoot: String(record.projectRoot || ''),
    origin: String(record.origin || ''),
    token: String(record.token || ''),
    startedAt: String(record.startedAt || ''),
    version: String(record.version || ''),
  }
  if (normalized.v !== REGISTRY_VERSION) throw new DashboardRegistryError('dashboard_registry_version_unsupported', 'The nax dashboard registry format is not supported.')
  if (!isStableId(normalized.instanceId) || !isStableId(normalized.projectId)) throw new DashboardRegistryError('dashboard_registry_invalid', 'The nax dashboard registry identity is invalid.')
  if (!Number.isSafeInteger(normalized.pid) || normalized.pid <= 0) throw new DashboardRegistryError('dashboard_registry_invalid', 'The nax dashboard registry process identity is invalid.')
  if (!normalized.token || normalized.token.length < 24) throw new DashboardRegistryError('dashboard_registry_invalid', 'The nax dashboard registry authentication metadata is invalid.')
  if (!isLoopbackOrigin(normalized.origin)) throw new DashboardRegistryError('dashboard_origin_forbidden', 'The nax dashboard registry origin is not loopback.')
  if (!normalized.version || Number.isNaN(Date.parse(normalized.startedAt))) throw new DashboardRegistryError('dashboard_registry_invalid', 'The nax dashboard registry lifecycle metadata is invalid.')
  const canonicalRecordRoot = canonicalProjectRoot(normalized.projectRoot)
  if (projectRoot && canonicalRecordRoot !== canonicalProjectRoot(projectRoot)) {
    throw new DashboardRegistryError('project_scope_mismatch', 'The nax dashboard registry belongs to a different project.', {
      expectedProjectRoot: canonicalProjectRoot(projectRoot),
      actualProjectRoot: canonicalRecordRoot,
    })
  }
  return { ...normalized, projectRoot: canonicalRecordRoot }
}

/**
 * @param {string} filePath
 * @param {Record<string, unknown>} value
 */
function atomicWritePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  try { fs.chmodSync(path.dirname(filePath), 0o700) } catch (_error) { /* unsupported on some platforms */ }
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(tempPath, filePath)
    try { fs.chmodSync(filePath, 0o600) } catch (_error) { /* unsupported on some platforms */ }
  } finally {
    try { fs.unlinkSync(tempPath) } catch (_error) { /* already renamed or never created */ }
  }
}

/**
 * @param {string} filePath
 * @param {DashboardInstanceRecord} record
 * @param {(pid: number) => boolean} isAlive
 */
function acquireRegistryLock(filePath, record, isAlive) {
  const lockPath = `${filePath}.lock`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: record.pid, instanceId: record.instanceId })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return () => {
        const lock = readJsonObject(lockPath)
        if (String(lock?.instanceId || '') !== record.instanceId) return
        try { fs.unlinkSync(lockPath) } catch (_error) { /* already removed */ }
      }
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      const lock = readJsonObject(lockPath)
      if (isAlive(Number(lock?.pid))) {
        throw new DashboardRegistryError('dashboard_registry_busy', 'Another nax dashboard is updating the project registry.', { projectRoot: record.projectRoot })
      }
      try { fs.unlinkSync(lockPath) } catch (_error) { /* another writer won */ }
    }
  }
  throw new DashboardRegistryError('dashboard_registry_busy', 'The nax dashboard project registry is busy.', { projectRoot: record.projectRoot })
}

/**
 * @param {DashboardInstanceRecord} value
 * @param {RegistryPathOptions & { isProcessAlive?: (pid: number) => boolean }} [options]
 */
function writeDashboardInstance(value, { isProcessAlive = processIsAlive, ...pathOptions } = {}) {
  const record = validateDashboardInstanceRecord(value, { projectRoot: value.projectRoot })
  const filePath = dashboardInstancePath(record.projectRoot, pathOptions)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  try { fs.chmodSync(path.dirname(filePath), 0o700) } catch (_error) { /* unsupported on some platforms */ }
  const release = acquireRegistryLock(filePath, record, isProcessAlive)
  try {
    if (fs.existsSync(filePath)) {
      const existingValue = readJsonObject(filePath)
      let existing = null
      try {
        existing = validateDashboardInstanceRecord(existingValue, { projectRoot: record.projectRoot })
      } catch (_error) {
        try { fs.unlinkSync(filePath) } catch (_unlinkError) { /* handled by write */ }
      }
      if (existing && existing.instanceId !== record.instanceId && isProcessAlive(existing.pid)) {
        throw new DashboardRegistryError('dashboard_already_advertised', 'A nax dashboard is already advertised for this project.', {
          projectRoot: record.projectRoot,
          instanceId: existing.instanceId,
        })
      }
    }
    atomicWritePrivateJson(filePath, record)
    return filePath
  } finally {
    release()
  }
}

/**
 * @param {string} projectRoot
 * @param {RegistryPathOptions} [options]
 * @returns {DashboardInstanceRecord | null}
 */
function readDashboardInstance(projectRoot, options = {}) {
  const filePath = dashboardInstancePath(projectRoot, options)
  if (!fs.existsSync(filePath)) return null
  const directoryStat = fs.lstatSync(path.dirname(filePath))
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new DashboardRegistryError('dashboard_registry_permissions', 'The nax dashboard registry directory is not private.')
  }
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DashboardRegistryError('dashboard_registry_invalid', 'The nax dashboard registry path is not a regular file.')
  }
  if (process.platform !== 'win32' && ((directoryStat.mode & 0o077) !== 0 || (stat.mode & 0o077) !== 0)) {
    throw new DashboardRegistryError('dashboard_registry_permissions', 'The nax dashboard registry permissions are too broad.')
  }
  return validateDashboardInstanceRecord(readJsonObject(filePath), { projectRoot })
}

/**
 * Enumerates the private per-user dashboard registry without exposing records
 * outside this process. Malformed and stale entries are ignored so one broken
 * project cannot prevent routing to healthy projects.
 *
 * @param {RegistryPathOptions & { isProcessAlive?: (pid: number) => boolean }} [options]
 * @returns {DashboardInstanceRecord[]}
 */
function listDashboardInstances({ isProcessAlive = processIsAlive, ...pathOptions } = {}) {
  const directory = registryDirectory(pathOptions)
  if (!fs.existsSync(directory)) return []
  const directoryStat = fs.lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new DashboardRegistryError('dashboard_registry_permissions', 'The nax dashboard registry directory is not private.')
  }
  if (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0) {
    throw new DashboardRegistryError('dashboard_registry_permissions', 'The nax dashboard registry permissions are too broad.')
  }

  /** @type {DashboardInstanceRecord[]} */
  const records = []
  for (const name of fs.readdirSync(directory).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const filePath = path.join(directory, name)
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) continue
      const record = validateDashboardInstanceRecord(readJsonObject(filePath))
      if (!isProcessAlive(record.pid)) continue
      records.push(record)
    } catch (_error) {
      /* Ignore one malformed entry; direct reads still report its exact error. */
    }
  }
  return records
}

/**
 * @param {string} projectRoot
 * @param {string} instanceId
 * @param {RegistryPathOptions} [options]
 */
function removeDashboardInstance(projectRoot, instanceId, options = {}) {
  const filePath = dashboardInstancePath(projectRoot, options)
  const existing = readJsonObject(filePath)
  if (String(existing?.instanceId || '') !== instanceId) return false
  try {
    fs.unlinkSync(filePath)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * @param {{
 *   projectRoot: string,
 *   expectedVersion?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   isProcessAlive?: (pid: number) => boolean,
 *   registry?: RegistryPathOptions,
 * }} input
 * @returns {Promise<DashboardInstanceRecord | null>}
 */
async function discoverDashboardInstance({
  projectRoot,
  expectedVersion = PACKAGE_VERSION,
  timeoutMs = 1500,
  fetchImpl = globalThis.fetch,
  isProcessAlive = processIsAlive,
  registry = {},
}) {
  let record
  try {
    record = readDashboardInstance(projectRoot, registry)
  } catch (error) {
    const filePath = dashboardInstancePath(projectRoot, registry)
    try { fs.unlinkSync(filePath) } catch (_unlinkError) { /* best-effort malformed cleanup */ }
    throw error
  }
  if (!record) return null
  if (!isProcessAlive(record.pid)) {
    removeDashboardInstance(projectRoot, record.instanceId, registry)
    return null
  }
  if (record.version !== expectedVersion) {
    throw new DashboardRegistryError('dashboard_version_mismatch', 'The running nax dashboard version does not match the MCP adapter.', {
      expectedVersion,
      actualVersion: record.version,
    })
  }
  if (typeof fetchImpl !== 'function') throw new DashboardRegistryError('dashboard_unreachable', 'No HTTP client is available to verify the nax dashboard.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    const response = await fetchImpl(`${record.origin}/api/health`, {
      headers: { 'x-nax-token': record.token },
      signal: controller.signal,
    })
    const payloadValue = /** @type {unknown} */ (await response.json())
    if (!payloadValue || typeof payloadValue !== 'object' || Array.isArray(payloadValue)) {
      throw new Error('health payload was not an object')
    }
    const payload = /** @type {Record<string, unknown>} */ (payloadValue)
    if (!response.ok || payload.ok !== true) throw new Error(`health status ${response.status}`)
    if (typeof payload.projectRoot !== 'string' || !payload.projectRoot) throw new Error('health payload omitted projectRoot')
    const healthRoot = canonicalProjectRoot(payload.projectRoot)
    if (healthRoot !== record.projectRoot || String(payload.projectId || '') !== record.projectId) {
      throw new DashboardRegistryError('project_scope_mismatch', 'The running nax dashboard health response belongs to a different project.', {
        expectedProjectRoot: record.projectRoot,
        actualProjectRoot: healthRoot,
      })
    }
    if (String(payload.version || '') !== record.version) {
      throw new DashboardRegistryError('dashboard_version_mismatch', 'The running nax dashboard and its registry record have different versions.', {
        expectedVersion: record.version,
        actualVersion: String(payload.version || ''),
      })
    }
    return record
  } catch (error) {
    if (error instanceof DashboardRegistryError) throw error
    throw new DashboardRegistryError('dashboard_unreachable', 'The registered nax dashboard could not be reached.', {
      projectRoot: record.projectRoot,
    })
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = {
  DashboardRegistryError,
  PROJECT_ID_VERSION,
  REGISTRY_VERSION,
  atomicWritePrivateJson,
  canonicalProjectRoot,
  dashboardInstancePath,
  discoverDashboardInstance,
  ensureStableProjectIdentity,
  isLoopbackOrigin,
  listDashboardInstances,
  processIsAlive,
  projectIdentityPath,
  readDashboardInstance,
  registryDirectory,
  removeDashboardInstance,
  runtimeUserId,
  validateDashboardInstanceRecord,
  writeDashboardInstance,
}
