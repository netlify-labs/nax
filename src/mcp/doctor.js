const fs = require('node:fs')
const os = require('node:os')

const { PACKAGE_VERSION } = require('../core/artifact-metadata')
const {
  canonicalProjectRoot,
  processIsAlive,
  projectIdentityPath,
  readDashboardInstance,
} = require('../runtime/local/mcp-instance-registry')
const { createLocalDashboardClient } = require('./adapters/local-dashboard')
const { discoverDashboardSession } = require('./adapters/local-dashboard-http')
const { redactSecretText } = require('./security')
const {
  claudeConfigLocation,
  configuredNaxClaudeServer,
  findExecutable,
  naxClaudeServer,
  probeClaudeCli,
  readClaudeConfig,
} = require('./setup')

const START_DASHBOARD_GUIDANCE = 'Start the nax control plane for this project: nax dashboard --no-open.'

/**
 * @typedef {'pass' | 'warn' | 'fail'} DoctorStatus
 * @typedef {{
 *   id: string,
 *   label: string,
 *   status: DoctorStatus,
 *   message: string,
 *   hint?: string,
 * }} DoctorCheck
 * @typedef {{
 *   ok: boolean,
 *   projectRoot: string,
 *   checks: DoctorCheck[],
 *   totals: { pass: number, warn: number, fail: number },
 * }} McpDoctorResult
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} error */
function safeErrorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return redactSecretText(error.message)
  return redactSecretText(error)
}

/**
 * @param {DoctorCheck[]} checks
 * @param {string} id
 * @param {string} label
 * @param {DoctorStatus} status
 * @param {string} message
 * @param {string} [hint]
 */
function addCheck(checks, id, label, status, message, hint = '') {
  checks.push({ id, label, status, message: redactSecretText(message), ...(hint ? { hint: redactSecretText(hint) } : {}) })
}

/** @param {string} filePath */
function readJsonObject(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object')
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Finds a matching NAX entry in Claude project, local, or user scope.
 * @param {string} projectRoot
 * @param {{ homeDir?: string, userConfigPath?: string }} [options]
 */
function inspectClaudeMcpConfig(projectRoot, { homeDir = os.homedir(), userConfigPath = '' } = {}) {
  const expected = naxClaudeServer()
  /** @type {Array<'project' | 'local' | 'user'>} */
  const scopes = ['project', 'local', 'user']
  /** @type {Array<{ scope: 'project' | 'local' | 'user', configPath: string, configured: boolean, current: boolean }>} */
  const entries = []
  /** @type {Map<string, Record<string, unknown> | null>} */
  const configs = new Map()
  for (const scope of scopes) {
    const location = claudeConfigLocation(scope, projectRoot, { homeDir, userConfigPath })
    let config = configs.get(location.configPath)
    if (config === undefined) {
      config = readClaudeConfig(location.configPath)
      configs.set(location.configPath, config)
    }
    const entry = config ? configuredNaxClaudeServer(config, scope, projectRoot) : undefined
    entries.push({
      scope,
      configPath: location.configPath,
      configured: Boolean(entry && typeof entry === 'object'),
      current: JSON.stringify(entry) === JSON.stringify(expected),
    })
  }
  return entries
}

/**
 * Runs read-only diagnostics for the local MCP adapter.
 * @param {{
 *   projectRoot: string,
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   userConfigPath?: string,
 *   registry?: import('../runtime/local/mcp-instance-registry').RegistryPathOptions,
 *   claudeProbe?: typeof probeClaudeCli,
 *   executableFinder?: typeof findExecutable,
 *   processAlive?: (pid: number) => boolean,
 *   packageResolver?: (specifier: string) => string,
 *   registryReader?: typeof readDashboardInstance,
 *   sessionDiscoverer?: typeof discoverDashboardSession,
 *   clientFactory?: typeof createLocalDashboardClient,
 *   configInspector?: typeof inspectClaudeMcpConfig,
 * }} input
 * @returns {Promise<McpDoctorResult>}
 */
async function runMcpDoctor({
  projectRoot,
  env = process.env,
  homeDir = os.homedir(),
  userConfigPath = '',
  registry = {},
  claudeProbe = probeClaudeCli,
  executableFinder = findExecutable,
  processAlive = processIsAlive,
  packageResolver = require.resolve,
  registryReader = readDashboardInstance,
  sessionDiscoverer = discoverDashboardSession,
  clientFactory = createLocalDashboardClient,
  configInspector = inspectClaudeMcpConfig,
}) {
  const checks = /** @type {DoctorCheck[]} */ ([])
  let root
  try {
    root = canonicalProjectRoot(projectRoot)
    addCheck(checks, 'project_root', 'Project root', 'pass', `Resolved project root: ${root}`)
  } catch (error) {
    addCheck(checks, 'project_root', 'Project root', 'fail', safeErrorMessage(error), 'Run doctor from an existing project directory or pass --project-root.')
    return doctorResult(String(projectRoot || ''), checks)
  }

  const naxExecutable = executableFinder('nax', { env })
  addCheck(
    checks,
    'nax_binary',
    'NAX binary',
    naxExecutable ? 'pass' : 'fail',
    naxExecutable ? `Found nax on PATH: ${naxExecutable}` : 'The nax executable was not found on PATH.',
    naxExecutable ? '' : 'Install or link this package so Claude can execute `nax mcp`.',
  )

  try {
    packageResolver('../../package.json')
    addCheck(checks, 'package_load', 'NAX package', 'pass', `Loaded netlify-agent-executor ${PACKAGE_VERSION}.`)
  } catch (error) {
    addCheck(checks, 'package_load', 'NAX package', 'fail', safeErrorMessage(error), 'Reinstall netlify-agent-executor.')
  }

  try {
    packageResolver('@modelcontextprotocol/server')
    addCheck(checks, 'mcp_sdk', 'MCP SDK', 'pass', 'Loaded the MCP server SDK.')
  } catch (error) {
    addCheck(checks, 'mcp_sdk', 'MCP SDK', 'fail', safeErrorMessage(error), 'Reinstall netlify-agent-executor dependencies.')
  }

  const claude = claudeProbe({ env })
  addCheck(checks, 'claude_cli', 'Claude CLI', claude.ok ? 'pass' : 'fail', claude.message, claude.ok ? '' : 'Install or update Claude Code, then rerun doctor.')

  try {
    const configured = configInspector(root, { homeDir, userConfigPath })
    const current = configured.filter((entry) => entry.current)
    const stale = configured.filter((entry) => entry.configured && !entry.current)
    if (current.length > 0) {
      addCheck(checks, 'claude_config', 'Claude MCP config', 'pass', `NAX is configured in Claude ${current.map((entry) => entry.scope).join(', ')} scope.`)
    } else if (stale.length > 0) {
      addCheck(checks, 'claude_config', 'Claude MCP config', 'warn', 'Claude has a NAX MCP entry, but it does not match the current portable command.', 'Run `nax mcp setup claude --scope project`.')
    } else {
      addCheck(checks, 'claude_config', 'Claude MCP config', 'warn', 'Claude does not have a NAX MCP entry.', 'Run `nax mcp setup claude --scope project`.')
    }
  } catch (error) {
    addCheck(checks, 'claude_config', 'Claude MCP config', 'fail', safeErrorMessage(error), 'Repair the malformed Claude config before running setup.')
  }

  const identityPath = projectIdentityPath(root)
  try {
    if (!fs.existsSync(identityPath)) {
      addCheck(checks, 'project_identity', 'Project identity', 'warn', 'No stable NAX project identity exists yet.', START_DASHBOARD_GUIDANCE)
    } else {
      const identity = readJsonObject(identityPath)
      const projectId = String(identity.projectId || '')
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(projectId)) throw new Error('The persisted project identity is invalid.')
      addCheck(checks, 'project_identity', 'Project identity', 'pass', 'Found a stable NAX project identity.')
    }
  } catch (error) {
    addCheck(checks, 'project_identity', 'Project identity', 'fail', safeErrorMessage(error), 'Move the invalid .nax/project.json aside, then restart the dashboard.')
  }

  let record = null
  try {
    record = registryReader(root, registry)
    if (!record) {
      addCheck(checks, 'dashboard_registry', 'Dashboard registry', 'fail', 'No dashboard is advertised for this project.', START_DASHBOARD_GUIDANCE)
    } else if (!processAlive(record.pid)) {
      addCheck(checks, 'dashboard_registry', 'Dashboard registry', 'fail', 'The advertised dashboard process is not running.', START_DASHBOARD_GUIDANCE)
      record = null
    } else {
      addCheck(checks, 'dashboard_registry', 'Dashboard registry', 'pass', 'The private dashboard registry is valid and its process is running.')
    }
  } catch (error) {
    addCheck(checks, 'dashboard_registry', 'Dashboard registry', 'fail', safeErrorMessage(error), START_DASHBOARD_GUIDANCE)
  }

  if (record) {
    try {
      const session = await sessionDiscoverer({ projectRoot: root, registry })
      addCheck(checks, 'dashboard_health', 'Dashboard health and auth', 'pass', 'Authenticated dashboard health check passed.')
      addCheck(checks, 'dashboard_version', 'Dashboard version', 'pass', `Dashboard and adapter versions match (${record.version}).`)
      const access = objectValue(session.health.netlifyAccess)
      if (access.ok === true) {
        const site = objectValue(access.site)
        addCheck(checks, 'netlify_target', 'Netlify target', 'pass', `Dashboard can access the selected site${site.name ? ` ${String(site.name)}` : ''}.`)
      } else {
        addCheck(
          checks,
          'netlify_target',
          'Netlify target',
          'fail',
          String(access.message || 'The dashboard has not verified access to a Netlify Agent Runner site.'),
          'Link or select an accessible Netlify site, then restart the dashboard.',
        )
      }

      const client = clientFactory({
        projectRoot: root,
        registry,
        auditSink: { record() {} },
      })
      const context = await client.getContext()
      const capabilityEntries = Object.entries(context.capabilities)
      const available = capabilityEntries.filter(([, capability]) => capability.available).length
      const unavailable = capabilityEntries.length - available
      addCheck(
        checks,
        'capabilities',
        'MCP capabilities',
        unavailable === 0 ? 'pass' : 'warn',
        `${available} capabilities available${unavailable ? `; ${unavailable} unavailable in this runtime` : ''}.`,
      )
      addCheck(checks, 'context_get', 'context_get smoke', 'pass', `Read authenticated ${context.runtime} context for scope ${context.scope.scopeId}.`)
    } catch (error) {
      addCheck(checks, 'dashboard_health', 'Dashboard health and auth', 'fail', safeErrorMessage(error), START_DASHBOARD_GUIDANCE)
    }
  }

  return doctorResult(root, checks)
}

/** @param {string} projectRoot @param {DoctorCheck[]} checks @returns {McpDoctorResult} */
function doctorResult(projectRoot, checks) {
  const totals = {
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  }
  return { ok: totals.fail === 0, projectRoot, checks, totals }
}

/** @param {McpDoctorResult} result */
function formatMcpDoctor(result) {
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }
  const lines = ['NAX MCP doctor', `Project: ${result.projectRoot}`, '']
  for (const check of result.checks) {
    lines.push(`[${icon[check.status]}] ${check.label}: ${check.message}`)
    if (check.hint) lines.push(`       ${check.hint}`)
  }
  lines.push('', `${result.totals.pass} passed, ${result.totals.warn} warnings, ${result.totals.fail} failed.`)
  return lines.join('\n')
}

module.exports = {
  START_DASHBOARD_GUIDANCE,
  doctorResult,
  formatMcpDoctor,
  inspectClaudeMcpConfig,
  runMcpDoctor,
}
