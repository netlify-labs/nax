// Local git checks and patch application for nax acp sessions.
// Agent runners work from the pushed branch, so drift between it and the local workspace is reported before a turn.
const fs = require('fs')
const { runCommand } = require('../git/review-context')

/**
 * @typedef {import('../netlify/salvage').GitRunner} GitRunner
 *
 * @typedef {{
 *   branch: string,
 *   headSha: string,
 *   remoteSha: string,
 *   dirty: boolean,
 *   changedFiles: string[],
 * }} WorkspaceState
 *
 * @typedef {{
 *   status: 'applied' | 'conflict',
 *   files: string[],
 *   detail: string,
 * }} PatchApplyResult
 */

/**
 * @param {{ cwd: string, run?: GitRunner }} input
 * @returns {WorkspaceState}
 */
function inspectWorkspace({ cwd, run = runCommand }) {
  const abbrev = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  const branch = abbrev.status === 0 && abbrev.stdout !== 'HEAD' ? abbrev.stdout : ''
  const head = run('git', ['rev-parse', 'HEAD'], { cwd })
  const remote = branch ? run('git', ['ls-remote', '--heads', 'origin', branch], { cwd }) : null
  const changedFiles = listChangedFiles(run, cwd)
  return {
    branch,
    headSha: head.status === 0 ? head.stdout : '',
    remoteSha: remote && remote.status === 0 ? remote.stdout.split(/\s+/)[0] || '' : '',
    dirty: changedFiles.length > 0,
    changedFiles,
  }
}

/**
 * Lists tracked files changed since HEAD plus untracked files, relative to the repository root.
 * @param {GitRunner} run
 * @param {string} cwd
 * @returns {string[]}
 */
function listChangedFiles(run, cwd) {
  /** @param {string[]} args */
  const names = (args) => {
    const result = run('git', ['-c', 'core.quotePath=false', ...args], { cwd })
    return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : []
  }
  const files = new Set([
    ...names(['diff', '--name-only', 'HEAD']),
    ...names(['ls-files', '--others', '--exclude-standard', '--full-name', '--', ':/']),
  ])
  return [...files].sort()
}

/**
 * Explains why the agent runner may not see the same code as the local workspace.
 * @param {WorkspaceState} state
 * @returns {string[]}
 */
function workspaceWarnings(state) {
  /** @type {string[]} */
  const warnings = []
  if (!state.branch) {
    warnings.push('The workspace is on a detached HEAD; the agent runner starts from the site\'s production branch.')
  } else if (!state.remoteSha) {
    warnings.push(`Branch ${state.branch} is not on origin; the agent runner starts from the site's production branch. Push it to work on it remotely.`)
  } else if (state.headSha !== state.remoteSha) {
    warnings.push(`Local HEAD ${state.headSha.slice(0, 12)} differs from origin/${state.branch} ${state.remoteSha.slice(0, 12)}; the agent runner works from origin/${state.branch}, so its changes may not apply cleanly.`)
  }
  if (state.dirty) {
    warnings.push('Uncommitted local changes are not visible to the agent runner.')
  }
  return warnings
}

const NOTE_FILE_LIMIT = 20

/**
 * Tells the remote agent which local work it cannot see, so it can say so instead of guessing.
 * Empty when the runner works on exactly what the user has locally.
 * @param {WorkspaceState} state
 * @returns {string}
 */
function runnerWorkspaceNote(state) {
  const pushed = Boolean(state.branch && state.remoteSha)
  const drifted = pushed && state.headSha !== state.remoteSha
  if (pushed && !drifted && state.changedFiles.length === 0) return ''
  /** @type {string[]} */
  const lines = []
  if (!state.branch) {
    lines.push('The user\'s local checkout is on a detached HEAD, so you are working on the site\'s production branch.')
  } else if (!pushed) {
    lines.push(`The user's local branch ${state.branch} is not on origin, so you are working on the site's production branch.`)
  } else {
    lines.push(`You are working on origin/${state.branch} at ${state.remoteSha.slice(0, 12)}.`)
    if (drifted) {
      lines.push(`The user's local checkout is at ${state.headSha.slice(0, 12)}, which differs from origin/${state.branch}; commits that exist only in their checkout are not visible to you.`)
    }
  }
  const count = state.changedFiles.length
  if (count > 0) {
    const shown = state.changedFiles.slice(0, NOTE_FILE_LIMIT).join(', ')
    const more = count > NOTE_FILE_LIMIT ? `, and ${count - NOTE_FILE_LIMIT} more` : ''
    lines.push(`Their checkout has ${count} uncommitted file${count === 1 ? '' : 's'} you cannot see: ${shown}${more}.`)
  }
  lines.push(`If the request depends on that local work, say so and ask the user to commit and push it to ${state.branch && pushed ? state.branch : 'a branch on origin'}.`)
  return `<local_workspace>\n${lines.join('\n')}\n</local_workspace>`
}

/**
 * @param {string} patch
 * @returns {string[]}
 */
function patchFiles(patch) {
  return [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => match[2])
}

/**
 * Applies a patch only when every hunk applies, so a failed turn never half-edits the workspace.
 * @param {{ cwd: string, patchPath: string, run?: GitRunner, readFile?: (filePath: string) => string }} input
 * @returns {PatchApplyResult}
 */
function applyPatchFile({ cwd, patchPath, run = runCommand, readFile = (filePath) => fs.readFileSync(filePath, 'utf8') }) {
  const files = patchFiles(readFile(patchPath))
  const check = run('git', ['apply', '--check', patchPath], { cwd })
  if (check.status !== 0) return { status: 'conflict', files, detail: check.detail }
  const applied = run('git', ['apply', patchPath], { cwd })
  if (applied.status !== 0) return { status: 'conflict', files, detail: applied.detail }
  return { status: 'applied', files, detail: '' }
}

module.exports = {
  applyPatchFile,
  inspectWorkspace,
  runnerWorkspaceNote,
  workspaceWarnings,
}
