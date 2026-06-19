const fs = require('fs')
const os = require('os')
const path = require('path')
const { runGh } = require('./gh-cli')
const { listWorkflowStates, workflowStatePath } = require('./run-state')
const { persistWorkflowArtifacts } = require('./workflow-artifacts')
const { listAgentRunnerArtifacts, persistAgentRunnerArtifact } = require('./agent-runner-artifacts')
const { listAgentSessionArtifacts, persistAgentSessionArtifact } = require('./agent-session-artifacts')

const NAX_ARTIFACT_PREFIX = 'nax-'
const NAX_ARTIFACT_DIRS = ['workflows', 'agent-runners', 'agent-sessions']

function parseGithubActionsRunTarget(target) {
  const value = String(target || '').trim()
  if (!value) return null
  const url = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:[/?#].*)?$/i)
  if (url) return { repo: `${url[1]}/${url[2]}`, runId: url[3] }
  if (/^\d+$/.test(value)) return { repo: '', runId: value }
  return null
}

function parseArtifactsPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.artifacts)) return payload.artifacts
  return []
}

/** @param {Record<string, any>} param0 */
function listGithubRunArtifacts({ repo, runId, cwd, env, runCommand } = {}) {
  if (!repo) throw new Error('GitHub repo is required to sync a GitHub Actions run.')
  if (!runId) throw new Error('GitHub Actions run ID is required.')
  const result = runGh([
    'api',
    `repos/${repo}/actions/runs/${runId}/artifacts`,
  ], {
    cwd,
    env,
    runCommand,
    timeout: 30000,
    errorPrefix: `Could not list artifacts for GitHub Actions run ${runId}`,
  })
  try {
    return parseArtifactsPayload(JSON.parse(result.stdout || '{}'))
  } catch (error) {
    throw new Error(`Could not parse artifacts for GitHub Actions run ${runId}: ${error.message}`)
  }
}

function artifactCreatedAt(artifact = {}) {
  return artifact.created_at || artifact.createdAt || ''
}

/** @param {Array<Record<string, any>>} artifacts @param {Record<string, any>} param1 */
function selectNaxArtifact(artifacts = [], { artifactName, runId } = {}) {
  const available = artifacts.filter((artifact) => !artifact.expired)
  if (artifactName) {
    const exact = available.find((artifact) => artifact.name === artifactName)
    if (!exact) throw new Error(`GitHub Actions artifact "${artifactName}" was not found or has expired.`)
    return exact
  }
  const preferredName = runId ? new RegExp(`^${NAX_ARTIFACT_PREFIX}[^/]+-${runId}$`) : null
  const candidates = available
    .filter((artifact) => String(artifact.name || '').startsWith(NAX_ARTIFACT_PREFIX))
    .sort((a, b) => String(artifactCreatedAt(b)).localeCompare(String(artifactCreatedAt(a))))
  if (preferredName) {
    const preferred = candidates.find((artifact) => preferredName.test(String(artifact.name || '')))
    if (preferred) return preferred
  }
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new Error(`Multiple NAX artifacts found: ${candidates.map((artifact) => artifact.name).join(', ')}. Pass --artifact <name>.`)
  }
  throw new Error('No unexpired NAX artifact found for this GitHub Actions run.')
}

/** @param {Record<string, any>} param0 */
function downloadGithubRunArtifact({ repo, runId, artifactName, dir, cwd, env, runCommand } = {}) {
  runGh([
    'run',
    'download',
    String(runId),
    '--repo',
    repo,
    '--name',
    artifactName,
    '--dir',
    dir,
  ], {
    cwd,
    env,
    runCommand,
    timeout: 120000,
    errorPrefix: `Could not download GitHub Actions artifact "${artifactName}"`,
  })
}

function countFiles(root) {
  if (!fs.existsSync(root)) return 0
  let count = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      count += countFiles(filePath)
    } else {
      count += 1
    }
  }
  return count
}

function copyNaxDir(sourceRoot, projectRoot) {
  let copiedFiles = 0
  const naxRoot = path.join(projectRoot, '.nax')
  for (const name of NAX_ARTIFACT_DIRS) {
    const sourceDir = path.join(sourceRoot, name)
    if (!fs.existsSync(sourceDir)) continue
    const targetDir = path.join(naxRoot, name)
    fs.mkdirSync(targetDir, { recursive: true })
    fs.rmSync(path.join(targetDir, 'latest'), { recursive: true, force: true })
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name === 'latest') continue
      const sourcePath = path.join(sourceDir, entry.name)
      const targetPath = path.join(targetDir, entry.name)
      copiedFiles += entry.isDirectory() ? countFiles(sourcePath) : 1
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true })
    }
  }
  return copiedFiles
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function localizeWorkflowStates(projectRoot) {
  const workflowsRoot = path.join(projectRoot, '.nax', 'workflows')
  if (!fs.existsSync(workflowsRoot)) return 0
  let count = 0
  for (const entry of fs.readdirSync(workflowsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'latest') continue
    const dir = path.join(workflowsRoot, entry.name)
    const filePath = workflowStatePath(dir)
    const state = readJsonIfExists(filePath)
    if (!state) continue
    writeJson(filePath, { ...state, projectRoot, dir })
    count += 1
  }
  return count
}

function updateLatestSymlink(root, targetName) {
  if (!root || !targetName) return false
  fs.mkdirSync(root, { recursive: true })
  const latest = path.join(root, 'latest')
  const tmp = path.join(root, `latest.tmp-${process.pid}-${Date.now()}`)
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
    fs.symlinkSync(targetName, tmp, 'dir')
    fs.rmSync(latest, { recursive: true, force: true })
    fs.renameSync(tmp, latest)
    return true
  } catch {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures.
    }
    return false
  }
}

function refreshMaterializedArtifacts(projectRoot) {
  localizeWorkflowStates(projectRoot)
  const sessions = listAgentSessionArtifacts(projectRoot).slice().reverse()
  for (const session of sessions) persistAgentSessionArtifact({ projectRoot, ...session })
  const runners = listAgentRunnerArtifacts(projectRoot).slice().reverse()
  for (const runner of runners) persistAgentRunnerArtifact({ projectRoot, ...runner })
  const workflows = listWorkflowStates(projectRoot).slice().reverse()
  for (const workflow of workflows) persistWorkflowArtifacts({ ...workflow, projectRoot }, { summaryOnly: true, updateLatest: false })
  const latestWorkflow = listWorkflowStates(projectRoot)[0] || null
  if (latestWorkflow?.runId) updateLatestSymlink(path.join(projectRoot, '.nax', 'workflows'), latestWorkflow.runId)
  return {
    workflowCount: workflows.length,
    runnerCount: runners.length,
    sessionCount: sessions.length,
    latestWorkflowId: latestWorkflow?.runId || '',
  }
}

/** @param {Record<string, any>} param0 */
function materializeNaxArtifactTree({ projectRoot, artifactDir } = {}) {
  if (!projectRoot) throw new Error('Project root is required to materialize a NAX artifact.')
  if (!artifactDir) throw new Error('Artifact directory is required.')
  const sourceRoot = fs.existsSync(path.join(artifactDir, '.nax')) ? path.join(artifactDir, '.nax') : artifactDir
  const copiedFileCount = copyNaxDir(sourceRoot, projectRoot)
  const refreshed = refreshMaterializedArtifacts(projectRoot)
  return {
    dir: path.join(projectRoot, '.nax'),
    copiedFileCount,
    ...refreshed,
  }
}

/** @param {Record<string, any>} param0 */
function syncGithubActionsRun({ projectRoot, repo, runId, artifactName, cwd, env, runCommand } = {}) {
  if (!projectRoot) throw new Error('Project root is required to sync a GitHub Actions run.')
  const artifacts = listGithubRunArtifacts({ repo, runId, cwd, env, runCommand })
  const artifact = selectNaxArtifact(artifacts, { artifactName, runId })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `nax-actions-${runId}-`))
  try {
    downloadGithubRunArtifact({ repo, runId, artifactName: artifact.name, dir: tmp, cwd, env, runCommand })
    const materialized = materializeNaxArtifactTree({ projectRoot, artifactDir: tmp })
    return {
      repo,
      runId,
      artifactName: artifact.name,
      artifactSize: artifact.size_in_bytes || artifact.sizeInBytes || 0,
      ...materialized,
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = {
  materializeNaxArtifactTree,
  parseGithubActionsRunTarget,
  selectNaxArtifact,
  syncGithubActionsRun,
}
