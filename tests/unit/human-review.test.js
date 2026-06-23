const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { loadFlow } = require('../../src/workflows/catalog/flows')
const {
  approveHumanReviewGate,
  cancelHumanReviewGate,
  createHumanReviewStepState,
} = require('../../src/workflows/human-review')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-human-review-test-'))
}

function writeFlow(root) {
  const flowDir = path.join(root, '.github', 'nax-flows', 'review-gate')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'prompts', 'audit.md'), '# Audit\n')
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: review-gate',
    'title: Review Gate',
    'defaults:',
    '  agents: codex',
    'steps:',
    '  - id: audit',
    '    title: Audit',
    '    prompt: prompts/audit.md',
    '  - id: approve',
    '    title: Approve Audit',
    '    action: human-review',
    '    description: Review before continuing.',
    '  - id: implement',
    '    title: Implement',
    '    prompt: prompts/audit.md',
    '    input:',
    '      - step: audit',
    '',
  ].join('\n'))
}

function runState(root, step) {
  const dir = path.join(root, '.nax', 'workflows', 'run-1')
  fs.mkdirSync(dir, { recursive: true })
  return {
    runId: 'run-1',
    flowId: 'review-gate',
    flowTitle: 'Review Gate',
    projectRoot: root,
    transport: 'netlify-api',
    status: 'awaiting_review',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    steps: [step],
    dir,
  }
}

test('flows can declare human-review gate steps without prompts or agents', async () => {
  const root = tmpdir()
  writeFlow(root)
  const flow = await loadFlow('review-gate', { projectRoot: root })
  assert.equal(flow.steps[1].action, 'human-review')
  assert.equal(flow.steps[1].submit, 'human-review')
  assert.equal(flow.steps[1].waitFor, 'human-review')
  assert.deepEqual(flow.steps[1].agents, [])
})

test('human review gate approval and cancellation persist workflow state', () => {
  const root = tmpdir()
  const step = createHumanReviewStepState({ id: 'approve', title: 'Approve Audit' }, { now: new Date('2026-06-20T00:00:00.000Z') })
  const approved = approveHumanReviewGate({
    runState: runState(root, step),
    stepId: 'approve',
    reviewer: 'test',
    now: new Date('2026-06-20T00:01:00.000Z'),
  })
  assert.equal(approved.status, 'running')
  assert.equal(approved.steps[0].status, 'completed')
  assert.equal(approved.steps[0].review.status, 'approved')

  const cancelled = cancelHumanReviewGate({
    runState: runState(root, createHumanReviewStepState({ id: 'approve', title: 'Approve Audit' })),
    stepId: 'approve',
    reviewer: 'test',
    reason: 'not ready',
    now: new Date('2026-06-20T00:02:00.000Z'),
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.steps[0].status, 'cancelled')
  assert.equal(cancelled.steps[0].review.reason, 'not ready')
})
