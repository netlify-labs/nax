const { resolveRepo } = require('../prompts')
const { syncLastAgentRunner } = require('../agent-runner-sync')
const { parseGithubActionsRunTarget, syncGithubActionsRun } = require('../github-actions-sync')
const { relativeDisplayPath } = require('../handoff-sources')
const { buildNetlifyEnv } = require('../local-runner')
const { resolveProjectRoot } = require('../netlify/project-selection')

/**
 * Process runner shared by Netlify and GitHub sync paths.
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options?: import('child_process').SpawnSyncOptionsWithStringEncoding | import('../types').JsonMap,
 * ) => import('../types').CommandResult} SyncRunCommand
 *
 * Injectable dependencies for sync command handlers.
 * @typedef {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   runCommand?: SyncRunCommand,
 *   log?: (message: string) => void,
 * }} SyncDependencies
 *
 * Result returned by the sync command.
 * @typedef {import('../types').JsonMap & {
 *   runnerId?: string,
 *   runId?: string,
 *   artifactName?: string,
 *   dir?: string,
 *   workflowCount?: number,
 *   runnerCount?: number,
 *   sessionCount?: number,
 *   latestWorkflowId?: string,
 *   syncedSessionCount?: number,
 *   remoteSessionCount?: number,
 * }} SyncCommandResult
 */

/**
 * Syncs local .nax artifacts from Netlify Agent Runner or GitHub Actions state.
 * @param {string | number} [target]
 * @param {import('../commands/options').CliOptions} [options]
 * @param {SyncDependencies} [dependencies]
 * @returns {SyncCommandResult}
 */
function handleSync(target = 'last', options = {}, {
  cwd = process.cwd(),
  env = process.env,
  runCommand,
  log = console.log,
} = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd })
  const selected = String(target || 'last').trim().toLowerCase()
  const githubRun = parseGithubActionsRunTarget(target)
  if (githubRun) {
    const repo = githubRun.repo || resolveRepo(options.repo)
    const result = syncGithubActionsRun({
      projectRoot,
      repo,
      runId: githubRun.runId,
      artifactName: options.artifact,
      cwd,
      env,
      runCommand,
    })
    log(`Synced GitHub Actions run ${result.runId}: ${result.artifactName}`)
    log(`Materialized: ${relativeDisplayPath(projectRoot, result.dir)}`)
    log(`Artifacts: ${result.workflowCount} workflows, ${result.runnerCount} runners, ${result.sessionCount} sessions`)
    if (result.latestWorkflowId) log(`Latest workflow: ${result.latestWorkflowId}`)
    return result
  }
  if (selected !== 'last') {
    throw new Error('Expected `nax sync last`, a GitHub Actions run ID, or a GitHub Actions run URL.')
  }
  const netlify = buildNetlifyEnv({ projectRoot, env })
  const result = syncLastAgentRunner({
    projectRoot,
    env: netlify.env,
    runCommand,
  })
  log(`Synced Agent Runner ${result.runnerId}: ${result.syncedSessionCount}/${result.remoteSessionCount} remote sessions`)
  if (result.dir) log(`Updated: ${relativeDisplayPath(projectRoot, result.dir)}`)
  return result
}

module.exports = {
  handleSync,
}
