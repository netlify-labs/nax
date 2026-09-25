// Verifies the flow validator catches guaranteed runtime failures and surfaces lineup warnings.
// Builds real temp flow directories and reads diagnostics from discovery entries.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { discoverFlowEntries } = require('../../src/workflows/catalog/flows')

/**
 * @param {string[]} flowLines
 * @param {Record<string, string>} [prompts]
 */
async function validationFor(flowLines, prompts = { 'one.md': '---\ntitle: One\n---\n\nOne\n', 'two.md': '---\ntitle: Two\n---\n\nTwo\n' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-checks-'))
  const flowDir = path.join(tmp, 'check-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  for (const [name, body] of Object.entries(prompts)) fs.writeFileSync(path.join(flowDir, 'prompts', name), body)
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), ['id: check-flow', ...flowLines, ''].join('\n'))
  const entries = await discoverFlowEntries({ flowsDir: tmp })
  const entry = entries.find((candidate) => candidate.id === 'check-flow')
  assert.ok(entry, 'check-flow entry should be discovered')
  return entry.validation
}

/** @param {Array<{ code: string }>} diagnostics @param {string} code */
function only(diagnostics, code) {
  const matches = diagnostics.filter((diagnostic) => diagnostic.code === code)
  assert.equal(matches.length, 1, `expected exactly one ${code}, got ${JSON.stringify(diagnostics)}`)
  return /** @type {{ code: string, stepId: string, hint: string }} */ (matches[0])
}

const TWO_STEPS_HEAD = [
  'defaults:',
  '  agents: [codex]',
  'steps:',
  '  - id: one',
  '    prompt: prompts/one.md',
]

test('followup_without_input: follow-up step with no input step is an error with a hint', async () => {
  const validation = await validationFor([
    ...TWO_STEPS_HEAD,
    '  - id: two',
    '    prompt: prompts/two.md',
    '    submit: follow-up',
    '    action: comment',
  ])
  const diagnostic = only(validation.errors, 'followup_without_input')
  assert.equal(diagnostic.stepId, 'two')
  assert.match(diagnostic.hint, /input: \[\{ step:/)
})

test('followup_source_not_agent_step: follow-up sourced from a human-review step is an error', async () => {
  const validation = await validationFor([
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: gate',
    '    action: human-review',
    '    submit: human-review',
    '    waitFor: human-review',
    '  - id: two',
    '    prompt: prompts/two.md',
    '    submit: follow-up',
    '    action: comment',
    '    input:',
    '      - step: gate',
  ])
  assert.equal(only(validation.errors, 'followup_source_not_agent_step').stepId, 'two')
})

test('a follow-up of a follow-up stays valid', async () => {
  const validation = await validationFor([
    ...TWO_STEPS_HEAD,
    '  - id: two',
    '    prompt: prompts/two.md',
    '    submit: follow-up',
    '    action: comment',
    '    input:',
    '      - step: one',
    '  - id: three',
    '    prompt: prompts/two.md',
    '    submit: follow-up',
    '    action: comment',
    '    input:',
    '      - step: two',
  ])
  assert.deepEqual(validation.errors, [])
})

test('invalid_default_transport: unknown defaults.transport is an error', async () => {
  const validation = await validationFor([
    'defaults:',
    '  agents: [codex]',
    '  transport: carrier-pigeon',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
  ])
  const diagnostic = only(validation.errors, 'invalid_default_transport')
  assert.match(diagnostic.hint, /netlify-api/)
})

test('transport_lineup_conflict: github transport with a pinned model is an error at load time', async () => {
  const validation = await validationFor([
    'defaults:',
    '  agents: [codex]',
    '  transport: github',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
    '    models:',
    '      codex: gpt-5.4-mini',
  ])
  assert.equal(only(validation.errors, 'transport_lineup_conflict').stepId, 'one')
})

test('empty_prompt_file is a warning, not an error', async () => {
  const validation = await validationFor([...TWO_STEPS_HEAD], { 'one.md': '   \n\n' })
  assert.deepEqual(validation.errors, [])
  assert.equal(only(validation.warnings, 'empty_prompt_file').stepId, 'one')
})

test('unused_prompt_file warns about prompt files no step references', async () => {
  const validation = await validationFor([...TWO_STEPS_HEAD])
  const diagnostic = only(validation.warnings, 'unused_prompt_file')
  assert.match(diagnostic.hint, /two\.md/)
})

test('catalog_passthrough warning is carried for an unknown model id', async () => {
  const validation = await validationFor([
    ...TWO_STEPS_HEAD,
    '    models:',
    '      codex: made-up-model-x',
  ], { 'one.md': '---\ntitle: One\n---\n\nOne\n' })
  assert.deepEqual(validation.errors, [])
  assert.equal(only(validation.warnings, 'catalog_passthrough').stepId, 'one')
})

test('printFlowPlan prints a carried lineup warning once', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-plan-warn-'))
  const flowDir = path.join(tmp, 'warn-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nOne\n')
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: warn-flow',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
    '    models:',
    '      codex: made-up-model-x',
    '',
  ].join('\n'))
  const { loadFlow } = require('../../src/workflows/catalog/flows')
  const { printFlowPlan } = require('../../src/cli/main')
  const flow = await loadFlow('warn-flow', { flowsDir: tmp })
  const lines = []
  const originalLog = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    printFlowPlan({ flow, steps: flow.steps, transport: 'netlify-api', branch: 'main', context: '', options: {} })
  } finally {
    console.log = originalLog
  }
  const output = lines.join('\n')
  const occurrences = output.split('made-up-model-x" is not in NAX').length - 1
  assert.equal(occurrences, 1, output)
})
