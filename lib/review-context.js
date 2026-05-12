const path = require('path')
const { spawnSync } = require('child_process')

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd,
  })

  const stdout = (result.stdout || '').trim()
  const stderr = (result.stderr || '').trim()
  return {
    status: result.status,
    stdout,
    stderr,
    detail: stderr || stdout,
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

function formatReviewContract({ pinnedSha }) {
  return [
    '## Review Contract',
    '',
    '- Mode: `review-only`',
    '- Do not edit files, do not stage files, do not commit, do not open or update PRs, and do not claim any fix was applied.',
    '- If you accidentally changed files while investigating, revert those changes before finishing and ensure `git status --short` is clean.',
    `- Pinned commit SHA: \`${pinnedSha}\``,
    '- If the checked-out `git rev-parse HEAD` is not exactly the pinned SHA, stop and report a repository-state mismatch instead of reviewing a different tree.',
    '- Treat any open PR as merge-dependent context, not as already merged code, unless the pinned SHA actually contains it.',
  ].join('\n')
}

function formatRepositorySnapshot({ repoRoot, branch, pinnedSha, generatedAt }) {
  return [
    '## Repository Snapshot',
    '',
    `- Branch at prompt generation time: \`${branch}\``,
    `- Pinned commit SHA: \`${pinnedSha}\``,
    `- Prompt generated at: \`${generatedAt}\``,
  ].join('\n')
}

function containsCommit(repoRoot, ancestorSha, descendantSha) {
  const objectExists = runCommand('git', ['cat-file', '-e', `${ancestorSha}^{commit}`], { cwd: repoRoot })
  if (objectExists.status !== 0) return 'unknown'

  const result = runCommand('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], { cwd: repoRoot })
  if (result.status === 0) return 'yes'
  if (result.status === 1) return 'no'
  return 'unknown'
}

function loadOpenPullRequests({ repo, limit = 10 }) {
  const result = runCommand(
    'gh',
    [
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
    ],
  )

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

function buildAutomaticContext({
  repo,
  repoRoot: explicitRepoRoot,
  sha,
  generatedAt = new Date().toISOString(),
  prLimit = 10,
}) {
  const repoRoot = resolveRepoRoot(explicitRepoRoot)
  const pinnedSha = resolvePinnedSha({ repoRoot, sha })
  const branch = resolveCurrentBranch(repoRoot)
  const { pullRequests, error } = loadOpenPullRequests({ repo, limit: prLimit })

  return [
    formatReviewContract({ pinnedSha }),
    '',
    formatRepositorySnapshot({
      repoRoot,
      branch,
      pinnedSha,
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

module.exports = {
  buildAutomaticContext,
  containsCommit,
  formatMergeStateLedger,
  formatRepositorySnapshot,
  formatReviewContract,
  formatWorkingTreeSummary,
  loadOpenPullRequests,
  readWorkingTreeStatus,
  resolveCurrentBranch,
  resolvePinnedSha,
  resolveRepoRoot,
  runCommand,
}
