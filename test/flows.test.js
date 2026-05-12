const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { listFlows, loadFlow, loadStepPrompt } = require('../lib/flows')

test('loadFlow reads flow.yml via configorama and normalizes steps', async () => {
  const flow = await loadFlow('review-cycle')
  assert.equal(flow.id, 'review-cycle')
  assert.equal(flow.title, 'Review Cycle')
  assert.equal(flow.defaults.transport, 'auto')
  assert.deepEqual(flow.defaults.agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps.map((step) => step.id), ['review', 'cross-review', 'synthesize'])
  assert.deepEqual(flow.steps[0].agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps[2].agents, ['codex'])
  assert.equal(flow.steps[0].waitFor, 'agent-results')
})

test('listFlows discovers flow directories', async () => {
  const flows = await listFlows()
  assert.ok(flows.some((flow) => flow.id === 'review-cycle'))
})

test('loadStepPrompt resolves prompts relative to the flow directory', async () => {
  const flow = await loadFlow('review-cycle')
  const prompt = loadStepPrompt(flow, flow.steps[1])
  assert.equal(prompt.name, 'cross-review')
  assert.match(prompt.body, /Cross Reference Review/)
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
