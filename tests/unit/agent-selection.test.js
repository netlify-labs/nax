const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyAgentSelection,
  assertValidAgentSelection,
  flowDeclaredAgentValidationErrors,
  normalizeStepModels,
  parseStepModelsEntries,
  selectionValidationErrors,
  stepModelsToEntries,
} = require('../../src/core/agents/selection')

test('parseStepModelsEntries parses repeatable step=model overrides', () => {
  assert.deepEqual(parseStepModelsEntries([
    'review=claude,codex',
    'summarize=codex',
    'cross-review=',
  ]), {
    review: ['claude', 'codex'],
    summarize: ['codex'],
    'cross-review': [],
  })
})

test('applyAgentSelection lets per-step models override global models', () => {
  const flow = {
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'cross-review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'summarize', agents: ['codex'] },
    ],
  }

  const selected = applyAgentSelection(flow, {
    models: ['claude'],
    stepModels: {
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

test('stepModelsToEntries renders command-ready entries', () => {
  assert.deepEqual(stepModelsToEntries(normalizeStepModels({
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

  assert.deepEqual(selectionValidationErrors(flow, { models: ['claude'], stepModels: { summarize: ['codex'] } }), [])
  assert.throws(
    () => assertValidAgentSelection(flow, { models: ['openai'] }),
    /Unknown model "openai" for flow "review"./,
  )
  assert.throws(
    () => assertValidAgentSelection(flow, { stepModels: { summarize: ['claude'] } }),
    /Model "claude" is not configured for step "summarize"/,
  )
})
