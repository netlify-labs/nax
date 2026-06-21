const { spawnSync } = require('child_process')
const { resolveRepo } = require('./prompts')
const { resolveRemoteBranchSha, validateGitRefName } = require('./review-context')

/**
 * @typedef {{ cwd?: string }} CommandOptions
 * @typedef {{ status: number, stdout: string, stderr: string, detail: string }} CommandResult
 * @callback RunCommand
 * @param {string} command
 * @param {string[]} args
 * @param {CommandOptions} [options]
 * @returns {CommandResult}
 * @typedef {{ branch: string, ref: string, sha: string | null, sourceType: string, verified: boolean, caveats: string[] }} Target
 * @typedef {{ branch: string, sha: string | null, fork: boolean }} PullRequestTarget
 * @typedef {{ branch?: string | number, dryRun?: boolean, repo?: string }} TargetOptions
 * @callback RemoteResolver
 * @param {{ repoRoot?: string, branch?: string }} input
 * @returns {{ sha: string, remote?: string, branch?: string, ref?: string }}
 * @callback PrResolver
 * @param {{ selector?: string | number, repo?: string, projectRoot?: string, run?: RunCommand }} input
 * @returns {PullRequestTarget}
 * @callback RepoResolver
 * @param {string | undefined} explicitRepo
 * @returns {string}
 */

/** @param {string} command @param {string[]} args @param {CommandOptions} [options] @returns {CommandResult} */
function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    detail: (result.stderr || result.stdout || result.error?.message || '').trim(),
  }
}

/** @param {string} transport */
function isNetlifyTransport(transport) {
  return transport === 'netlify-api' || transport === 'local'
}

/** @param {string} transport */
function isGithubTransport(transport) {
  return transport === 'github' || transport === 'github-actions'
}

/** @param {string | number | undefined} value */
function isPullRequestSelector(value) {
  return /^#?\d+$/.test(String(value || '').trim())
}

/** @param {Partial<Target>} [target] @returns {Target} */
function normalizeTarget(target = {}) {
  return {
    branch: String(target.branch || ''),
    ref: String(target.ref || ''),
    sha: target.sha || null,
    sourceType: String(target.sourceType || ''),
    verified: target.verified === true,
    caveats: Array.isArray(target.caveats) ? [...new Set(target.caveats.map(String).filter(Boolean))] : [],
  }
}

/** @param {string} projectRoot @param {{ run?: RunCommand }} [options] */
function currentBranch(projectRoot, { run = runCommand } = {}) {
  const result = run('git', ['branch', '--show-current'], { cwd: projectRoot })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

/** @param {string} projectRoot @param {{ run?: RunCommand }} [options] */
function headSha(projectRoot, { run = runCommand } = {}) {
  const result = run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })
  const sha = String(result.stdout || '').trim()
  return result.status === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : null
}

/** @param {{ selector?: string | number, repo?: string, projectRoot?: string, run?: RunCommand }} [options] @returns {PullRequestTarget} */
function resolvePullRequestTarget({ selector, repo, projectRoot, run = runCommand } = {}) {
  const number = String(selector || '').trim().replace(/^#/, '')
  const result = run('gh', [
    'pr',
    'view',
    number,
    '--repo',
    repo,
    '--json',
    'headRefName,headRefOid,isCrossRepository',
  ], { cwd: projectRoot })
  if (result.status !== 0) {
    throw new Error(`Could not resolve PR #${number} target${result.detail ? `: ${result.detail}` : ''}`)
  }
  /** @type {{ headRefName?: string, headRefOid?: string, isCrossRepository?: boolean }} */
  let parsed
  try {
    parsed = JSON.parse(result.stdout || '{}')
  } catch (error) {
    throw new Error(`Could not parse PR #${number} target JSON: ${error.message}`)
  }
  const branch = String(parsed.headRefName || '').trim()
  if (!branch) throw new Error(`Could not resolve PR #${number} branch.`)
  validateGitRefName(branch, `PR #${number} branch`)
  return {
    branch,
    sha: /^[0-9a-f]{40}$/i.test(String(parsed.headRefOid || '')) ? String(parsed.headRefOid) : null,
    fork: parsed.isCrossRepository === true,
  }
}

/** @param {{ branch?: string, sourceType?: string, projectRoot?: string, remoteResolver?: RemoteResolver }} [options] @returns {Target} */
function verifiedRemoteTarget({ branch, sourceType, projectRoot, remoteResolver = resolveRemoteBranchSha } = {}) {
  const safeBranch = validateGitRefName(branch)
  const remote = remoteResolver({ repoRoot: projectRoot, branch: safeBranch })
  return normalizeTarget({
    branch: validateGitRefName(remote.branch || safeBranch),
    ref: remote.ref || `origin/${safeBranch}`,
    sha: remote.sha,
    sourceType,
    verified: true,
    caveats: [],
  })
}

/** @param {{ branch?: string, sourceType?: string, sha?: string | null, fork?: boolean, caveats?: string[] }} [options] @returns {Target} */
function advisoryGithubTarget({ branch, sourceType, sha = null, fork = false, caveats = [] } = {}) {
  return normalizeTarget({
    branch,
    ref: branch ? `github-actions:${branch}` : 'github-actions',
    sha: null,
    sourceType: 'github-actions-implicit',
    verified: false,
    caveats: [
      'gha-implicit',
      ...(sourceType && sourceType !== 'github-actions-implicit' ? [sourceType] : []),
      ...(sha ? ['sha-advisory'] : []),
      ...(fork ? ['fork-pr'] : []),
      ...caveats,
    ],
  })
}

/** @param {{ options?: TargetOptions, projectRoot?: string, transport?: string, run?: RunCommand, remoteResolver?: RemoteResolver, prResolver?: PrResolver, repoResolver?: RepoResolver }} [input] @returns {Target} */
function resolveTarget({
  options = {},
  projectRoot = process.cwd(),
  transport = '',
  run = runCommand,
  remoteResolver = resolveRemoteBranchSha,
  prResolver = resolvePullRequestTarget,
  repoResolver = resolveRepo,
} = {}) {
  const requested = String(options.branch || '').trim()
  const dryRun = options.dryRun === true
  const github = isGithubTransport(transport)
  const netlify = isNetlifyTransport(transport)
  const caveats = []

  if (dryRun) {
    const branch = requested && !isPullRequestSelector(requested)
      ? validateGitRefName(requested)
      : currentBranch(projectRoot, { run }) || requested.replace(/^#/, '') || '(dry run)'
    if (!branch || branch === '(dry run)') caveats.push('dry-run')
    return normalizeTarget({
      branch,
      ref: branch,
      sha: null,
      sourceType: 'dry-run',
      verified: false,
      caveats,
    })
  }

  let branch = requested
  let sourceType = requested ? 'explicit-branch' : 'current-branch'
  let pr = null
  if (requested && isPullRequestSelector(requested)) {
    const repo = repoResolver(options.repo)
    pr = prResolver({ selector: requested, repo, projectRoot, run })
    branch = pr.branch
    sourceType = 'pull-request'
    if (pr.fork) caveats.push('fork-pr')
  } else if (!requested) {
    branch = currentBranch(projectRoot, { run })
    if (!branch) caveats.push('detached-head')
  }

  if (github) {
    if (branch) validateGitRefName(branch)
    return advisoryGithubTarget({
      branch,
      sourceType,
      sha: pr?.sha || headSha(projectRoot, { run }),
      fork: pr?.fork === true,
      caveats,
    })
  }

  if (!branch) {
    throw new Error('Could not resolve a branch target. Pass --branch <name> explicitly.')
  }

  if (!netlify) {
    validateGitRefName(branch)
    return normalizeTarget({
      branch,
      ref: branch,
      sha: pr?.sha || headSha(projectRoot, { run }),
      sourceType,
      verified: false,
      caveats,
    })
  }

  try {
    return verifiedRemoteTarget({
      branch,
      sourceType,
      projectRoot,
      remoteResolver,
    })
  } catch (error) {
    const detail = error?.message || String(error)
    throw new Error(`Could not prove target branch "${branch}" for Netlify agent submission: ${detail}`)
  }
}

/** @param {{ runId?: string, target?: Partial<Target>, branch?: string, branchSource?: string, options?: { branch?: string, branchSource?: string, pinnedSha?: string }, context?: { pinnedSha?: string } }} [runState] @returns {Target | null} */
function legacyTargetFromRunState(runState = {}) {
  if (runState.target) return normalizeTarget(runState.target)
  if (!runState.branch && !runState.options?.branch) return null
  return normalizeTarget({
    branch: runState.branch || runState.options?.branch || '',
    ref: runState.branchSource || runState.options?.branchSource || '',
    sha: runState.context?.pinnedSha || runState.options?.pinnedSha || null,
    sourceType: runState.branchSource || 'legacy',
    verified: false,
    caveats: ['legacy-unverified'],
  })
}

/** @param {{ runId?: string, target?: Partial<Target>, branch?: string, branchSource?: string, options?: { branch?: string, branchSource?: string, pinnedSha?: string }, context?: { pinnedSha?: string } }} [runState] @param {{ required?: boolean }} [options] */
function targetBranch(runState = {}, { required = false } = {}) {
  const target = legacyTargetFromRunState(runState)
  const branch = target?.branch || ''
  if (required && !branch) {
    throw new Error(`Run ${runState.runId || ''} has no recorded target branch; legacy workflow state cannot be safely resumed.`.trim())
  }
  return branch
}

/** @param {Partial<Target>} [target] */
function targetSummary(target = {}) {
  const normalized = normalizeTarget(target)
  const parts = [
    normalized.branch ? `branch ${normalized.branch}` : 'branch unknown',
    normalized.sourceType || 'unknown source',
    normalized.verified ? 'verified' : 'unverified',
  ]
  if (normalized.sha) parts.push(normalized.sha)
  if (normalized.caveats.length > 0) parts.push(`caveats: ${normalized.caveats.join(', ')}`)
  return parts.join('; ')
}

module.exports = {
  advisoryGithubTarget,
  currentBranch,
  headSha,
  isGithubTransport,
  isNetlifyTransport,
  isPullRequestSelector,
  legacyTargetFromRunState,
  normalizeTarget,
  resolvePullRequestTarget,
  resolveTarget,
  targetBranch,
  targetSummary,
}
