const { spawnSync } = require('child_process')

/**
 * @typedef {{ status: number | null, stdout: string }} GitCommandResult
 * @typedef {(args: string[], options: { cwd: string }) => GitCommandResult} GitRunner
 */

/**
 * Runs a read-only Git command for the branch picker.
 * @param {string[]} args
 * @param {{ cwd: string }} options
 * @returns {GitCommandResult}
 */
function runGit(args, options) {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: String(result.stdout || '').trim(),
  }
}

/**
 * Removes Git's ref namespace and remote name so values remain valid branch selectors.
 * @param {string} ref
 * @returns {string}
 */
function branchNameFromRef(ref) {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length)
  if (!ref.startsWith('refs/remotes/')) return ''
  const parts = ref.split('/')
  const branch = parts.slice(3).join('/')
  return branch === 'HEAD' ? '' : branch
}

/**
 * Lists the current branch, local branches, and locally known remote branches without fetching.
 * @param {string} projectRoot
 * @param {{ run?: GitRunner }} [options]
 * @returns {{ currentBranch: string, branches: string[] }}
 */
function listKnownGitBranches(projectRoot, { run = runGit } = {}) {
  const currentResult = run(['branch', '--show-current'], { cwd: projectRoot })
  const currentBranch = currentResult.status === 0 ? currentResult.stdout.trim() : ''
  const refsResult = run([
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ], { cwd: projectRoot })
  const refs = refsResult.status === 0 ? refsResult.stdout.split(/\r?\n/) : []
  const branches = [
    currentBranch,
    ...refs.map(branchNameFromRef),
  ].map((branch) => branch.trim()).filter(Boolean)
  return {
    currentBranch,
    branches: [...new Set(branches)],
  }
}

module.exports = {
  branchNameFromRef,
  listKnownGitBranches,
}
