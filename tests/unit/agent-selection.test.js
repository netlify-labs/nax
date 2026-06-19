const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyAgentSelection,
  normalizeStepModels,
  parseStepModelsEntries,
  stepModelsToEntries,
} = require('../../src/agent-selection')

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
