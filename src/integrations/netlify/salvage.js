// Commits a finished or cancelled Agent Runner session diff onto a branch.
// Creates the branch at the session base SHA first, because the platform cannot commit onto a missing branch.
const { createNaxAgentRunnerSdk } = require('./agent-runner-sdk')
const { runCommand, validateGitRefName } = require('../git/review-context')
const { runGh } = require('../github/gh-cli')

// GitHub rejects pull request bodies over 65,536 characters.
const MAX_PR_BODY_CHARS = 60000

// Runner states the Agent Runner SDK treats as terminal (success, failure, cancelled, timed out).
const FINISHED_STATES = new Set([
  'completed', 'done',
  'failed', 'error',
  'cancelled', 'canceled', 'abandoned',
  'timeout', 'timed_out', 'timedout',
])

/**
 * @typedef {(command: string, args: string[], options?: { cwd?: string }) => { status: number | null, stdout: string, stderr: string, detail: string }} GitRunner
 *
 * @typedef {(args: string[], options?: { cwd?: string }) => { stdout?: string }} GhRunner
 *
 * @typedef {{
 *   runnerId: string,
 *   sessionId?: string,
 *   branch?: string,
 *   allowDefaultBranch?: boolean,
 *   pullRequest?: boolean,
 *   projectRoot?: string,
 *   siteId?: string,
 *   env?: NodeJS.ProcessEnv,
 *   sdk?: import('nax-agent-runner-sdk').AgentRunnerSdk,
 *   run?: GitRunner,
 *   gh?: GhRunner,
 *   pollIntervalMs?: number,
 *   pollTimeoutMs?: number,
 *   onProgress?: (message: string) => void,
 * }} SalvageInput
 *
 * @typedef {{
 *   runnerId: string,
 *   sessionId: string,
 *   branch: string,
 *   baseSha: string,
 *   createdBranch: boolean,
 *   commitSha: string,
 *   prUrl: string,
 * }} SalvageResult
 */

/**
 * @param {GitRunner} run
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function requireGit(run, args, cwd) {
  const result = run('git', args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.detail}`)
  return result.stdout
}

/**
 * @param {GitRunner} run
 * @param {string} cwd
 * @returns {string}
 */
function remoteDefaultBranch(run, cwd) {
  const output = requireGit(run, ['ls-remote', '--symref', 'origin', 'HEAD'], cwd)
  const match = output.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)
  return match ? match[1] : ''
}

/**
 * @param {GitRunner} run
 * @param {string} branch
 * @param {string} cwd
 * @returns {boolean}
 */
function remoteBranchExists(run, branch, cwd) {
  return requireGit(run, ['ls-remote', '--heads', 'origin', branch], cwd).trim() !== ''
}

/**
 * Returns the open pull request for the branch, or opens one into the branch the run started from.
 * @param {{ gh: GhRunner, cwd: string, head: string, base: string, title: string, body: string }} input
 * @returns {string}
 */
function ensurePullRequest({ gh, cwd, head, base, title, body }) {
  const existing = String(gh(['pr', 'list', '--head', head, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], { cwd }).stdout || '').trim()
  if (existing) return existing
  return String(gh(['pr', 'create', '--head', head, '--base', base, '--title', title, '--body', body], { cwd }).stdout || '').trim()
}

/**
 * @param {SalvageInput} input
 * @returns {Promise<SalvageResult>}
 */
async function salvageAgentRun({
  runnerId,
  sessionId = '',
  branch = '',
  allowDefaultBranch = false,
  pullRequest = false,
  projectRoot = process.cwd(),
  siteId,
  env,
  sdk,
  run = runCommand,
  gh = runGh,
  pollIntervalMs = 3000,
  pollTimeoutMs = 5 * 60 * 1000,
  onProgress = () => {},
}) {
  if (!runnerId) throw new Error('nax salvage requires --runner <id>.')
  const client = createNaxAgentRunnerSdk({ sdk, env, siteId })
  const [runner, sessions] = await Promise.all([
    client.transport.getRunner(runnerId),
    client.transport.listSessions(runnerId),
  ])
  const state = String(runner.state || '').toLowerCase()
  if (!FINISHED_STATES.has(state)) {
    throw new Error(`Runner ${runnerId} is still running (${state || 'unknown state'}). Wait for it to finish, or cancel it, before salvaging its diff.`)
  }
  const session = sessionId
    ? sessions.find((candidate) => candidate.sessionId === sessionId)
    : sessions[sessions.length - 1]
  if (!session) throw new Error(`Runner ${runnerId} has no session${sessionId ? ` ${sessionId}` : ''}.`)
  if (!session.hasResultDiff && !session.hasCumulativeDiff) {
    throw new Error(`Session ${session.sessionId} of runner ${runnerId} has no diff to salvage.`)
  }

  const targetBranch = validateGitRefName(branch || `nax/salvage-${runnerId}`)
  const defaultBranch = remoteDefaultBranch(run, projectRoot)
  if (!allowDefaultBranch && defaultBranch && targetBranch === defaultBranch) {
    throw new Error(`Refusing to commit onto the default branch "${defaultBranch}". Pass --branch <name>, or --allow-default-branch to commit there anyway.`)
  }

  const baseSha = String(session.baseSha || '')
  let createdBranch = false
  if (!remoteBranchExists(run, targetBranch, projectRoot)) {
    if (!baseSha) {
      throw new Error(`Session ${session.sessionId} reports no base SHA, so nax cannot create ${targetBranch}. Create ${targetBranch} first at the commit the run started from, then rerun nax salvage.`)
    }
    if (run('git', ['cat-file', '-e', `${baseSha}^{commit}`], { cwd: projectRoot }).status !== 0) {
      requireGit(run, ['fetch', 'origin', baseSha], projectRoot)
    }
    onProgress(`Creating ${targetBranch} at ${baseSha.slice(0, 12)}`)
    requireGit(run, ['push', 'origin', `${baseSha}:refs/heads/${targetBranch}`], projectRoot)
    createdBranch = true
  }

  const previousSha = String(runner.mergeCommitSha || '')
  onProgress(`Committing runner ${runnerId} diff onto ${targetBranch}`)
  await client.transport.member(runnerId, 'commit', { targetBranch })
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    const current = await client.transport.getRunner(runnerId)
    if (!current.mergeCommitIsBeingCreated) {
      if (current.mergeCommitError) throw new Error(`Netlify could not commit runner ${runnerId} onto ${targetBranch}: ${current.mergeCommitError}`)
      const commitSha = String(current.mergeCommitSha || '')
      if (commitSha && commitSha !== previousSha) {
        const prUrl = pullRequest
          ? ensurePullRequest({
              gh,
              cwd: projectRoot,
              head: targetBranch,
              base: String(runner.branch || defaultBranch),
              title: session.title || `nax salvage: runner ${runnerId}`,
              body: [
                String(session.resultText || '').slice(0, MAX_PR_BODY_CHARS),
                `Salvaged from Netlify agent runner ${runnerId}, session ${session.sessionId}.`,
              ].filter(Boolean).join('\n\n---\n\n'),
            })
          : ''
        return { runnerId, sessionId: session.sessionId, branch: targetBranch, baseSha, createdBranch, commitSha, prUrl }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`Timed out waiting for Netlify to commit runner ${runnerId} onto ${targetBranch}. Check the runner's merge commit status on its run page.`)
}

module.exports = {
  salvageAgentRun,
}
