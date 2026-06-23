const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  legacyTargetFromRunState,
  resolveTarget,
  targetBranch,
} = require('../../src/integrations/git/target')

/** @type {Set<string>} */
const tempRepos = new Set()

test.afterEach(() => {
  for (const repo of tempRepos) {
    fs.rmSync(repo, { recursive: true, force: true })
    tempRepos.delete(repo)
  }
})

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function createInitialCommit(cwd) {
  const emptyTree = git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])
  const commit = git(cwd, ['commit-tree', emptyTree, '-m', 'initial'])
  git(cwd, ['update-ref', 'refs/heads/main', commit])
  return commit
}

/**
 * @returns {string}
 */
function makeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-target-'))
  tempRepos.add(tmp)
  git(tmp, ['init', '-b', 'main'])
  git(tmp, ['config', 'user.email', 'test@example.com'])
  git(tmp, ['config', 'user.name', 'Test User'])
  createInitialCommit(tmp)
  return tmp
}

/**
 * @param {Record<string, string>} branches
 * @returns {(input: { repoRoot?: string, branch?: string }) => { sha: string, remote: string, branch: string, ref: string }}
 */
function remoteResolverFor(branches) {
  return ({ branch }) => {
    const sha = branches[branch]
    if (!sha) throw new Error(`Could not resolve remote SHA for origin/${branch}.`)
    return { sha, remote: 'origin', branch, ref: `origin/${branch}` }
  }
}

test('resolveTarget verifies the current branch for netlify-api', () => {
  const repo = makeRepo()
  const sha = git(repo, ['rev-parse', 'HEAD'])

  const target = resolveTarget({
    projectRoot: repo,
    transport: 'netlify-api',
    remoteResolver: remoteResolverFor({ main: sha }),
  })

  assert.deepEqual(target, {
    branch: 'main',
    ref: 'origin/main',
    sha,
    sourceType: 'current-branch',
    verified: true,
    caveats: [],
  })
})

test('resolveTarget verifies explicit branches for netlify-api', () => {
  const repo = makeRepo()
  const sha = git(repo, ['rev-parse', 'HEAD'])

  const target = resolveTarget({
    projectRoot: repo,
    transport: 'netlify-api',
    options: { branch: 'release' },
    remoteResolver: remoteResolverFor({ release: sha }),
  })

  assert.equal(target.branch, 'release')
  assert.equal(target.ref, 'origin/release')
  assert.equal(target.sourceType, 'explicit-branch')
  assert.equal(target.verified, true)
})

test('resolveTarget fails closed for unpushed netlify-api branches', () => {
  const repo = makeRepo()

  assert.throws(
    () => resolveTarget({
      projectRoot: repo,
      transport: 'netlify-api',
      options: { branch: 'unpushed' },
      remoteResolver: remoteResolverFor({}),
    }),
    /Could not prove target branch "unpushed"/,
  )
})

test('resolveTarget requires an explicit branch for detached netlify-api HEAD', () => {
  const repo = makeRepo()
  const sha = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['checkout', '--detach', sha])

  assert.throws(
    () => resolveTarget({
      projectRoot: repo,
      transport: 'netlify-api',
      remoteResolver: remoteResolverFor({}),
    }),
    /Could not resolve a branch target/,
  )
})

test('resolveTarget records GitHub transport as implicit and unverified', () => {
  const repo = makeRepo()

  const target = resolveTarget({
    projectRoot: repo,
    transport: 'github',
  })

  assert.equal(target.branch, 'main')
  assert.equal(target.sha, null)
  assert.equal(target.sourceType, 'github-actions-implicit')
  assert.equal(target.verified, false)
  assert.ok(target.caveats.includes('gha-implicit'))
  assert.ok(target.caveats.includes('current-branch'))
})

test('resolveTarget resolves PR selectors through injectable gh seam', () => {
  const repo = makeRepo()
  const sha = '1234567890abcdef1234567890abcdef12345678'

  const target = resolveTarget({
    projectRoot: repo,
    transport: 'netlify-api',
    options: { branch: '#42', repo: 'owner/repo' },
    repoResolver: () => 'owner/repo',
    prResolver: () => ({ branch: 'feature/pr', sha, fork: false }),
    remoteResolver: remoteResolverFor({ 'feature/pr': sha }),
  })

  assert.equal(target.branch, 'feature/pr')
  assert.equal(target.sourceType, 'pull-request')
  assert.equal(target.verified, true)
})

test('resolveTarget rejects unsafe explicit and PR branch names', () => {
  const repo = makeRepo()

  assert.throws(
    () => resolveTarget({
      projectRoot: repo,
      transport: 'netlify-api',
      options: { branch: '--upload-pack=bad' },
      remoteResolver: remoteResolverFor({}),
    }),
    /Invalid branch/,
  )

  assert.throws(
    () => resolveTarget({
      projectRoot: repo,
      transport: 'netlify-api',
      options: { branch: '#42', repo: 'owner/repo' },
      repoResolver: () => 'owner/repo',
      prResolver: () => ({ branch: 'feature with spaces', sha: '1234567890abcdef1234567890abcdef12345678', fork: false }),
      remoteResolver: remoteResolverFor({}),
    }),
    /Invalid branch/,
  )
})

test('resolveTarget records fork PR caveat for GitHub implicit targets', () => {
  const repo = makeRepo()

  const target = resolveTarget({
    projectRoot: repo,
    transport: 'github',
    options: { branch: '42', repo: 'owner/repo' },
    repoResolver: () => 'owner/repo',
    prResolver: () => ({ branch: 'fork/topic', sha: '1234567890abcdef1234567890abcdef12345678', fork: true }),
  })

  assert.equal(target.sourceType, 'github-actions-implicit')
  assert.equal(target.verified, false)
  assert.equal(target.sha, null)
  assert.ok(target.caveats.includes('fork-pr'))
})

test('resolveTarget dry-run records advisory target without remote proof', () => {
  const repo = makeRepo()

  const target = resolveTarget({
    projectRoot: repo,
    transport: 'netlify-api',
    options: { dryRun: true },
  })

  assert.equal(target.branch, 'main')
  assert.equal(target.sourceType, 'dry-run')
  assert.equal(target.verified, false)
  assert.equal(target.sha, null)
})

test('legacyTargetFromRunState exposes compatibility target for old workflow state', () => {
  const target = legacyTargetFromRunState({
    runId: 'old',
    branch: 'main',
    branchSource: 'current-branch',
    context: { pinnedSha: 'abc' },
  })

  assert.equal(target.branch, 'main')
  assert.equal(target.sha, 'abc')
  assert.equal(target.verified, false)
  assert.ok(target.caveats.includes('legacy-unverified'))
  assert.equal(targetBranch({ target }, { required: true }), 'main')
})
