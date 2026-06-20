const { createRunState, saveRunState } = require('./run-state')

function uniqueAgents(runs = []) {
  const seen = new Set()
  const agents = []
  for (const run of runs) {
    const agent = String(run?.agent || '').trim()
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    agents.push(agent)
  }
  return agents
}

function submittedStepStatus(runs = []) {
  if (runs.some((run) => ['failed', 'timeout', 'cancelled', 'canceled'].includes(String(run?.status || '').toLowerCase()))) {
    return 'failed'
  }
  if (runs.length > 0 && runs.every((run) => String(run?.status || '').toLowerCase() === 'completed')) return 'completed'
  return 'submitted'
}

function freshAgentFlow({ title = 'Agent Run', stepTitle = 'Fresh Agent Runner' } = {}) {
  return {
    id: 'agent-run',
    title,
    description: 'One-off Netlify agent runner launched from visualizer follow-up.',
    source: 'visualizer',
    sourceLabel: 'visualizer',
    steps: [{
      id: 'fresh-agent-runner',
      title: stepTitle,
      description: 'Fresh agent runner seeded with selected prior results.',
      prompt: '',
      action: 'agent-run',
      submit: 'new-run',
      waitFor: '',
      agents: [],
      input: [],
    }],
  }
}

/**
 * @param {{
 *   projectRoot: string,
 *   runs: Array<Record<string, any>>,
 *   source?: Record<string, any>,
 *   promptText?: string,
 *   target?: Record<string, any> | null,
 *   now?: Date,
 *   title?: string,
 *   stepTitle?: string,
 * }} input
 */
function persistFreshPseudoWorkflow({
  projectRoot,
  runs,
  source = {},
  promptText = '',
  target = null,
  now = new Date(),
  title = 'Agent Run',
  stepTitle = 'Fresh Agent Runner',
}) {
  const agents = uniqueAgents(runs)
  const flow = freshAgentFlow({ title, stepTitle })
  flow.steps[0].agents = agents
  /** @type {any} */
  const state = createRunState({
    projectRoot,
    flow,
    transport: 'netlify-api',
    target,
    options: {
      models: agents,
      context: '',
      visualizerFollowup: true,
    },
    now,
  })
  const timestamp = now.toISOString()
  state.status = submittedStepStatus(runs)
  state.source = {
    type: 'visualizer-followup',
    mode: 'fresh-runner',
    ...source,
  }
  state.steps = [{
    id: 'fresh-agent-runner',
    title: stepTitle,
    status: submittedStepStatus(runs),
    agents,
    promptText,
    runs: runs.map((run) => ({
      transport: run.transport || 'netlify-api',
      agent: run.agent || '',
      status: run.status || 'submitted',
      promptText: run.promptText || promptText,
      compactPromptText: run.compactPromptText || '',
      resultText: run.resultText || '',
      runnerId: run.runnerId || '',
      sessionId: run.sessionId || '',
      issueUrl: run.issueUrl || '',
      commentUrl: run.commentUrl || '',
      prUrl: run.prUrl || '',
      deployUrl: run.deployUrl || '',
      links: run.links || {},
      raw: {
        ...(run.raw || {}),
        source,
      },
      createdAt: run.createdAt || timestamp,
      updatedAt: run.updatedAt || timestamp,
    })),
  }]
  return saveRunState(state)
}

module.exports = {
  freshAgentFlow,
  persistFreshPseudoWorkflow,
  submittedStepStatus,
  uniqueAgents,
}
