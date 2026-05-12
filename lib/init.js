const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const WORKFLOW_PATH = path.join('.github', 'workflows', 'netlify-agents.yml')
const WORKFLOW_TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'netlify-agents.yml')

function run(command, args, { cwd, input, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: 30000,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function commandExists(command) {
  return run(command, ['--version'], { allowFailure: true }).status === 0
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readLinkedSiteId(projectRoot, env = process.env) {
  if (env.NETLIFY_SITE_ID) return env.NETLIFY_SITE_ID
  const statePath = path.join(projectRoot, '.netlify', 'state.json')
  if (!fs.existsSync(statePath)) return ''
  try {
    return readJson(statePath).siteId || ''
  } catch {
    return ''
  }
}

function readNetlifyStatus(projectRoot) {
  const result = run('netlify', ['status', '--json'], { cwd: projectRoot, allowFailure: true })
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

function siteIdFromStatus(status) {
  return status?.siteData?.['site-id'] || status?.siteData?.siteId || ''
}

function resolveGitHubRepo({ projectRoot, repo }) {
  if (repo) return repo
  const result = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: projectRoot,
  })
  return result.stdout.trim()
}

function defaultSiteName(projectRoot, repo) {
  const repoName = repo ? repo.split('/').pop() : ''
  return (repoName || path.basename(projectRoot))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function readNetlifyCliToken({ env = process.env, home = os.homedir() } = {}) {
  if (env.NETLIFY_AUTH_TOKEN) {
    return { token: env.NETLIFY_AUTH_TOKEN, source: 'NETLIFY_AUTH_TOKEN' }
  }

  const candidates = [
    path.join(home, 'Library', 'Preferences', 'netlify', 'config.json'),
    path.join(home, '.netlify', 'config.json'),
  ]

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    try {
      const config = readJson(filePath)
      const user = config.users?.[config.userId]
      const token = user?.auth?.token
      if (token) return { token, source: filePath }
    } catch {
      // Ignore corrupt or unfamiliar CLI config and keep looking.
    }
  }

  return { token: '', source: '' }
}

function loadWorkflowTemplate() {
  return fs.readFileSync(WORKFLOW_TEMPLATE_PATH, 'utf8')
}

function ensureWorkflow({ projectRoot, force = false, dryRun = false } = {}) {
  const workflowPath = path.join(projectRoot, WORKFLOW_PATH)
  const exists = fs.existsSync(workflowPath)
  if (exists) {
    const current = fs.readFileSync(workflowPath, 'utf8')
    if (current.includes('netlify-labs/agent-runner-action')) {
      return { path: workflowPath, status: 'exists' }
    }
    if (!force) {
      throw new Error(`${WORKFLOW_PATH} already exists and does not use netlify-labs/agent-runner-action. Re-run with --force to replace it.`)
    }
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
    fs.writeFileSync(workflowPath, loadWorkflowTemplate())
  }

  return { path: workflowPath, status: exists ? 'replaced' : 'created' }
}

function parseCreatedSiteId(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    return parsed.id || parsed.site_id || parsed.siteId || ''
  } catch {
    return ''
  }
}

function ensureNetlifyProject({ projectRoot, repo, siteId, siteName, create = false, dryRun = false, interactive = false, env = process.env } = {}) {
  const status = dryRun ? null : readNetlifyStatus(projectRoot)
  const statusSiteId = status ? siteIdFromStatus(status) : ''
  const linkedSiteId = statusSiteId || readLinkedSiteId(projectRoot, env)
  if (linkedSiteId) {
    return { siteId: linkedSiteId, status: 'exists' }
  }

  if (siteId) {
    if (!dryRun) run('netlify', ['link', '--id', siteId], { cwd: projectRoot })
    return { siteId, status: dryRun ? 'would-link' : 'linked' }
  }

  if (siteName && !create) {
    if (!dryRun) run('netlify', ['link', '--name', siteName], { cwd: projectRoot })
    const linked = dryRun ? '' : (siteIdFromStatus(readNetlifyStatus(projectRoot)) || readLinkedSiteId(projectRoot, env))
    return { siteId: linked, status: dryRun ? 'would-link' : 'linked' }
  }

  if (create) {
    const name = siteName || defaultSiteName(projectRoot, repo)
    if (dryRun) return { siteId: '', status: 'would-create', siteName: name }
    const result = run('netlify', ['sites:create', '--name', name, '--json'], { cwd: projectRoot })
    const createdSiteId = parseCreatedSiteId(result.stdout) || siteIdFromStatus(readNetlifyStatus(projectRoot)) || readLinkedSiteId(projectRoot, env)
    if (!createdSiteId) throw new Error('Netlify project was created or linked, but no site ID could be resolved.')
    return { siteId: createdSiteId, status: 'created', siteName: name }
  }

  if (interactive) {
    if (!dryRun) run('netlify', ['init'], { cwd: projectRoot })
    const linked = dryRun ? '' : (siteIdFromStatus(readNetlifyStatus(projectRoot)) || readLinkedSiteId(projectRoot, env))
    if (!dryRun && !linked) throw new Error('Netlify init completed, but no site ID could be resolved.')
    return { siteId: linked, status: dryRun ? 'would-init' : 'initialized' }
  }

  throw new Error('No Netlify project is linked. Re-run with --site-id, --site-name, or --create.')
}

function setGitHubSecret({ projectRoot, repo, name, value, dryRun = false }) {
  if (!value) throw new Error(`Cannot set ${name}: missing value.`)
  if (!dryRun) {
    run('gh', ['secret', 'set', name, '--repo', repo], {
      cwd: projectRoot,
      input: value,
    })
  }
  return { name, status: dryRun ? 'would-set' : 'set' }
}

function initProject({
  projectRoot = process.cwd(),
  repo,
  siteId,
  siteName,
  create = false,
  force = false,
  dryRun = false,
  skipSecrets = false,
  githubActions = true,
  interactive = false,
  env = process.env,
} = {}) {
  const root = path.resolve(projectRoot)
  if (!fs.existsSync(path.join(root, '.git'))) {
    const result = run('git', ['rev-parse', '--show-toplevel'], { cwd: root, allowFailure: true })
    if (result.status !== 0) throw new Error(`Not inside a git repository: ${root}`)
  }
  if (!commandExists('netlify')) throw new Error('Netlify CLI is required. Install it and authenticate with netlify login.')

  const resolvedRepo = githubActions ? resolveGitHubRepo({ projectRoot: root, repo }) : (repo || '')
  const netlify = ensureNetlifyProject({
    projectRoot: root,
    repo: resolvedRepo,
    siteId,
    siteName,
    create,
    dryRun,
    interactive,
    env,
  })
  const workflow = githubActions ? ensureWorkflow({ projectRoot: root, force, dryRun }) : null
  const secrets = []

  if (githubActions) {
    if (!commandExists('gh')) throw new Error('GitHub CLI is required. Install gh and authenticate with gh auth login.')
  }

  if (githubActions && !skipSecrets) {
    const token = readNetlifyCliToken({ env })
    if (!token.token) {
      throw new Error('Could not find a Netlify auth token. Run netlify login or set NETLIFY_AUTH_TOKEN before running nax init.')
    }
    const effectiveSiteId = netlify.siteId || siteId || (dryRun && (netlify.status === 'would-create' || netlify.status === 'would-link' || netlify.status === 'would-init') ? '<netlify-site-id>' : '')
    if (!effectiveSiteId) {
      throw new Error('Could not resolve NETLIFY_SITE_ID. Link/create a Netlify project first, or pass --site-id.')
    }
    secrets.push(setGitHubSecret({ projectRoot: root, repo: resolvedRepo, name: 'NETLIFY_SITE_ID', value: effectiveSiteId, dryRun }))
    secrets.push(setGitHubSecret({ projectRoot: root, repo: resolvedRepo, name: 'NETLIFY_AUTH_TOKEN', value: token.token, dryRun }))
  }

  return {
    projectRoot: root,
    repo: resolvedRepo,
    netlify,
    githubActions,
    workflow,
    secrets,
  }
}

module.exports = {
  WORKFLOW_PATH,
  defaultSiteName,
  ensureNetlifyProject,
  ensureWorkflow,
  initProject,
  readLinkedSiteId,
  readNetlifyCliToken,
  resolveGitHubRepo,
  setGitHubSecret,
  siteIdFromStatus,
}
