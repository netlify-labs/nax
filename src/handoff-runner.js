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

/** @param {Record<string, any>} [input] */
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
 * @param {Record<string, any>} input
 */
async function submitAgentRun({
  projectRoot,
  agent,
  promptText,
  source = { type: 'visualizer-followup' },
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
      type: 'visualizer-followup',
      mode: 'fresh-runner',
      ...(options.source || {}),
    },
  })
}

function submitFollowupSession(options = {}) {
  return submitAgentRun({
    ...options,
    source: {
      type: 'visualizer-followup',
      mode: 'follow-up-thread',
      ...(options.source || {}),
    },
  })
}

/** @param {Record<string, any>} [input] */
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
