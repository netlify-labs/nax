const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { assertGhAuthenticated, runGh } = require('../github/gh-cli')

const WORKFLOW_PATH = path.join('.github', 'workflows', 'netlify-agents.yml')
const WORKFLOWS_DIR = path.join('.github', 'workflows')
const WORKFLOW_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'netlify-agents.yml')
const AGENT_RUNNER_MARKER = 'netlify-labs/agent-runner-action'

/**
 * Options for running one synchronous init command.
 * @typedef {{
 *   cwd?: string,
 *   input?: string | Buffer,
 *   env?: NodeJS.ProcessEnv,
 *   allowFailure?: boolean,
 *   stdio?: import('child_process').SpawnSyncOptions['stdio'],
 * }} InitRunOptions
 *
 * Synchronous command runner used by init helpers.
 * @callback InitRunCommand
 * @param {string} command
 * @param {string[]} args
 * @param {InitRunOptions} [options]
 * @returns {import('../../types').CommandResult}
 *
 * GitHub CLI command runner used by secret helpers.
 * @callback InitGitHubRunCommand
 * @param {string} command
 * @param {string[]} args
 * @param {import('child_process').SpawnSyncOptionsWithStringEncoding} [options]
 * @returns {import('../../types').CommandResult}
 *
 * Netlify project metadata resolved from local CLI state.
 * @typedef {{
 *   siteId?: string,
 *   siteName?: string,
 *   siteUrl?: string,
 *   adminUrl?: string,
 *   accountName?: string,
 *   accountEmail?: string,
 *   accountTeams?: unknown[],
 *   status?: string,
 * }} NetlifyProjectInfo
 *
 * GitHub secret setup result.
 * @typedef {{
 *   name: string,
 *   status: string,
 *   reason?: string,
 * }} GitHubSecretResult
 *
 * Options for ensuring a Netlify project exists locally.
 * @typedef {{
 *   projectRoot?: string,
 *   repo?: string,
 *   siteId?: string,
 *   siteName?: string,
 *   create?: boolean,
 *   dryRun?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   runCommand?: InitRunCommand,
 *   readProject?: (projectRoot: string, env?: NodeJS.ProcessEnv) => NetlifyProjectInfo | null,
 *   initNotice?: (projectRoot: string) => void,
 * }} EnsureNetlifyProjectOptions
 *
 * Options for listing GitHub secret names.
 * @typedef {{
 *   projectRoot?: string,
 *   repo?: string,
 *   runCommand?: InitGitHubRunCommand,
 * }} ListGitHubSecretNamesOptions
 *
 * Options for creating or checking a GitHub secret.
 * @typedef {{
 *   projectRoot?: string,
 *   repo?: string,
 *   name?: string,
 *   value?: string,
 *   dryRun?: boolean,
 *   existingSecrets?: Set<string>,
 *   runCommand?: InitGitHubRunCommand,
 * }} SetGitHubSecretOptions
 *
 * Init command option bag.
 * @typedef {{
 *   projectRoot?: string,
 *   repo?: string,
 *   siteId?: string,
 *   siteName?: string,
 *   create?: boolean,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   skipSecrets?: boolean,
 *   githubActions?: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} InitOptions
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {InitRunOptions} param2
 */
function run(command, args, { cwd, input, env = process.env, allowFailure = false, stdio } = {}) {
  const spawnOptions = {
    cwd,
    env,
  }
  if (stdio) {
    spawnOptions.stdio = stdio
  } else {
    spawnOptions.input = input
    spawnOptions.encoding = 'utf8'
    spawnOptions.timeout = 30000
  }

  const result = spawnSync(command, args, spawnOptions)
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').toString().trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return {
    status: result.status,
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
    error: result.error || null,
    signal: result.signal || null,
  }
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
    return JSON.parse(String(result.stdout || ''))
  } catch {
    return null
  }
}

function siteIdFromStatus(status) {
  return status?.siteData?.['site-id'] || status?.siteData?.siteId || ''
}

function netlifyProjectFromStatus(status) {
  const siteData = status?.siteData || {}
  const account = status?.account || {}
  const siteId = siteData['site-id'] || siteData.siteId || ''
  return {
    siteId,
    siteName: siteData['site-name'] || siteData.siteName || '',
    siteUrl: siteData['site-url'] || siteData.siteUrl || '',
    adminUrl: siteData['admin-url'] || siteData.adminUrl || '',
    accountName: account.Name || account.name || '',
    accountEmail: account.Email || account.email || '',
    accountTeams: Array.isArray(account.Teams) ? account.Teams : (Array.isArray(account.teams) ? account.teams : []),
  }
}

function readNetlifyProject(projectRoot, env = process.env) {
  const status = readNetlifyStatus(projectRoot)
  const project = status ? netlifyProjectFromStatus(status) : {}
  const siteId = project.siteId || env.NETLIFY_SITE_ID || ''
  return siteId ? { ...project, siteId } : null
}

/** @param {{ projectRoot?: string, repo?: string }} param0 */
function resolveGitHubRepo({ projectRoot, repo }) {
  if (repo) return repo
  const result = runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: projectRoot,
    errorPrefix: 'Could not resolve GitHub repo with gh. Pass --repo owner/name.',
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

/** @param {{ env?: NodeJS.ProcessEnv, home?: string }} param0 */
function readNetlifyCliToken({ env = process.env, home = os.homedir() } = {}) {
  if (env.NETLIFY_AUTH_TOKEN) {
    return { token: env.NETLIFY_AUTH_TOKEN, source: 'NETLIFY_AUTH_TOKEN' }
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const candidates = [
    path.join(home, 'Library', 'Preferences', 'netlify', 'config.json'),
    path.join(xdgConfigHome, 'netlify', 'config.json'),
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

function findExistingAgentRunnerWorkflow(projectRoot) {
  const workflowsDir = path.join(projectRoot, WORKFLOWS_DIR)
  if (!fs.existsSync(workflowsDir)) return null

  let entries
  try {
    entries = fs.readdirSync(workflowsDir)
  } catch {
    return null
  }

  for (const entry of entries.sort()) {
    if (!/\.ya?ml$/i.test(entry)) continue
    const filePath = path.join(workflowsDir, entry)
    let content
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    if (content.includes(AGENT_RUNNER_MARKER)) {
      return { path: filePath }
    }
  }

  return null
}

/** @param {{ projectRoot?: string, force?: boolean, dryRun?: boolean }} param0 */
function ensureWorkflow({ projectRoot, force = false, dryRun = false } = {}) {
  const detected = findExistingAgentRunnerWorkflow(projectRoot)
  if (detected) {
    return { path: detected.path, status: 'exists' }
  }

  const workflowPath = path.join(projectRoot, WORKFLOW_PATH)
  const exists = fs.existsSync(workflowPath)
  if (exists && !force) {
    throw new Error(`${WORKFLOW_PATH} already exists and does not use netlify-labs/agent-runner-action. Re-run with --force to replace it.`)
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
    fs.writeFileSync(workflowPath, loadWorkflowTemplate())
  }

  return { path: workflowPath, status: exists ? 'replaced' : 'created' }
}

/** @param {{ projectRoot?: string, dryRun?: boolean }} param0 */
function ensureNaxGitignore({ projectRoot, dryRun = false } = {}) {
  const gitignorePath = path.join(projectRoot, '.gitignore')
  const entryPattern = /^\.nax\/?$/m
  const exists = fs.existsSync(gitignorePath)
  const current = exists ? fs.readFileSync(gitignorePath, 'utf8') : ''
  if (entryPattern.test(current)) {
    return { path: gitignorePath, status: 'exists' }
  }

  if (!dryRun) {
    const next = exists && current.trim()
      ? `${current.replace(/\s*$/, '\n\n')}# Added by nax init\n.nax/\n`
      : '.nax/\n'
    fs.writeFileSync(gitignorePath, next)
  }

  return { path: gitignorePath, status: exists ? 'updated' : 'created' }
}

function parseCreatedSiteId(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    return parsed.id || parsed.site_id || parsed.siteId || ''
  } catch {
    return ''
  }
}

function defaultInitNotice(projectRoot) {
  console.log(`No netlify project detected in ${projectRoot}\n`)
}

/** @param {EnsureNetlifyProjectOptions} param0 */
function ensureNetlifyProject({ projectRoot, repo, siteId, siteName, create = false, dryRun = false, env = process.env, runCommand = run, readProject = readNetlifyProject, initNotice = defaultInitNotice } = {}) {
  const linked = dryRun ? null : readProject(projectRoot, env)
  if (linked?.siteId) {
    return { ...linked, status: 'exists' }
  }

  if (siteId) {
    if (!dryRun) runCommand('netlify', ['link', '--id', siteId], { cwd: projectRoot })
    const linkedProject = dryRun ? null : readProject(projectRoot, env)
    return { ...(linkedProject || { siteId }), status: dryRun ? 'would-link' : 'linked' }
  }

  if (siteName && !create) {
    if (!dryRun) runCommand('netlify', ['link', '--name', siteName], { cwd: projectRoot })
    const linkedProject = dryRun ? null : readProject(projectRoot, env)
    return { ...(linkedProject || { siteId: '', siteName }), status: dryRun ? 'would-link' : 'linked' }
  }

  if (create) {
    const name = siteName || defaultSiteName(projectRoot, repo)
    if (dryRun) return { siteId: '', status: 'would-create', siteName: name }
    const result = runCommand('netlify', ['sites:create', '--name', name, '--json'], { cwd: projectRoot })
    const createdProject = readProject(projectRoot, env)
    const createdSiteId = parseCreatedSiteId(result.stdout) || createdProject?.siteId
    if (!createdSiteId) throw new Error('Netlify project was created or linked, but no site ID could be resolved.')
    return { ...(createdProject || { siteId: createdSiteId, siteName: name }), status: 'created' }
  }

  if (!dryRun) {
    initNotice(projectRoot)
    runCommand('netlify', ['init'], { cwd: projectRoot, stdio: 'inherit' })
    const initializedProject = readProject(projectRoot, env)
    if (!initializedProject?.siteId) throw new Error('Netlify init completed, but no site ID could be resolved.')
    return { ...initializedProject, status: 'initialized' }
  }

  return { siteId: '', status: 'would-init' }
}

/** @param {ListGitHubSecretNamesOptions} param0 */
function listGitHubSecretNames({ projectRoot, repo, runCommand } = {}) {
  const result = runGh(['secret', 'list', '--repo', repo, '--json', 'name'], {
    cwd: projectRoot,
    runCommand,
    errorPrefix: `gh secret list --repo ${repo} failed`,
  })
  try {
    const secrets = JSON.parse(result.stdout || '[]')
    return new Set(secrets.map((secret) => secret.name).filter(Boolean))
  } catch (error) {
    throw new Error(`gh secret list --repo ${repo} failed: ${error.message}`)
  }
}

/** @param {SetGitHubSecretOptions} param0 */
function setGitHubSecret({ projectRoot, repo, name, value, dryRun = false, existingSecrets, runCommand }) {
  if (!value) throw new Error(`Cannot set ${name}: missing value.`)
  if (dryRun) return { name, status: 'would-set' }

  const knownSecrets = existingSecrets || listGitHubSecretNames({ projectRoot, repo, runCommand })
  if (knownSecrets.has(name)) return { name, status: 'exists' }

  runGh(['secret', 'set', name, '--repo', repo], {
    cwd: projectRoot,
    input: value,
    runCommand,
    errorPrefix: `gh secret set ${name} --repo ${repo} failed`,
  })
  knownSecrets.add(name)
  return { name, status: 'set' }
}

function skippedGitHubSecrets(reason) {
  return [
    { name: 'NETLIFY_SITE_ID', status: 'skipped', reason },
    { name: 'NETLIFY_AUTH_TOKEN', status: 'skipped', reason },
  ]
}

function assertGitRepository(root) {
  if (fs.existsSync(path.join(root, '.git'))) return
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd: root, allowFailure: true })
  if (result.status !== 0) throw new Error(`Not inside a git repository: ${root}`)
}

/** @param {InitOptions} param0 */
function initSite({
  projectRoot = process.cwd(),
  repo,
  siteId,
  siteName,
  create = false,
  dryRun = false,
  env = process.env,
} = {}) {
  const root = path.resolve(projectRoot)
  assertGitRepository(root)
  if (!dryRun && !commandExists('netlify')) throw new Error('Netlify CLI is required. Install it and authenticate with netlify login.')

  const netlify = ensureNetlifyProject({
    projectRoot: root,
    repo,
    siteId,
    siteName,
    create,
    dryRun,
    env,
  })
  if (!dryRun) ensureNaxGitignore({ projectRoot: root })

  return {
    projectRoot: root,
    repo: repo || '',
    netlify,
    githubActions: false,
    workflow: null,
    secrets: [],
  }
}

/**
 * GitHub Actions setup options for nax init.
 * @typedef {InitOptions & {
 *   netlify?: NetlifyProjectInfo,
 *   hasGitHubCli?: () => boolean,
 *   checkGitHubAuth?: (input: { cwd?: string }) => void,
 * }} EnableGitHubActionsSetupOptions
 */

/** @param {EnableGitHubActionsSetupOptions} param0 */
function enableGitHubActionsSetup({
  projectRoot,
  repo,
  netlify,
  siteId,
  force = false,
  dryRun = false,
  skipSecrets = false,
  env = process.env,
  hasGitHubCli = () => commandExists('gh'),
  checkGitHubAuth = assertGhAuthenticated,
} = {}) {
  const root = path.resolve(projectRoot || process.cwd())
  assertGitRepository(root)
  const workflow = ensureWorkflow({ projectRoot: root, force, dryRun })
  let resolvedRepo = repo || ''
  const secrets = []

  if (!skipSecrets) {
    if (dryRun) {
      // Dry-run only previews which secrets would be set; setGitHubSecret ignores
      // the value under dryRun, so no Netlify auth token is required to preview.
      const token = readNetlifyCliToken({ env })
      const effectiveSiteId = netlify.siteId || siteId || ((netlify.status === 'would-create' || netlify.status === 'would-link' || netlify.status === 'would-init') ? '<netlify-site-id>' : '')
      if (!effectiveSiteId) {
        throw new Error('Could not resolve NETLIFY_SITE_ID. Link/create a Netlify project first, or pass --site-id.')
      }
      resolvedRepo = repo || '<github-repo>'
      secrets.push(setGitHubSecret({ projectRoot: root, repo: resolvedRepo, name: 'NETLIFY_SITE_ID', value: effectiveSiteId, dryRun }))
      secrets.push(setGitHubSecret({ projectRoot: root, repo: resolvedRepo, name: 'NETLIFY_AUTH_TOKEN', value: token.token || '<netlify-auth-token>', dryRun }))
    } else if (!hasGitHubCli()) {
      secrets.push(...skippedGitHubSecrets('GitHub CLI is required. Install gh and authenticate with gh auth login.'))
      return {
        projectRoot: root,
        repo: resolvedRepo,
        netlify,
        githubActions: true,
        workflow,
        secrets,
      }
    }

    if (!dryRun) {
      try {
        checkGitHubAuth({ cwd: root })
        resolvedRepo = resolveGitHubRepo({ projectRoot: root, repo })
      } catch (error) {
        secrets.push(...skippedGitHubSecrets(error.message))
        return {
          projectRoot: root,
          repo: resolvedRepo,
          netlify,
          githubActions: true,
          workflow,
          secrets,
        }
      }
    }

    if (!dryRun) {
      const existingSecrets = listGitHubSecretNames({ projectRoot: root, repo: resolvedRepo })
      const token = readNetlifyCliToken({ env })
      if (!token.token) {
        throw new Error('Could not find a Netlify auth token. Run netlify login or set NETLIFY_AUTH_TOKEN before running nax init.')
      }
      const effectiveSiteId = netlify.siteId || siteId || ''
      if (!effectiveSiteId) {
        throw new Error('Could not resolve NETLIFY_SITE_ID. Link/create a Netlify project first, or pass --site-id.')
      }
      secrets.push(setGitHubSecret({ projectRoot: root, repo: resolvedRepo, name: 'NETLIFY_SITE_ID', value: effectiveSiteId, existingSecrets }))
      secrets.push(setGitHubSecret({ projectRoot: root, repo: resolvedRepo, name: 'NETLIFY_AUTH_TOKEN', value: token.token, existingSecrets }))
    }
  } else if (repo) {
    resolvedRepo = repo
  }

  return {
    projectRoot: root,
    repo: resolvedRepo,
    netlify,
    githubActions: true,
    workflow,
    secrets,
  }
}

/** @param {InitOptions} param0 */
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
  env = process.env,
} = {}) {
  const site = initSite({ projectRoot, repo, siteId, siteName, create, dryRun, env })
  if (!githubActions) return site
  return enableGitHubActionsSetup({
    projectRoot: site.projectRoot,
    repo,
    netlify: site.netlify,
    siteId,
    force,
    dryRun,
    skipSecrets,
    env,
  })
}

module.exports = {
  WORKFLOW_PATH,
  defaultSiteName,
  enableGitHubActionsSetup,
  ensureNaxGitignore,
  ensureNetlifyProject,
  ensureWorkflow,
  findExistingAgentRunnerWorkflow,
  initSite,
  initProject,
  listGitHubSecretNames,
  readLinkedSiteId,
  readNetlifyCliToken,
  readNetlifyProject,
  resolveGitHubRepo,
  setGitHubSecret,
  siteIdFromStatus,
}
