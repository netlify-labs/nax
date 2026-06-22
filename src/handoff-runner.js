const { submitLocalAgentRun } = require('./local-runner')
const { persistAgentSessionArtifact } = require('./agent-session-artifacts')
const { persistAgentRunnerArtifact } = require('./agent-runner-artifacts')

function noop() {}

function buildHandoffPrompt({ instructions = '', summaryPath = '', summaryText = '' } = {}) {
  return [
    String(instructions || '').trim()
      ? ['# Additional Instructions', '', String(instructions).trim()].join('\n')
      : '',
    [
      '# Prior Results Summary',
      '',
      summaryPath ? `Source: ${summaryPath}` : '',
      '',
      String(summaryText || '').trim(),
    ].filter((line) => line !== '').join('\n'),
  ].filter(Boolean).join('\n\n---\n\n')
}

function buildFollowupPrompt({ instructions = '', contextText = '' } = {}) {
  return [
    '# Follow-up Instructions',
    '',
    String(instructions || '').trim(),
    String(contextText || '').trim()
      ? [
          '',
          '---',
          '',
          '# Prior Results Context',
          '',
          String(contextText || '').trim(),
        ].join('\n')
      : '',
  ].filter(Boolean).join('\n')
}

function baseRun({ agent, promptText, raw = {}, existingRunnerId = '' }) {
  return {
    transport: 'netlify-api',
    agent,
    status: 'pending',
    promptText,
    compactPromptText: '',
    resultText: '',
    runnerId: '',
    sessionId: '',
    existingRunnerId,
    issueUrl: '',
    commentUrl: '',
    prUrl: '',
    deployUrl: '',
    raw,
  }
}

/**
 * Persisted agent session artifact returned by artifact writers.
 * @typedef {{
 *   session?: import('./types').JsonMap,
 *   filePath?: string,
 * }} HandoffSessionArtifact
 *
 * Persisted agent runner artifact returned by artifact writers.
 * @typedef {{
 *   runner?: import('./types').JsonMap,
 *   filePath?: string,
 * }} HandoffRunnerArtifact
 *
 * Agent session artifact writer used by handoff persistence.
 * @typedef {(input: import('./types').JsonMap) => HandoffSessionArtifact | null} HandoffPersistSession
 *
 * Agent runner artifact writer used by handoff persistence.
 * @typedef {(input: import('./types').JsonMap) => HandoffRunnerArtifact | null} HandoffPersistRunner
 *
 * Submitted artifact persistence options for one handoff run.
 * @typedef {{
 *   projectRoot?: string,
 *   run?: import('./types').AgentRun,
 *   source?: import('./types').JsonMap,
 *   now?: () => string,
 *   persistSession?: HandoffPersistSession,
 *   persistRunner?: HandoffPersistRunner,
 * }} HandoffPersistSubmittedArtifactsInput
 */

/** @param {HandoffPersistSubmittedArtifactsInput} [input] */
function persistSubmittedArtifacts({
  projectRoot,
  run,
  source,
  now = () => new Date().toISOString(),
  persistSession = persistAgentSessionArtifact,
  persistRunner = persistAgentRunnerArtifact,
} = {}) {
  const warnings = []
  let sessionArtifact = null
  let runnerArtifact = null
  try {
    const timestamp = run.createdAt || now()
    sessionArtifact = persistSession({
      projectRoot,
      run: {
        ...run,
        status: run.status || 'submitted',
      },
      source,
      createdAt: timestamp,
      updatedAt: run.updatedAt || timestamp,
    })
    runnerArtifact = persistRunner({
      projectRoot,
      runnerId: run.runnerId,
      agent: run.agent,
      status: run.status || 'submitted',
      session: sessionArtifact?.session || null,
      source,
      links: run.links || {},
      createdAt: timestamp,
      updatedAt: run.updatedAt || timestamp,
    })
  } catch (error) {
    warnings.push(error?.message || String(error))
  }
  return { sessionArtifact, runnerArtifact, warnings }
}

/**
 * Logger accepted by handoff submission helpers.
 * @typedef {{
 *   info?: (message: string) => void,
 *   warn?: (message: string) => void,
 * }} HandoffLogger
 *
 * Input passed to local Agent Runner submit callback.
 * @typedef {{
 *   run: import('./types').AgentRun,
 *   projectRoot?: string,
 *   branch?: string,
 *   siteId?: string,
 *   netlifyFilter?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} HandoffSubmitRunInput
 *
 * Local Agent Runner submit callback used by handoff workflows.
 * @typedef {(input: HandoffSubmitRunInput) => Promise<import('./types').AgentRun>} HandoffSubmitRun
 *
 * Submitted run linker callback used after Netlify submission.
 * @typedef {(run: import('./types').AgentRun) => import('./types').AgentRun} HandoffLinkRun
 *
 * Shared options for submitting one Netlify handoff run.
 * @typedef {{
 *   projectRoot?: string,
 *   agent?: string,
 *   promptText?: string,
 *   source?: import('./types').JsonMap,
 *   raw?: import('./types').JsonMap,
 *   existingRunnerId?: string,
 *   branch?: string,
 *   siteId?: string,
 *   netlifyFilter?: string,
 *   env?: NodeJS.ProcessEnv,
 *   submitRun?: HandoffSubmitRun,
 *   linkRun?: HandoffLinkRun,
 *   logger?: HandoffLogger,
 *   persist?: boolean,
 *   now?: () => string,
 *   persistSession?: HandoffPersistSession,
 *   persistRunner?: HandoffPersistRunner,
 * }} HandoffSubmitOptions
 *
 * @param {HandoffSubmitOptions} input
 */
async function submitAgentRun({
  projectRoot,
  agent,
  promptText,
  source = { type: 'dashboard-followup' },
  raw = {},
  existingRunnerId = '',
  branch = '',
  siteId = '',
  netlifyFilter = '',
  env = process.env,
  submitRun = submitLocalAgentRun,
  linkRun = (run) => run,
  logger = { info: noop, warn: noop },
  persist = true,
  now,
  persistSession,
  persistRunner,
} = {}) {
  const run = baseRun({ agent, promptText, raw, existingRunnerId })
  logger.info?.(`Submitting ${agent}${existingRunnerId ? ' follow-up session' : ' fresh runner'}.`)
  const submitted = await submitRun({
    run,
    projectRoot,
    branch,
    siteId,
    netlifyFilter,
    env,
  })
  const linked = linkRun({ ...submitted }) || submitted
  const artifacts = persist
    ? persistSubmittedArtifacts({
        projectRoot,
        run: linked,
        source,
        now,
        persistSession,
        persistRunner,
      })
    : { sessionArtifact: null, runnerArtifact: null, warnings: [] }
  for (const warning of artifacts.warnings || []) logger.warn?.(warning)
  return {
    run: linked,
    sessionArtifact: artifacts.sessionArtifact,
    runnerArtifact: artifacts.runnerArtifact,
    warnings: artifacts.warnings || [],
  }
}

function submitFreshAgentRunner(options = {}) {
  return submitAgentRun({
    ...options,
    existingRunnerId: '',
    source: {
      type: 'dashboard-followup',
      mode: 'fresh-runner',
      ...(options.source || {}),
    },
  })
}

function submitFollowupSession(options = {}) {
  return submitAgentRun({
    ...options,
    source: {
      type: 'dashboard-followup',
      mode: 'follow-up-thread',
      ...(options.source || {}),
    },
  })
}

/**
 * One dashboard handoff plan submission.
 * @typedef {{
 *   mode?: string,
 *   agent?: string,
 *   runnerId?: string,
 *   sourceTargetId?: string,
 *   sourceArtifactIds?: string[],
 * }} HandoffSubmission
 *
 * Follow-up plan submission request.
 * @typedef {{
 *   submissions?: HandoffSubmission[],
 *   promptText?: string,
 *   projectRoot?: string,
 *   shared?: HandoffSubmitOptions,
 * }} HandoffFollowupPlanInput
 */

/** @param {HandoffFollowupPlanInput} [input] */
async function submitFollowupPlan({
  submissions = [],
  promptText = '',
  projectRoot,
  shared = {},
} = {}) {
  const results = []
  for (const submission of submissions) {
    const submit = submission.mode === 'continue-runner' ? submitFollowupSession : submitFreshAgentRunner
    const result = await submit({
      ...shared,
      projectRoot,
      agent: submission.agent,
      promptText,
      existingRunnerId: submission.runnerId || '',
      source: {
        ...(shared.source || {}),
        sourceTargetId: submission.sourceTargetId || '',
        sourceArtifactIds: submission.sourceArtifactIds || [],
      },
      raw: {
        ...(shared.raw || {}),
        followupSubmission: submission,
      },
    })
    results.push({ submission, ...result })
  }
  return results
}

module.exports = {
  buildFollowupPrompt,
  buildHandoffPrompt,
  persistSubmittedArtifacts,
  submitFollowupPlan,
  submitFollowupSession,
  submitFreshAgentRunner,
}
