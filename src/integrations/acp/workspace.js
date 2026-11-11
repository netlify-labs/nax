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
  const status = run('git', ['status', '--porcelain'], { cwd })
  return {
    branch,
    headSha: head.status === 0 ? head.stdout : '',
    remoteSha: remote && remote.status === 0 ? remote.stdout.split(/\s+/)[0] || '' : '',
    dirty: status.status === 0 && status.stdout !== '',
  }
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
  workspaceWarnings,
}
