const path = require('path')
const { spawnSync } = require('child_process')
const { runGh } = require('./gh-cli')

/**
 * @typedef {{ branch?: string, ref?: string, sha?: string | null, sourceType?: string, verified?: boolean, caveats?: string[] }} TargetSnapshot
 */

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd,
  })

  const stdout = (result.stdout || '').trim()
  const stderr = (result.stderr || '').trim()
  const error = (result.error?.message || '').trim()
  return {
    status: result.status,
    stdout,
    stderr,
    detail: stderr || stdout || error,
  }
}

function requireCommand(command, args, options = {}) {
  const result = runCommand(command, args, options)
  if (result.status !== 0) {
    throw new Error(options.errorMessage || `${command} ${args.join(' ')} failed: ${result.detail}`.trim())
  }
  return result.stdout
}

function resolveRepoRoot(explicitRepoRoot) {
  if (explicitRepoRoot) return path.resolve(explicitRepoRoot)
  return requireCommand(
    'git',
    ['rev-parse', '--show-toplevel'],
    {
      errorMessage:
        'Could not resolve the git repo root. Run nax inside the target repository or pass --repo-root.',
    },
  )
}

/** @param {Record<string, any>} param0 */
function resolvePinnedSha({ repoRoot, sha }) {
  const rev = sha || 'HEAD'
  return requireCommand(
    'git',
    ['rev-parse', rev],
    {
      cwd: repoRoot,
      errorMessage:
        `Could not resolve pinned SHA from "${rev}". Pass --sha <rev> with a valid commit or run inside a git repo.`,
    },
  )
}

function resolveCurrentBranch(repoRoot) {
  return requireCommand(
    'git',
    ['branch', '--show-current'],
    {
      cwd: repoRoot,
      errorMessage: 'Could not resolve the current branch for the repository snapshot.',
    },
  )
}

function readWorkingTreeStatus(repoRoot) {
  const result = requireCommand(
    'git',
    ['status', '--short'],
    {
      cwd: repoRoot,
      errorMessage: 'Could not read git status for the repository snapshot.',
    },
  )

  return result
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

function formatWorkingTreeSummary(lines) {
  if (lines.length === 0) return 'clean'
  const preview = lines.slice(0, 8).map((line) => `  - \`${line}\``)
  const remainder = lines.length - preview.length
  if (remainder > 0) preview.push(`  - ... plus ${remainder} more`)
  return `dirty\n${preview.join('\n')}`
}

/** @param {Record<string, any>} param0 */
function formatReviewContract({ pinnedSha }) {
  return [
    '## Review Contract',
    '',
    '- Mode: `review-only`',
    '- Do not edit files, do not stage files, do not commit, do not open or update PRs, and do not claim any fix was applied.',
    '- If you accidentally changed files while investigating, revert those changes before finishing and ensure `git status --short` is clean.',
    `- Pinned commit SHA: \`${pinnedSha}\``,
    '- If checked-out `git rev-parse HEAD` is not the pinned SHA, evaluate repository drift before deciding whether to stop.',
    '- Continue when the checked-out SHA is a fast-forward descendant of the pinned SHA by 1-5 commits and the diff is not obviously huge.',
    '- Stop for divergent history, missing pinned commit, more than 5 commits of drift, or a very large diff that would make the pinned review context unreliable.',
    '- Treat any open PR as merge-dependent context, not as already merged code, unless the pinned SHA actually contains it.',
  ].join('\n')
}

/** @param {string[]} [caveats] */
function formatTargetCaveats(caveats = []) {
  return caveats.length > 0 ? caveats.map((caveat) => `\`${caveat}\``).join(', ') : ''
}

/** @param {{ target?: TargetSnapshot }} param0 */
function formatUnverifiedTargetContract({ target = {} }) {
  const lines = [
    '## Target Contract',
    '',
    `- Target branch: \`${target.branch || 'unknown'}\``,
    `- Target source: \`${target.sourceType || 'unknown'}\``,
    '- Target verification: unverified',
  ]
  if (target.ref) lines.push(`- Target ref: \`${target.ref}\``)
  const caveats = formatTargetCaveats(target.caveats || [])
  if (caveats) lines.push(`- Caveats: ${caveats}`)
  if ((target.caveats || []).includes('gha-implicit')) {
    lines.push('- GitHub Actions checkout is implicit; nax records this advisory target but cannot prove the exact checkout from this repo alone.')
  }
  return lines.join('\n')
}

/** @param {Record<string, any>} param0 */
function formatRepositorySnapshot({ repoRoot, branch, pinnedSha, pinnedSource, generatedAt, target }) {
  const lines = [
    '## Repository Snapshot',
    '',
    `- Branch at prompt generation time: \`${branch}\``,
  ]
  if (pinnedSha) {
    lines.push(`- Pinned commit SHA: \`${pinnedSha}\``)
  } else {
    lines.push('- Pinned commit SHA: unverified')
  }
  if (pinnedSource) lines.push(`- Pinned source: \`${pinnedSource}\``)
  if (target) {
    lines.push(`- Target source type: \`${target.sourceType || 'unknown'}\``)
    lines.push(`- Target verified: ${target.verified === true ? 'yes' : 'no'}`)
    const caveats = formatTargetCaveats(target.caveats || [])
    if (caveats) lines.push(`- Target caveats: ${caveats}`)
  }
  lines.push(`- Prompt generated at: \`${generatedAt}\``)
  return lines.join('\n')
}

function containsCommit(repoRoot, ancestorSha, descendantSha) {
  const objectExists = runCommand('git', ['cat-file', '-e', `${ancestorSha}^{commit}`], { cwd: repoRoot })
  if (objectExists.status !== 0) return 'unknown'

  const result = runCommand('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], { cwd: repoRoot })
  if (result.status === 0) return 'yes'
  if (result.status === 1) return 'no'
  return 'unknown'
}

/** @param {Record<string, any>} param0 */
function loadOpenPullRequests({ repo, limit = 10 }) {
  const result = runGh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    'number,title,url,headRefName,headRefOid,baseRefName,isDraft,mergeStateStatus',
  ], {
    allowFailure: true,
  })

  if (result.status !== 0) {
    return {
      pullRequests: null,
      error: result.detail || 'Unknown gh error while loading open PRs',
    }
  }

  try {
    const pullRequests = JSON.parse(result.stdout || '[]')
    return { pullRequests, error: '' }
  } catch (error) {
    return {
      pullRequests: null,
      error: `Could not parse open PR ledger JSON: ${error.message}`,
    }
  }
}

/** @param {Record<string, any>} param0 */
function formatMergeStateLedger({ repoRoot, pinnedSha, pullRequests, error }) {
  if (error) {
    return [
      '## Merge-State Ledger',
      '',
      `- Open PR ledger unavailable: ${error}`,
    ].join('\n')
  }

  if (!pullRequests || pullRequests.length === 0) {
    return [
      '## Merge-State Ledger',
      '',
      '- No open pull requests were reported by GitHub when this prompt was generated.',
    ].join('\n')
  }

  const lines = [
    '## Merge-State Ledger',
    '',
    '| PR | Base | Head | Merge State | Draft | Head In Pinned SHA? |',
    '| --- | --- | --- | --- | --- | --- |',
  ]

  for (const pr of pullRequests) {
    const contains = pr.headRefOid
      ? containsCommit(repoRoot, pr.headRefOid, pinnedSha)
      : 'unknown'
    lines.push(
      `| [#${pr.number}](${pr.url}) | \`${pr.baseRefName}\` | \`${pr.headRefName}\` | \`${pr.mergeStateStatus || 'UNKNOWN'}\` | ${pr.isDraft ? 'yes' : 'no'} | ${contains} |`,
    )
  }

  lines.push(
    '',
    '- `Head In Pinned SHA?` is computed locally against the pinned commit. `no` means the PR head is not contained in the reviewed tree. `unknown` means the commit object was not available locally.',
  )

  return lines.join('\n')
}

/** @param {Record<string, any>} param0 */
function buildAutomaticContext({
  repo,
  repoRoot: explicitRepoRoot,
  sha,
  pinnedSha: explicitPinnedSha,
  pinnedSource,
  target,
  generatedAt = new Date().toISOString(),
  prLimit = 10,
}) {
  const repoRoot = resolveRepoRoot(explicitRepoRoot)
  const targetSha = target?.verified === true ? target.sha : ''
  const pinnedSha = explicitPinnedSha || targetSha || (target && !sha ? '' : resolvePinnedSha({ repoRoot, sha }))
  const branch = target?.branch || resolveCurrentBranch(repoRoot)
  const { pullRequests, error } = loadOpenPullRequests({ repo, limit: prLimit })

  return [
    pinnedSha ? formatReviewContract({ pinnedSha }) : formatUnverifiedTargetContract({ target }),
    '',
    formatRepositorySnapshot({
      repoRoot,
      branch,
      pinnedSha,
      pinnedSource: pinnedSource || target?.ref || '',
      target,
      generatedAt,
    }),
    '',
    formatMergeStateLedger({
      repoRoot,
      pinnedSha,
      pullRequests,
      error,
    }),
  ].join('\n')
}

function parseRemoteBranchTarget(upstream, fallbackBranch) {
  if (!upstream || !upstream.includes('/')) {
    return { remote: 'origin', branch: fallbackBranch }
  }
  const [remote, ...branchParts] = upstream.split('/')
  return { remote, branch: branchParts.join('/') }
}

function isSafeGitRefName(value) {
  const ref = String(value || '').trim()
  if (!ref) return false
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) return false
  if (/[\s~^:?*[\]\\\x00-\x1f\x7f]/.test(ref)) return false
  if (ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) return false
  return /^[A-Za-z0-9._/-]+$/.test(ref)
}

function isSafeGitRemoteName(value) {
  const remote = String(value || '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) && !remote.startsWith('-')
}

function validateGitRefName(value, label = 'branch') {
  const ref = String(value || '').trim()
  if (!isSafeGitRefName(ref)) {
    throw new Error(`Invalid ${label} "${ref || '(empty)'}". Use a plain git ref name without leading dashes, whitespace, or metacharacters.`)
  }
  return ref
}

function validateGitRemoteName(value) {
  const remote = String(value || '').trim()
  if (!isSafeGitRemoteName(remote)) {
    throw new Error(`Invalid git remote "${remote || '(empty)'}".`)
  }
  return remote
}

/** @param {Record<string, any>} param0 */
function resolveRemoteBranchSha({ repoRoot: explicitRepoRoot, branch, run = runCommand } = {}) {
  const repoRoot = resolveRepoRoot(explicitRepoRoot)
  const hasExplicitBranch = Boolean(branch)
  let currentBranch = branch
  if (!currentBranch) {
    const branchResult = run('git', ['branch', '--show-current'], { cwd: repoRoot })
    currentBranch = (branchResult.stdout || '').trim()
    if (branchResult.status !== 0 || !currentBranch) {
      throw new Error('Could not resolve the current branch for the repository snapshot.')
    }
  }
  const upstream = hasExplicitBranch
    ? { status: 1, stdout: '' }
    : run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: repoRoot })
  const target = upstream.status === 0
    ? parseRemoteBranchTarget(upstream.stdout, currentBranch)
    : { remote: 'origin', branch: currentBranch }
  target.remote = validateGitRemoteName(target.remote)
  target.branch = validateGitRefName(target.branch)
  const result = run('git', ['ls-remote', '--heads', target.remote, target.branch], { cwd: repoRoot })
  const firstLine = (result.stdout || '').split('\n').find(Boolean) || ''
  const sha = firstLine.split(/\s+/)[0] || ''

  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(
      `Could not resolve remote SHA for ${target.remote}/${target.branch}. ` +
      'Push the branch or configure an upstream before running a Netlify agent workflow.',
    )
  }

  return {
    sha,
    remote: target.remote,
    branch: target.branch,
    ref: `${target.remote}/${target.branch}`,
  }
}

module.exports = {
  buildAutomaticContext,
  containsCommit,
  formatMergeStateLedger,
  formatRepositorySnapshot,
  formatReviewContract,
  formatUnverifiedTargetContract,
  formatWorkingTreeSummary,
  isSafeGitRefName,
  loadOpenPullRequests,
  readWorkingTreeStatus,
  resolveCurrentBranch,
  resolvePinnedSha,
  resolveRepoRoot,
  resolveRemoteBranchSha,
  runCommand,
  validateGitRefName,
}
