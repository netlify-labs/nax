// Schema normalization tests for the Arena lineup (nax-2rx6.3.1): string-or-object entries
// with fan-out are preserved as `lineup`; `agents` is derived as the back-compat provider list.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const { normalizeLineup, providersFromLineup, normalizeFlow } = require('../../src/workflows/catalog/flows')
const { resolveLineup } = require('../../src/core/agents/instances')

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'multi-instance')

/** Launder a raw (yaml-shaped) flow object to the normalizeFlow input type for typecheck. */
const asFlow = (/** @type {unknown} */ raw) => /** @type {import('../../src/types').WorkflowFlow} */ (raw)

test('normalizeLineup preserves string and object entries', () => {
  const lineup = normalizeLineup([
    'claude',
    { agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] },
    { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', label: 'primary' },
  ])
  assert.equal(lineup[0], 'claude')
  assert.deepEqual(lineup[1], { agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] })
  assert.equal(typeof lineup[2] === 'object' ? lineup[2].label : undefined, 'primary')
})

test('normalizeLineup splits a CSV string into providers', () => {
  assert.deepEqual(normalizeLineup('claude, gemini,codex'), ['claude', 'gemini', 'codex'])
})

test('normalizeLineup rejects an object entry without an agent', () => {
  assert.throws(() => normalizeLineup([{ model: 'claude-opus-5' }]), { code: 'invalid_lineup_entry' })
  assert.throws(() => normalizeLineup([42]), { code: 'invalid_lineup_entry' })
})

test('providersFromLineup derives a deduped, ordered provider list', () => {
  const lineup = [
    { agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] },
    'gemini',
    { agent: 'claude', model: 'latest' },
  ]
  assert.deepEqual(providersFromLineup(lineup), ['claude', 'gemini'])
})

test('bare-string flows are unchanged: agents == lineup', () => {
  const flow = normalizeFlow(asFlow({
    id: 'bare',
    title: 'Bare',
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [{ id: 's', title: 'S', prompt: 'prompts/task.md', agents: ['claude', 'gemini', 'codex'] }],
  }), { id: 'bare', file: 'bare.yml', dir: FIXTURE_DIR, source: { type: 'test' } })
  assert.deepEqual(flow.steps[0].agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps[0].lineup, ['claude', 'gemini', 'codex'])
})

test('object lineup: agents derived, full lineup preserved, and resolvable end-to-end', () => {
  const flow = normalizeFlow(asFlow({
    id: 'obj',
    title: 'Obj',
    defaults: { agents: [{ agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] }] },
    steps: [{
      id: 's', title: 'S', prompt: 'prompts/task.md',
      agents: [
        { agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] },
        { agent: 'codex', model: 'gpt-5.6-sol', efforts: ['medium', 'high'] },
      ],
    }],
  }), { id: 'obj', file: 'obj.yml', dir: FIXTURE_DIR, source: { type: 'test' } })
  // back-compat provider list
  assert.deepEqual(flow.steps[0].agents, ['claude', 'codex'])
  // full lineup preserved for the resolver
  assert.equal(flow.steps[0].lineup.length, 2)
  // and it resolves to the expected instances (4 total)
  const resolved = resolveLineup(flow.steps[0].lineup, { requestedTransport: 'auto' })
  assert.deepEqual(resolved.instances.map((i) => i.id), [
    'claude:claude-opus-5:auto',
    'claude:claude-opus-4-8:auto',
    'codex:gpt-5.6-sol:medium',
    'codex:gpt-5.6-sol:high',
  ])
  assert.equal(resolved.forcedNetlifyApi, true)
})

test('fixture flow.yml files parse to lineups the resolver accepts', () => {
  const dir = path.join(__dirname, '..', 'fixtures', 'multi-instance')
  for (const file of ['bakeoff.flow.yml', 'sweep.flow.yml', 'combo.flow.yml', 'flagship-council.flow.yml', 'clamp.flow.yml']) {
    const raw = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'))
    const lineup = normalizeLineup(raw.steps[0].agents)
    const resolved = resolveLineup(lineup, { requestedTransport: 'auto' })
    assert.ok(resolved.instances.length >= 1, `${file} resolved`)
  }
})

test('flow validation rejects unsupported result routing and lineups above four instances', () => {
  assert.throws(() => normalizeFlow(asFlow({
    id: 'bad-result-routing',
    steps: [
      { id: 'first', prompt: 'prompts/task.md', agents: ['claude'] },
      { id: 'second', prompt: 'prompts/task.md', agents: ['claude'], input: [{ step: 'first', results: 'rivals' }] },
    ],
  }), { id: 'bad-result-routing', file: 'bad.yml', dir: FIXTURE_DIR, source: { type: 'test' } }), /unsupported results mode "rivals"/)

  assert.throws(() => normalizeFlow(asFlow({
    id: 'too-many-instances',
    steps: [{
      id: 'review',
      prompt: 'prompts/task.md',
      agents: [{ agent: 'claude', models: [
        'claude-fable-5',
        'claude-opus-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-haiku-4-5',
      ] }],
    }],
  }), { id: 'too-many-instances', file: 'too-many.yml', dir: FIXTURE_DIR, source: { type: 'test' } }), /at most 4 agent instances/)
})

test('declared follow-up agents produce a structured deprecation notice and are ignored by inheritance', () => {
  const flow = normalizeFlow(asFlow({
    id: 'deprecated-followup-lineup',
    defaults: { agents: ['codex'] },
    steps: [
      { id: 'first', prompt: 'prompts/task.md', agents: ['claude'] },
      {
        id: 'continue',
        prompt: 'prompts/task.md',
        submit: 'follow-up',
        agents: ['gemini'],
        input: [{ step: 'first', results: 'all' }],
      },
    ],
  }), {
    id: 'deprecated-followup-lineup',
    file: 'deprecated-followup-lineup.yml',
    dir: FIXTURE_DIR,
    source: { type: 'test' },
  })

  assert.equal(flow.steps[1].lineupDeclared, true)
  assert.deepEqual(flow.warnings, [{
    stepId: 'continue',
    code: 'deprecated_followup_lineup',
    message: 'Step "continue" declares agents even though follow-up steps inherit their lineup from the first input step. The declaration is ignored.',
    hint: 'Remove agents from this follow-up step.',
  }])
})

test('bundled follow-up steps omit their own lineup declarations', async () => {
  const { loadFlow } = require('../../src/workflows/catalog/flows')
  const review = await loadFlow('review')
  const ideas = await loadFlow('ideas')
  assert.equal(review.steps.find((step) => step.id === 'cross-review').lineupDeclared, false)
  assert.deepEqual(review.steps.find((step) => step.id === 'cross-review').input, [{ step: 'review', results: 'peers' }])
  assert.equal(ideas.steps.find((step) => step.id === 'cross-score').lineupDeclared, false)
  assert.equal(ideas.steps.find((step) => step.id === 'react').lineupDeclared, false)
  assert.equal(review.warnings, undefined)
  assert.equal(ideas.warnings, undefined)
})
