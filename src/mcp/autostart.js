// Ensures a healthy nax dashboard is advertised for a project, launching one
// on demand so `nax mcp` works without a separately-started dashboard.
const { spawn } = require('node:child_process')

const { discoverDashboardInstance } = require('../runtime/local/mcp-instance-registry')

class DashboardAutostartError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DashboardAutostartError'
    this.code = code
    this.recoverable = true
    this.details = details
  }
}

/**
 * Auto-start is on unless explicitly disabled via NAX_MCP_AUTOSTART.
 * @param {NodeJS.ProcessEnv} [env]
 */
function autostartEnabled(env = process.env) {
  const raw = String(env.NAX_MCP_AUTOSTART ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/**
 * Spawn a detached, headless dashboard whose lifetime outlives this process.
 * @param {string} projectRoot
 * @param {{ naxEntry?: string, execPath?: string, spawnImpl?: typeof spawn }} [options]
 */
function spawnDashboard(projectRoot, { naxEntry = process.argv[1], execPath = process.execPath, spawnImpl = spawn } = {}) {
  const child = spawnImpl(execPath, [naxEntry, 'dashboard', '--no-open', '--no-tail'], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
  })
  child.unref?.()
  return child
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ensures a healthy dashboard is advertised for projectRoot, launching one and
 * waiting for health when none is found. Returns { started } — true when this
 * call launched the dashboard.
 *
 * @param {{
 *   projectRoot: string,
 *   discover?: (projectRoot: string) => Promise<unknown>,
 *   launch?: (projectRoot: string) => unknown,
 *   autostart?: boolean,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   wait?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} input
 * @returns {Promise<{ started: boolean }>}
 */
async function ensureDashboardRunning({
  projectRoot,
  discover = (root) => discoverDashboardInstance({ projectRoot: root }),
  launch = (root) => spawnDashboard(root),
  autostart = autostartEnabled(),
  timeoutMs = 30000,
  pollMs = 300,
  wait = defaultSleep,
  now = () => Date.now(),
}) {
  // Opt-out is a pure no-op: don't even probe the registry. The adapter still
  // discovers per request and reports dashboard_not_running when none exists,
  // so behavior matches a build without auto-start.
  if (!autostart) return { started: false }

  // A version mismatch or other hard error should surface, not trigger a spawn.
  const existing = await discover(projectRoot)
  if (existing) return { started: false }

  launch(projectRoot)

  const deadline = now() + timeoutMs
  while (now() < deadline) {
    await wait(pollMs)
    let record = null
    try {
      record = await discover(projectRoot)
    } catch (_error) {
      // Registry/health can flap while the dashboard boots; keep polling.
    }
    if (record) return { started: true }
  }

  throw new DashboardAutostartError('dashboard_autostart_timeout', `Auto-started a nax dashboard but it did not become healthy within ${Math.round(timeoutMs / 1000)}s.`, {
    projectRoot,
    fix: 'nax dashboard --no-open',
  })
}

module.exports = { DashboardAutostartError, autostartEnabled, ensureDashboardRunning, spawnDashboard }
