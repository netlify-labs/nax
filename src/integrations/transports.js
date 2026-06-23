const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { readLinkedSiteId } = require('./netlify/init')

const NETLIFY_API_TRANSPORT = 'netlify-api'
/** @typedef {'github' | typeof NETLIFY_API_TRANSPORT} TransportId */
/** @typedef {'auto' | TransportId | 'github-actions' | 'actions' | 'local' | 'local-machine' | 'machine'} TransportRequest */
/**
 * @typedef {{
 *   id: TransportId,
 *   title: string,
 *   available: boolean,
 *   reason: string,
 * }} TransportDetection
 */
/** @typedef {{ projectRoot?: string, env?: NodeJS.ProcessEnv }} DetectTransportsOptions */

/** @type {TransportId[]} */
const TRANSPORTS = ['github', NETLIFY_API_TRANSPORT]
/** @type {Record<TransportRequest, 'auto' | TransportId>} */
const TRANSPORT_ALIASES = {
  auto: 'auto',
  github: 'github',
  'github-actions': 'github',
  actions: 'github',
  [NETLIFY_API_TRANSPORT]: NETLIFY_API_TRANSPORT,
  local: NETLIFY_API_TRANSPORT,
  'local-machine': NETLIFY_API_TRANSPORT,
  machine: NETLIFY_API_TRANSPORT,
}

/**
 * @param {string} transport
 * @returns {boolean}
 */
function isNetlifyApiTransport(transport) {
  return transport === NETLIFY_API_TRANSPORT || transport === 'local'
}

/**
 * @param {string} dir
 * @param {(filePath: string) => boolean} predicate
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(filePath, predicate, out)
    } else if (predicate(filePath)) {
      out.push(filePath)
    }
  }
  return out
}

/**
 * @param {string} projectRoot
 * @returns {boolean}
 */
function hasAgentRunnerAction(projectRoot) {
  const workflowsDir = path.join(projectRoot, '.github', 'workflows')
  const files = walkFiles(workflowsDir, (filePath) => /\.(ya?ml)$/i.test(filePath))
  return files.some((filePath) => {
    const text = fs.readFileSync(filePath, 'utf8')
    return text.includes('netlify-labs/agent-runner-action')
  })
}

/** @returns {boolean} */
function hasNetlifyCli() {
  const result = spawnSync('netlify', ['--version'], { encoding: 'utf8' })
  return result.status === 0
}

/**
 * @param {string} projectRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function hasLocalNetlifySite(projectRoot, env = process.env) {
  return Boolean(readLinkedSiteId(projectRoot, env))
}

/**
 * @param {DetectTransportsOptions} [options]
 * @returns {TransportDetection[]}
 */
function detectTransports({ projectRoot = process.cwd(), env = process.env } = {}) {
  const githubReady = hasAgentRunnerAction(projectRoot)
  const localCliReady = hasNetlifyCli()
  const localSiteReady = hasLocalNetlifySite(projectRoot, env)
  return [
    {
      id: 'github',
      title: 'GitHub Actions via agent-runner-action',
      available: githubReady,
      reason: githubReady
        ? 'netlify-labs/agent-runner-action workflow detected'
        : 'No GitHub action detected',
    },
    {
      id: NETLIFY_API_TRANSPORT,
      title: 'This machine via the Netlify CLI',
      available: localCliReady && localSiteReady,
      reason: localCliReady
        ? (localSiteReady ? 'Detected Netlify CLI and local site context.' : 'Netlify CLI is installed, but no local site context was detected.')
        : 'Netlify CLI is not installed or not on PATH.',
    },
  ]
}

/**
 * @param {string | undefined | null} requested
 * @param {Array<Pick<TransportDetection, 'id' | 'available'>>} detections
 * @returns {TransportId}
 */
function resolveTransport(requested, detections) {
  const requestedKey = /** @type {TransportRequest} */ (String(requested || 'auto'))
  const normalized = TRANSPORT_ALIASES[requestedKey]
  if (normalized && normalized !== 'auto') {
    if (!TRANSPORTS.includes(normalized)) {
      throw new Error(`Unknown run location "${requested}". Expected one of: auto, github-actions, netlify-api, local-machine`)
    }
    return normalized
  }
  if (!normalized) {
    throw new Error(`Unknown run location "${requested}". Expected one of: auto, github-actions, netlify-api, local-machine`)
  }
  const available = detections.filter((transport) => transport.available)
  if (available.length > 0) return available[0].id
  throw new Error('No runnable transport detected.')
}

/**
 * @param {Array<Pick<TransportDetection, 'id' | 'title' | 'reason'>>} detections
 * @returns {string}
 */
function formatTransportSetupHelp(detections) {
  const byId = new Map(detections.map((transport) => [transport.id, transport]))
  const github = byId.get('github')
  const local = byId.get(NETLIFY_API_TRANSPORT)
  const lines = ['', 'No runnable transport detected for this repository.', '']

  if (github) lines.push(`- ${github.title}: ${github.reason}`)
  if (local) lines.push(`- ${local.title}: ${local.reason}`)

  lines.push('')
  lines.push('To run in GitHub Actions:')
  lines.push('  1. Add .github/workflows/netlify-agents.yml using netlify-labs/agent-runner-action.')
  lines.push('  2. Set GitHub Actions secrets NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN.')
  lines.push('  3. Re-run nax from the repository root.')
  lines.push('')
  lines.push('To run via the Netlify API from this machine:')
  lines.push('  1. Install and log in to Netlify CLI: netlify login')
  lines.push('  2. Link this repo to a Netlify site: netlify link')
  lines.push('  3. Re-run nax and choose "This machine via the Netlify API".')

  return lines.join('\n')
}

module.exports = {
  NETLIFY_API_TRANSPORT,
  TRANSPORTS,
  TRANSPORT_ALIASES,
  detectTransports,
  formatTransportSetupHelp,
  hasAgentRunnerAction,
  hasLocalNetlifySite,
  hasNetlifyCli,
  isNetlifyApiTransport,
  resolveTransport,
}
