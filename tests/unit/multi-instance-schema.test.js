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

test('normalizeLineup preserves string and object entries', () => {
  const lineup = normalizeLineup([
    'claude',
    { agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] },
    { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', label: 'primary' },
  ])
  assert.equal(lineup[0], 'claude')
  assert.deepEqual(lineup[1], { agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] })
  assert.equal(lineup[2].label, 'primary')
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
  const flow = normalizeFlow({
    id: 'bare',
    title: 'Bare',
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [{ id: 's', title: 'S', prompt: 'prompts/task.md', agents: ['claude', 'gemini', 'codex'] }],
  }, { file: 'bare.yml', dir: FIXTURE_DIR, source: { type: 'test' } })
  assert.deepEqual(flow.steps[0].agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(flow.steps[0].lineup, ['claude', 'gemini', 'codex'])
})

test('object lineup: agents derived, full lineup preserved, and resolvable end-to-end', () => {
  const flow = normalizeFlow({
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
  }, { file: 'obj.yml', dir: FIXTURE_DIR, source: { type: 'test' } })
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
