const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { executeLocalFlow } = require('../../src/workflows/engine/local-executor')

test('mock four-instance step holds at most four submit-through-result lifecycle slots', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-multi-e2e-'))
  fs.mkdirSync(path.join(projectRoot, '.netlify'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, '.netlify', 'state.json'), JSON.stringify({ siteId: 'site-mock' }))
  fs.writeFileSync(path.join(projectRoot, 'prompt.md'), [
    '---',
    'title: Mock review',
    'instruction: review the fixture',
    '---',
    '',
    'Return a deterministic mock result.',
  ].join('\n'))
  const lineup = ['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5']
    .map((model) => ({ agent: 'claude', model }))
  const step = {
    id: 'review',
    title: 'Mock review',
    action: 'review',
    submit: 'agent-runner',
    waitFor: 'agent-results',
    prompt: 'prompt.md',
    lineup,
    agents: ['claude'],
  }
  const flow = {
    id: 'mock-multi',
    title: 'Mock multi-instance',
    dir: projectRoot,
    defaults: {},
    steps: [step],
  }
  const runState = {
    schemaVersion: 1,
    runId: 'run-mock-multi',
    flowId: flow.id,
    flowTitle: flow.title,
    transport: 'netlify-api',
    projectRoot,
    status: 'running',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    dir: path.join(projectRoot, '.nax', 'workflows', 'run-mock-multi'),
    steps: [],
    options: {},
  }
  let active = 0
  let maxActive = 0
  const starts = []

  await executeLocalFlow({
    flow,
    steps: [step],
    options: { branch: 'feature/mock', timeoutMinutes: 1 },
    runState,
    projectRoot,
    submitAgentRun: async ({ run }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      starts.push(run.instanceId)
      return {
        ...run,
        status: 'submitted',
        runnerId: `runner-${starts.length}`,
        sessionId: `session-${starts.length}`,
        links: {
          agentRunUrl: `https://example.test/runners/${starts.length}`,
          sessionUrl: `https://example.test/runners/${starts.length}/sessions/1`,
        },
      }
    },
    waitForAgentRuns: async ({ runs, onProgress, onTerminalRun }) => {
      const run = runs[0]
      await new Promise((resolve) => setTimeout(resolve, run.runnerId === 'runner-3' ? 1 : 4))
      const completed = { ...run, status: 'completed', resultText: `result for ${run.instanceId}` }
      active -= 1
      onProgress({ run: completed, state: 'completed', terminal: true, terminalSuccess: true })
      onTerminalRun(completed)
      return [completed]
    },
  })

  assert.equal(maxActive, 4)
  assert.equal(active, 0)
  assert.deepEqual(starts, lineup.map(({ agent, model }) => `${agent}:${model}:auto`))
  assert.equal(runState.steps[0].status, 'completed')
  assert.equal(runState.steps[0].runs.length, 4)
  assert.ok(runState.steps[0].runs.every((run) => run.status === 'completed'))
})
