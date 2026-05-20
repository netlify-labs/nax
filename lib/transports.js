const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { readLinkedSiteId } = require('./init')

const TRANSPORTS = ['github', 'local']
const TRANSPORT_ALIASES = {
  auto: 'auto',
  github: 'github',
  'github-actions': 'github',
  actions: 'github',
  local: 'local',
  'local-machine': 'local',
  machine: 'local',
}

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

function hasAgentRunnerAction(projectRoot) {
  const workflowsDir = path.join(projectRoot, '.github', 'workflows')
  const files = walkFiles(workflowsDir, (filePath) => /\.(ya?ml)$/i.test(filePath))
  return files.some((filePath) => {
    const text = fs.readFileSync(filePath, 'utf8')
    return text.includes('netlify-labs/agent-runner-action')
  })
}

function hasNetlifyCli() {
  const result = spawnSync('netlify', ['--version'], { encoding: 'utf8' })
  return result.status === 0
}

function hasLocalNetlifySite(projectRoot, env = process.env) {
  return Boolean(readLinkedSiteId(projectRoot, env))
}

function detectTransports({ projectRoot = process.cwd(), env = process.env } = {}) {
  const githubReady = hasAgentRunnerAction(projectRoot)
  const localCliReady = hasNetlifyCli()
  const localSiteReady = hasLocalNetlifySite(projectRoot, env)
  return [
    {
      id: 'github',
      title: 'In GitHub Actions',
      available: githubReady,
      reason: githubReady
        ? 'Detected netlify-labs/agent-runner-action in .github/workflows.'
        : 'No github action with netlify-labs/agent-runner-action detected.',
    },
    {
      id: 'local',
      title: 'Locally on this machine',
      available: localCliReady && localSiteReady,
      reason: localCliReady
        ? (localSiteReady ? 'Detected Netlify CLI and local site context.' : 'Netlify CLI is installed, but no local site context was detected.')
        : 'Netlify CLI is not installed or not on PATH.',
    },
  ]
}

function resolveTransport(requested, detections) {
  const normalized = TRANSPORT_ALIASES[String(requested || 'auto')]
  if (normalized && normalized !== 'auto') {
    if (!TRANSPORTS.includes(normalized)) {
      throw new Error(`Unknown run location "${requested}". Expected one of: auto, github-actions, local-machine`)
    }
    return normalized
  }
  if (!normalized) {
    throw new Error(`Unknown run location "${requested}". Expected one of: auto, github-actions, local-machine`)
  }
  const available = detections.filter((transport) => transport.available)
  if (available.length > 0) return available[0].id
  throw new Error('No runnable transport detected.')
}

function formatTransportSetupHelp(detections) {
  const byId = new Map(detections.map((transport) => [transport.id, transport]))
  const github = byId.get('github')
  const local = byId.get('local')
  const lines = ['', 'No runnable transport detected for this repository.', '']

  if (github) lines.push(`- ${github.title}: ${github.reason}`)
  if (local) lines.push(`- ${local.title}: ${local.reason}`)

  lines.push('')
  lines.push('To run in GitHub Actions:')
  lines.push('  1. Add .github/workflows/netlify-agents.yml using netlify-labs/agent-runner-action.')
  lines.push('  2. Set GitHub Actions secrets NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN.')
  lines.push('  3. Re-run nax from the repository root.')
  lines.push('')
  lines.push('To run locally on this machine:')
  lines.push('  1. Install and log in to Netlify CLI: netlify login')
  lines.push('  2. Link this repo to a Netlify site: netlify link')
  lines.push('  3. Re-run nax and choose "Locally on this machine".')

  return lines.join('\n')
}

module.exports = {
  TRANSPORTS,
  TRANSPORT_ALIASES,
  detectTransports,
  formatTransportSetupHelp,
  hasAgentRunnerAction,
  hasLocalNetlifySite,
  hasNetlifyCli,
  resolveTransport,
}
