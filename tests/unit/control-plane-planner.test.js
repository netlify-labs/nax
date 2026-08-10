const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { findStepRange, resolvedLineupForStep } = require('../../src/core/planning/workflow')
const { loadFlow, loadStepPrompt } = require('../../src/workflows/catalog/flows')
const {
  MAX_CONTEXT_BYTES,
  MAX_PROMPT_BYTES,
  prepareAgentRunPlan,
  prepareWorkflowPlan,
  requestHash,
  sha256,
  structuredInstances,
} = require('../../src/control-plane/planner')

/** @returns {import('../../src/contracts').ControlPlaneScope} */
function scopeFixture() {
  return { scopeId: 'scope_test', projectId: 'project_test', accountId: 'account_test', siteId: 'site_test' }
}

/** @returns {import('../../src/contracts').ControlPlaneTarget} */
function targetFixture() {
  return { accountId: 'account_test', accountSlug: 'team-test', siteId: 'site_test', siteName: 'Test Site', branch: 'main', ref: 'origin/main', sha: 'a'.repeat(40), verified: true, caveats: [] }
}

/** @returns {import('../../src/types').WorkflowFlow} */
function flowFixture() {
  return {
    id: 'security-review',
    title: 'Security review',
    description: 'Review security boundaries.',
    defaults: { transport: 'auto', agents: ['claude', 'codex'], lineup: ['claude', 'codex'], models: {}, efforts: {} },
    warnings: [{ stepId: 'analyze', code: 'fixture_warning', message: 'Fixture warning.' }],
    steps: [
      { id: 'analyze', title: 'Analyze', description: 'Analyze.', action: 'issue', submit: 'new-run', waitFor: 'agent-results', agents: ['claude', 'codex'], lineup: ['claude', 'codex'], models: {}, efforts: {}, input: [] },
      { id: 'follow', title: 'Follow up', description: 'Cross-review.', action: 'comment', submit: 'follow-up', waitFor: 'agent-results', agents: ['claude', 'codex'], lineup: ['claude', 'codex'], models: {}, efforts: {}, input: [{ step: 'analyze', results: 'peers' }] },
      { id: 'approve', title: 'Approve', description: 'Human gate.', action: 'human-review', type: 'human-review', submit: 'human-review', waitFor: 'human-review', agents: [], lineup: [], models: {}, efforts: {}, input: [{ step: 'follow', results: 'all' }] },
      { id: 'fix', title: 'Fix', description: 'Apply fixes.', action: 'issue', submit: 'new-run', waitFor: 'agent-results', agents: ['codex'], lineup: ['codex'], models: {}, efforts: {}, input: [{ step: 'approve', results: 'all' }] },
    ],
  }
}

const NOW = new Date('2026-08-08T12:00:00.000Z')

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

test('portable plan hashing matches the SHA-256 standard vector', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('shared workflow planning helpers preserve CLI lineup precedence and exact ranges', () => {
  const flow = flowFixture()
  const lineup = resolvedLineupForStep(flow, flow.steps[0], {
    models: { claude: 'claude-opus-5' },
    stepEfforts: { analyze: { claude: 'high' } },
  }, 'netlify-api')
  assert.deepEqual(lineup.instances.map((instance) => ({ agent: instance.agent, model: instance.model, effort: instance.effort })), [
    { agent: 'claude', model: 'claude-opus-5', effort: 'high' },
    { agent: 'codex', model: undefined, effort: undefined },
  ])
  assert.deepEqual(findStepRange(flow, { onlyStep: 'approve' }).map((step) => step.id), ['approve'])
  assert.deepEqual(findStepRange(flow, { fromStep: 'follow' }).map((step) => step.id), ['follow', 'approve', 'fix'])
  assert.throws(() => findStepRange(flow, { onlyStep: 'analyze', fromStep: 'fix' }), (error) => errorCode(error) === 'invalid_step_range')
})

test('workflow planner resolves structured global and per-step instances without mutation', () => {
  const flow = flowFixture()
  const input = {
    workflowId: 'security-review',
    branch: 'main',
    instances: [
      { agent: 'claude', model: 'claude-opus-5', effort: 'high', label: 'deep' },
      { agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium', label: 'fixer' },
    ],
    stepInstances: { fix: [{ agent: 'codex', model: 'gpt-5.4-mini', effort: 'low', label: 'fast-fix' }] },
    context: 'Inspect the authorization boundary.',
    fromStep: 'follow',
  }
  const before = JSON.stringify({ flow, input })
  const prepared = prepareWorkflowPlan({ planId: 'plan_01', now: NOW, scope: scopeFixture(), target: targetFixture(), flow, input })

  assert.equal(JSON.stringify({ flow, input }), before)
  assert.equal(prepared.plan.expiresAt, '2026-08-08T12:10:00.000Z')
  assert.deepEqual(prepared.plan.steps.map((step) => step.stepId), ['follow', 'approve', 'fix'])
  assert.deepEqual(prepared.plan.steps[0].instances.map((instance) => instance.instanceId), ['claude:claude-opus-5:high', 'codex:gpt-5.6-sol:medium'])
  assert.deepEqual(prepared.plan.steps[1].instances, [])
  assert.equal(prepared.plan.steps[1].reviewGate, true)
  assert.deepEqual(prepared.plan.steps[2].instances.map((instance) => instance.instanceId), ['codex:gpt-5.4-mini:low'])
  assert.equal(prepared.plan.expectedAgentRuns, 3)
  assert.match(prepared.plan.summary, /3 remote Agent Runner submissions.*Test Site.*branch main/)
  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(Object.isFrozen(prepared.plan.steps), true)
  assert.equal(prepared.requestHash, requestHash({ kind: 'workflow', scope: scopeFixture(), target: targetFixture(), normalizedInput: prepared.normalizedInput }))
})

test('workflow planner supports exact step selection, prompt warnings, and deterministic hashes', () => {
  const options = {
    planId: 'plan_01', now: NOW, scope: scopeFixture(), target: targetFixture(), flow: flowFixture(),
    input: { workflowId: 'security-review', onlyStep: 'analyze' },
    promptBytesByStep: { analyze: 90 * 1024 },
  }
  const first = prepareWorkflowPlan(options)
  const second = prepareWorkflowPlan({ ...options, planId: 'plan_different' })
  assert.deepEqual(first.plan.steps.map((step) => step.stepId), ['analyze'])
  assert.equal(first.plan.expectedAgentRuns, 2)
  assert.equal(first.plan.warnings.some((warning) => warning.code === 'prompt_offload_required'), true)
  assert.equal(first.requestHash, second.requestHash)
})

test('loaded workflow plans match the same resolved lineups used by CLI execution', async () => {
  const flow = await loadFlow('review')
  const promptBytesByStep = Object.fromEntries((flow.steps || []).filter((step) => step.prompt).map((step) => [String(step.id), Buffer.byteLength(loadStepPrompt(flow, step).description || '', 'utf8')]))
  const prepared = prepareWorkflowPlan({
    planId: 'plan_loaded', now: NOW, scope: scopeFixture(), target: targetFixture(), flow,
    input: { workflowId: 'review' }, promptBytesByStep,
  })
  for (const step of flow.steps || []) {
    if (step.submit === 'follow-up' || step.action === 'human-review') continue
    const planned = prepared.plan.steps.find((candidate) => candidate.stepId === step.id)
    const execution = resolvedLineupForStep(flow, step, {}, 'netlify-api')
    assert.deepEqual(planned?.instances.map((instance) => instance.instanceId), execution.instances.map((instance) => instance.id))
  }
})

test('workflow planner rejects unsupported transports, unsafe bindings, and invalid instance contracts', () => {
  const base = { planId: 'plan_01', now: NOW, scope: scopeFixture(), target: targetFixture(), flow: flowFixture(), input: { workflowId: 'security-review' } }
  assert.throws(() => prepareWorkflowPlan({ ...base, transport: 'auto' }), (error) => errorCode(error) === 'unsupported_transport')
  assert.throws(() => prepareWorkflowPlan({ ...base, transport: 'github' }), (error) => errorCode(error) === 'unsupported_transport')
  assert.throws(() => prepareWorkflowPlan({ ...base, target: { ...targetFixture(), verified: false } }), (error) => errorCode(error) === 'unverified_target')
  assert.throws(() => prepareWorkflowPlan({ ...base, input: { workflowId: 'security-review', branch: 'feature' } }), (error) => errorCode(error) === 'target_branch_mismatch')
  assert.throws(() => prepareWorkflowPlan({ ...base, input: { workflowId: 'security-review', instances: /** @type {never} */ (['claude']) } }), (error) => errorCode(error) === 'invalid_instance_contract')
  assert.throws(() => structuredInstances([{ agent: 'claude', models: ['claude-opus-5'] }], 'instances'), (error) => errorCode(error) === 'invalid_instance_contract')
  assert.throws(() => prepareWorkflowPlan({ ...base, input: { workflowId: 'security-review', instances: [{ agent: 'claude', label: 'same' }, { agent: 'codex', label: 'same' }] } }), (error) => errorCode(error) === 'duplicate_instance_label')
  assert.throws(() => prepareWorkflowPlan({ ...base, input: { workflowId: 'security-review', stepInstances: { follow: [{ agent: 'claude' }] } } }), (error) => errorCode(error) === 'invalid_instance_contract')
  assert.throws(() => prepareWorkflowPlan({ ...base, input: { workflowId: 'security-review', context: 'x'.repeat(MAX_CONTEXT_BYTES + 1) } }), (error) => errorCode(error) === 'context_too_large')
  assert.throws(() => prepareWorkflowPlan({ ...base, input: /** @type {never} */ ({ workflowId: 'security-review', models: { claude: 'claude-opus-5' } }) }), (error) => errorCode(error) === 'invalid_instance_contract')
  assert.throws(() => prepareWorkflowPlan({ ...base, input: /** @type {never} */ ({ workflowId: 'security-review', authToken: 'secret' }) }), (error) => errorCode(error) === 'invalid_arguments')
})

test('single-agent planner validates prompt, instance, target, expiry, and warning output', () => {
  const prepared = prepareAgentRunPlan({
    planId: 'plan_agent', now: NOW, scope: scopeFixture(), target: { ...targetFixture(), caveats: ['branch-ahead'] },
    input: { prompt: 'Audit the auth boundary.', instance: { agent: 'opencode', model: 'z-ai/glm-5.2', effort: 'max' }, branch: 'main' },
  })
  assert.equal(prepared.plan.kind, 'agent-run')
  assert.equal(prepared.plan.expectedAgentRuns, 1)
  assert.equal(prepared.plan.instances[0].effort, 'max')
  assert.equal(prepared.plan.warnings.some((warning) => warning.code === 'target_branch_ahead'), true)
  assert.equal(/** @type {{ prompt: string }} */ (prepared.normalizedInput).prompt, 'Audit the auth boundary.')
  assert.throws(() => prepareAgentRunPlan({ planId: 'plan_agent', now: NOW, scope: scopeFixture(), target: targetFixture(), input: { prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1), instance: { agent: 'claude' } } }), (error) => errorCode(error) === 'prompt_too_large')
})

test('planner source is runtime-neutral and contains no I/O, transport call, or secret field surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'control-plane', 'planner.js'), 'utf8')
  assert.doesNotMatch(source, /node:fs|child_process|dashboard|submitLocalAgentRun|runWorkflow/)
  assert.doesNotMatch(source, /authToken|authorization|apiKey/)
})
