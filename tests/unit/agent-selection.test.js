const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyAgentSelection,
  assertValidAgentSelection,
  flowDeclaredAgentValidationErrors,
  normalizeStepAgents,
  parseStepAgentsEntries,
  selectionValidationErrors,
  stepAgentsToEntries,
} = require('../../src/core/agents/selection')

test('parseStepAgentsEntries parses repeatable step=agent overrides', () => {
  assert.deepEqual(parseStepAgentsEntries([
    'review=claude,codex',
    'summarize=codex',
    'cross-review=',
  ]), {
    review: ['claude', 'codex'],
    summarize: ['codex'],
    'cross-review': [],
  })
})

test('instance syntax preserves repeated providers and per-instance configuration', () => {
  const flow = {
    defaults: { agents: ['claude', 'codex'], lineup: ['claude', 'codex'] },
    steps: [{ id: 'review', agents: ['claude', 'codex'], lineup: ['claude', 'codex'] }],
  }
  const selected = applyAgentSelection(flow, {
    agents: ['claude:claude-opus-5:high,claude:claude-opus-4-8:low', 'codex:latest'],
  })

  assert.deepEqual(selected.steps[0].agents, ['claude', 'codex'])
  assert.deepEqual(selected.steps[0].lineup, [
    { agent: 'claude', model: 'claude-opus-5', effort: 'high' },
    { agent: 'claude', model: 'claude-opus-4-8', effort: 'low' },
    { agent: 'codex', model: 'latest' },
  ])
})

test('step instance syntax overrides the global lineup for that step', () => {
  const flow = {
    defaults: { agents: ['claude', 'gemini'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini'] },
      { id: 'summarize', agents: ['claude'] },
    ],
  }
  const selected = applyAgentSelection(flow, {
    agents: ['claude'],
    stepAgents: { review: ['gemini:gemini-3.6-flash:medium', 'gemini:gemini-3.6-flash:high'] },
  })

  assert.deepEqual(selected.steps[0].lineup, [
    { agent: 'gemini', model: 'gemini-3.6-flash', effort: 'medium' },
    { agent: 'gemini', model: 'gemini-3.6-flash', effort: 'high' },
  ])
  assert.deepEqual(selected.steps[1].lineup, [{ agent: 'claude' }])
})

test('applyAgentSelection lets per-step agents override global agents', () => {
  const flow = {
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'cross-review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'summarize', agents: ['codex'] },
    ],
  }

  const selected = applyAgentSelection(flow, {
    agents: ['claude'],
    stepAgents: {
      'cross-review': ['gemini', 'codex'],
      summarize: [],
    },
  })

  assert.deepEqual(selected.steps.map((step) => [step.id, step.agents]), [
    ['review', ['claude']],
    ['cross-review', ['gemini', 'codex']],
    ['summarize', []],
  ])
})

test('stepAgentsToEntries renders command-ready entries', () => {
  assert.deepEqual(stepAgentsToEntries(normalizeStepAgents({
    review: ['claude', 'codex'],
    summarize: ['codex'],
  })), [
    'review=claude,codex',
    'summarize=codex',
  ])
})

test('flow-declared unknown step agents are rejected', () => {
  const flow = {
    id: 'bad-agents',
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'opus'] },
    ],
  }

  assert.throws(
    () => assertValidAgentSelection(flow, {}),
    /Unknown agent "opus" in step "review" for flow "bad-agents". Known agents: claude, gemini, codex./,
  )
})

test('flow-declared unknown default agents are rejected', () => {
  const flow = {
    id: 'bad-defaults',
    defaults: { agents: ['claude', 'bogus'] },
    steps: [
      { id: 'review', agents: ['claude', 'bogus'] },
    ],
  }

  const errors = flowDeclaredAgentValidationErrors(flow)
  assert.equal(errors[0].code, 'unknown_flow_agent')
  assert.match(errors[0].message, /Unknown agent "bogus" in defaults.agents/)
})

test('valid selected agents pass and invalid CLI selections still fail', () => {
  const flow = {
    id: 'review',
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'summarize', agents: ['codex'] },
    ],
  }

  assert.deepEqual(selectionValidationErrors(flow, { agents: ['claude'], stepAgents: { summarize: ['codex'] } }), [])
  assert.throws(
    () => assertValidAgentSelection(flow, { agents: ['openai'] }),
    /Unknown agent "openai" for flow "review"./,
  )
  assert.throws(
    () => assertValidAgentSelection(flow, { stepAgents: { summarize: ['claude'] } }),
    /Agent "claude" is not configured for step "summarize"/,
  )
})
