const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { canonicalProjectRoot } = require('../runtime/local/mcp-instance-registry')

const CLAUDE_SCOPES = Object.freeze(['local', 'project', 'user'])

/**
 * Minimal synchronous filesystem surface used by Claude MCP setup.
 * @typedef {{
 *   accessSync: (filePath: string, mode?: number) => void,
 *   chmodSync: (filePath: string, mode: number) => void,
 *   closeSync: (fd: number) => void,
 *   existsSync: (filePath: string) => boolean,
 *   fsyncSync: (fd: number) => void,
 *   lstatSync: (filePath: string) => import('node:fs').Stats,
 *   mkdirSync: (directory: string, options?: import('node:fs').MakeDirectoryOptions & { recursive?: boolean }) => string | undefined,
 *   openSync: (filePath: string, flags: string, mode?: number) => number,
 *   readFileSync: (filePath: string, encoding: BufferEncoding) => string,
 *   renameSync: (oldPath: string, newPath: string) => void,
 *   statSync: (filePath: string) => import('node:fs').Stats,
 *   unlinkSync: (filePath: string) => void,
 *   writeFileSync: (file: string | number, data: string, options?: { encoding?: BufferEncoding, mode?: number, flag?: string } | BufferEncoding) => void,
 * }} ClaudeSetupFileSystem
 *
 * @typedef {{
 *   ok: boolean,
 *   executable: string,
 *   message: string,
 * }} ClaudeCliProbe
 *
 * @typedef {{
 *   scope: 'local' | 'project' | 'user',
 *   projectRoot: string,
 *   configPath: string,
 *   configKey: string,
 *   server: Record<string, unknown>,
 *   before: Record<string, unknown> | null,
 *   after: Record<string, unknown>,
 *   changed: boolean,
 *   dryRun: boolean,
 *   backupPath: string,
 *   claudeExecutable: string,
 * }} ClaudeMcpSetupResult
 * @typedef {(command: string, args: string[], options: { encoding: 'utf8', env: NodeJS.ProcessEnv, timeout: number }) => {
 *   status: number | null,
 *   stdout: string | Buffer | null,
 *   stderr: string | Buffer | null,
 * }} ClaudeSpawn
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Finds an executable without invoking a shell.
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, fileSystem?: ClaudeSetupFileSystem }} [options]
 */
function findExecutable(command, { env = process.env, platform = process.platform, fileSystem = fs } = {}) {
  const pathValue = String(env.PATH || '')
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : pathValue.split(path.delimiter).filter(Boolean).flatMap((directory) => extensions.map((extension) => path.join(directory, `${command}${extension}`)))
  for (const candidate of candidates) {
    try {
      fileSystem.accessSync(candidate, fs.constants.X_OK)
      if (fileSystem.statSync(candidate).isFile()) return candidate
    } catch (_error) {
      /* continue searching PATH */
    }
  }
  return ''
}

/**
 * Confirms that the installed Claude CLI supports stdio MCP and all three
 * configuration scopes used by this setup command.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fileSystem?: ClaudeSetupFileSystem,
 *   platform?: NodeJS.Platform,
 *   spawn?: ClaudeSpawn,
 * }} [options]
 * @returns {ClaudeCliProbe}
 */
function probeClaudeCli({ env = process.env, fileSystem = fs, platform = process.platform, spawn = (command, args, options) => spawnSync(command, args, options) } = {}) {
  const executable = findExecutable('claude', { env, fileSystem, platform })
  if (!executable) return { ok: false, executable: '', message: 'Claude Code CLI was not found on PATH.' }
  const result = spawn(executable, ['mcp', 'add', '--help'], {
    encoding: 'utf8',
    env,
    timeout: 5000,
  })
  const output = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  const supportsScopes = /--scope\s+<scope>/.test(output) && ['local', 'project', 'user'].every((scope) => output.includes(scope))
  const supportsStdio = /stdio/i.test(output)
  if (result.status !== 0 || !supportsScopes || !supportsStdio) {
    return {
      ok: false,
      executable,
      message: 'The installed Claude Code CLI does not expose the supported stdio MCP scope interface.',
    }
  }
  return { ok: true, executable, message: 'Claude Code CLI supports stdio MCP configuration.' }
}

/** @returns {Record<string, unknown>} */
function naxClaudeServer() {
  return {
    type: 'stdio',
    command: 'nax',
    args: ['mcp'],
  }
}

/**
 * @param {'local' | 'project' | 'user'} scope
 * @param {string} projectRoot
 * @param {{ homeDir?: string, userConfigPath?: string }} [options]
 */
function claudeConfigLocation(scope, projectRoot, { homeDir = os.homedir(), userConfigPath = '' } = {}) {
  if (!CLAUDE_SCOPES.includes(scope)) throw new TypeError(`Unsupported Claude MCP scope "${scope}".`)
  const root = canonicalProjectRoot(projectRoot)
  if (scope === 'project') {
    return { configPath: path.join(root, '.mcp.json'), configKey: 'mcpServers.nax' }
  }
  const configPath = userConfigPath ? path.resolve(userConfigPath) : path.join(path.resolve(homeDir), '.claude.json')
  return scope === 'user'
    ? { configPath, configKey: 'mcpServers.nax' }
    : { configPath, configKey: `projects.${root}.mcpServers.nax` }
}

/**
 * Reads a Claude JSON configuration without accepting symlinks or malformed data.
 * @param {string} configPath
 * @param {ClaudeSetupFileSystem} [fileSystem]
 * @returns {Record<string, unknown> | null}
 */
function readClaudeConfig(configPath, fileSystem = fs) {
  if (!fileSystem.existsSync(configPath)) return null
  const stat = fileSystem.lstatSync(configPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Claude MCP config must be a regular file: ${configPath}`)
  let value
  try {
    value = JSON.parse(fileSystem.readFileSync(configPath, 'utf8'))
  } catch (_error) {
    throw new Error(`Claude MCP config is not valid JSON: ${configPath}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Claude MCP config must contain a JSON object: ${configPath}`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Returns a copy of a Claude config with the NAX server installed at one scope.
 * @param {Record<string, unknown>} config
 * @param {'local' | 'project' | 'user'} scope
 * @param {string} projectRoot
 * @param {Record<string, unknown>} [server]
 */
function withNaxClaudeServer(config, scope, projectRoot, server = naxClaudeServer()) {
  const next = structuredClone(config)
  if (scope === 'local') {
    const root = canonicalProjectRoot(projectRoot)
    const projects = { ...objectValue(next.projects) }
    const project = { ...objectValue(projects[root]) }
    project.mcpServers = { ...objectValue(project.mcpServers), nax: server }
    projects[root] = project
    next.projects = projects
    return next
  }
  next.mcpServers = { ...objectValue(next.mcpServers), nax: server }
  return next
}

/**
 * Reads the configured NAX MCP entry for a scope.
 * @param {Record<string, unknown>} config
 * @param {'local' | 'project' | 'user'} scope
 * @param {string} projectRoot
 */
function configuredNaxClaudeServer(config, scope, projectRoot) {
  if (scope === 'local') {
    const root = canonicalProjectRoot(projectRoot)
    return objectValue(objectValue(objectValue(config.projects)[root]).mcpServers).nax
  }
  return objectValue(config.mcpServers).nax
}

/**
 * Writes text through an exclusive sibling and rename.
 * @param {string} filePath
 * @param {string} text
 * @param {number} mode
 * @param {{ fileSystem?: ClaudeSetupFileSystem, randomId?: () => string }} [options]
 */
function atomicWriteText(filePath, text, mode, { fileSystem = fs, randomId = () => crypto.randomUUID() } = {}) {
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${process.pid}.${randomId()}.tmp`
  let fd = -1
  try {
    fd = fileSystem.openSync(tempPath, 'wx', mode)
    fileSystem.writeFileSync(fd, text, 'utf8')
    fileSystem.fsyncSync(fd)
    fileSystem.closeSync(fd)
    fd = -1
    fileSystem.renameSync(tempPath, filePath)
    try { fileSystem.chmodSync(filePath, mode) } catch (_error) { /* unsupported on some platforms */ }
  } finally {
    if (fd >= 0) {
      try { fileSystem.closeSync(fd) } catch (_error) { /* already closed */ }
    }
    try { fileSystem.unlinkSync(tempPath) } catch (_error) { /* renamed or never created */ }
  }
}

/** @param {string} timestamp */
function backupSuffix(timestamp) {
  return timestamp.replace(/[^0-9A-Za-z]/g, '')
}

/**
 * Installs the NAX MCP server in Claude Code configuration.
 * @param {{
 *   scope?: 'local' | 'project' | 'user',
 *   projectRoot: string,
 *   dryRun?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   userConfigPath?: string,
 *   fileSystem?: ClaudeSetupFileSystem,
 *   now?: () => string,
 *   randomId?: () => string,
 *   probe?: (options?: Record<string, unknown>) => ClaudeCliProbe,
 *   onPreview?: (result: ClaudeMcpSetupResult) => void,
 * }} input
 * @returns {ClaudeMcpSetupResult}
 */
function setupClaudeMcp({
  scope = 'project',
  projectRoot,
  dryRun = false,
  env = process.env,
  homeDir = os.homedir(),
  userConfigPath = '',
  fileSystem = fs,
  now = () => new Date().toISOString(),
  randomId = () => crypto.randomUUID(),
  probe = probeClaudeCli,
  onPreview = () => {},
}) {
  if (!CLAUDE_SCOPES.includes(scope)) throw new TypeError(`Unsupported Claude MCP scope "${scope}".`)
  const root = canonicalProjectRoot(projectRoot)
  const cli = probe({ env, fileSystem })
  if (!cli.ok) throw new Error(cli.message)
  const location = claudeConfigLocation(scope, root, { homeDir, userConfigPath })
  const before = readClaudeConfig(location.configPath, fileSystem)
  const server = naxClaudeServer()
  const after = withNaxClaudeServer(before || {}, scope, root, server)
  const changed = !sameJson(before || {}, after)
  const backupPath = before && changed ? `${location.configPath}.nax-backup-${backupSuffix(now())}` : ''

  const result = {
    scope,
    projectRoot: root,
    ...location,
    server,
    before,
    after,
    changed,
    dryRun,
    backupPath,
    claudeExecutable: cli.executable,
  }
  onPreview(result)
  if (dryRun || !changed) return result

  const existingMode = before ? fileSystem.statSync(location.configPath).mode & 0o777 : (scope === 'project' ? 0o644 : 0o600)
  if (before) {
    atomicWriteText(backupPath, fileSystem.readFileSync(location.configPath, 'utf8'), existingMode, { fileSystem, randomId })
  }
  atomicWriteText(location.configPath, `${JSON.stringify(after, null, 2)}\n`, existingMode, { fileSystem, randomId })
  return result
}

/** @param {ClaudeMcpSetupResult} result */
function formatClaudeMcpSetupPreview(result) {
  const lines = [
    `Claude MCP setup (${result.scope} scope${result.dryRun ? ', dry run' : ''})`,
    `Config: ${result.configPath}`,
    `Set ${result.configKey} to:`,
    JSON.stringify(result.server, null, 2),
  ]
  if (!result.changed) lines.push('No change required; the NAX entry is already current.')
  else if (result.backupPath) lines.push(`Backup: ${result.backupPath}`)
  return lines.join('\n')
}

module.exports = {
  CLAUDE_SCOPES,
  atomicWriteText,
  claudeConfigLocation,
  configuredNaxClaudeServer,
  findExecutable,
  formatClaudeMcpSetupPreview,
  naxClaudeServer,
  probeClaudeCli,
  readClaudeConfig,
  setupClaudeMcp,
  withNaxClaudeServer,
}
