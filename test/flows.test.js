const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { FLOW_PICKER_ORDER, listFlows, loadFlow, loadStepPrompt } = require('../lib/flows')

test('loadFlow reads flow.yml via configorama and normalizes steps', async () => {
  const flow = await loadFlow('review')
  assert.equal(flow.id, 'review')
  assert.equal(flow.title, 'Review')
  assert.equal(flow.defaults.transport, 'auto')
  assert.deepEqual(flow.defaults.agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps.map((step) => step.id), ['review', 'cross-review', 'synthesize'])
  assert.deepEqual(flow.steps[0].agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps[2].agents, ['codex'])
  assert.equal(flow.steps[0].waitFor, 'agent-results')
})

test('listFlows discovers flow directories', async () => {
  const flows = await listFlows()
  const ids = flows.map((flow) => flow.id)
  for (const id of [
    'review',
    'ideas',
    'do-next',
    'security-audit',
    'performance-audit',
    'analytics-audit',
    'seo-audit',
    'accessibility-audit',
    'mobile-responsiveness',
    'e2e-tests',
    'unit-tests',
    'documentation',
    'error-handling',
    'ux-copy-polish',
  ]) {
    assert.ok(ids.includes(id), `expected ${id} to be discovered`)
  }
})

test('listFlows orders primary workflows for the picker', async () => {
  const flows = await listFlows()
  assert.deepEqual(flows.slice(0, FLOW_PICKER_ORDER.length).map((flow) => flow.id), FLOW_PICKER_ORDER)
})

test('loadStepPrompt resolves prompts relative to the flow directory', async () => {
  const flow = await loadFlow('review')
  const prompt = loadStepPrompt(flow, flow.steps[1])
  assert.equal(prompt.name, 'cross-review')
  assert.match(prompt.body, /Cross Reference Review/)
})

test('loadFlow reads do-next workflow', async () => {
  const flow = await loadFlow('do-next')
  assert.equal(flow.id, 'do-next')
  assert.equal(flow.title, 'Do Next')
  assert.deepEqual(flow.steps.map((step) => step.id), ['propose', 'synthesize'])
  assert.deepEqual(flow.steps[0].agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps[1].agents, ['codex'])
  assert.equal(loadStepPrompt(flow, flow.steps[0]).name, 'propose-next-task')
  assert.equal(loadStepPrompt(flow, flow.steps[1]).name, 'synthesize-next-task')
})

test('loadFlow reads ideas workflow', async () => {
  const flow = await loadFlow('ideas')
  assert.equal(flow.id, 'ideas')
  assert.equal(flow.title, 'Ideas')
  assert.deepEqual(flow.steps.map((step) => step.id), ['ideate', 'cross-score', 'react', 'synthesize'])
  assert.deepEqual(flow.steps[0].agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps[3].agents, ['codex'])
  assert.equal(loadStepPrompt(flow, flow.steps[0]).name, 'ideate')
  assert.equal(loadStepPrompt(flow, flow.steps[1]).name, 'cross-score')
  assert.equal(loadStepPrompt(flow, flow.steps[2]).name, 'react')
  assert.equal(loadStepPrompt(flow, flow.steps[3]).name, 'synthesize-ideas')
})

test('loadFlow reads added domain workflows', async () => {
  const expected = new Map([
    ['security-audit', ['audit', 'synthesize']],
    ['performance-audit', ['audit', 'synthesize']],
    ['analytics-audit', ['audit', 'synthesize']],
    ['seo-audit', ['audit', 'synthesize']],
    ['accessibility-audit', ['audit', 'synthesize', 'implement']],
    ['mobile-responsiveness', ['audit', 'synthesize', 'implement']],
    ['e2e-tests', ['discover', 'synthesize', 'implement']],
    ['unit-tests', ['discover', 'synthesize', 'implement']],
    ['documentation', ['audit', 'synthesize', 'implement']],
    ['error-handling', ['audit', 'synthesize', 'implement']],
    ['ux-copy-polish', ['audit', 'synthesize', 'implement']],
  ])

  for (const [id, steps] of expected.entries()) {
    const flow = await loadFlow(id)
    assert.equal(flow.id, id)
    assert.deepEqual(flow.steps.map((step) => step.id), steps)
    assert.deepEqual(flow.steps[0].agents, ['claude', 'gemini', 'codex'])
    assert.deepEqual(flow.steps[flow.steps.length - 1].agents, ['codex'])
    const implementStep = flow.steps.find((step) => step.id === 'implement')
    if (implementStep) {
      assert.equal(implementStep.action, 'comment')
      assert.equal(implementStep.submit, 'follow-up')
      assert.deepEqual(implementStep.input, [{ step: 'synthesize', results: 'all' }])
    }
    for (const step of flow.steps) {
      assert.ok(loadStepPrompt(flow, step).body.length > 0)
    }
  }
})

test('loadFlow accepts json flow files through configorama', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'json-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.json'), JSON.stringify({
    id: 'json-flow',
    title: 'JSON Flow',
    steps: [{ id: 'one', prompt: 'prompts/one.md', agents: ['codex'] }],
  }))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nBody\n')

  const flow = await loadFlow('json-flow', { flowsDir: tmp })
  assert.equal(flow.id, 'json-flow')
  assert.equal(flow.steps[0].id, 'one')
  assert.equal(loadStepPrompt(flow, flow.steps[0]).title, 'One')
})

test('loadFlow rejects unsupported wait modes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'bad-flow')
  fs.mkdirSync(flowDir, { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: bad-flow',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
    '    agents: [codex]',
    '    waitFor: submitted',
    '',
  ].join('\n'))

  await assert.rejects(
    () => loadFlow('bad-flow', { flowsDir: tmp }),
    /Only "agent-results" is supported/,
  )
})
