const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { DEFAULT_PROJECT_FLOWS_DIRS, FLOW_PICKER_ORDER, listFlows, loadFlow, loadStepPrompt, projectFlowDirs, validateFlowStructure } = require('../../src/flows')

/**
 * @typedef {Error & { code?: string, validation?: { errors: Array<{ code: string }> } }} FlowError
 */

/** @param {unknown} error @returns {FlowError} */
function flowError(error) {
  assert.ok(error instanceof Error)
  return /** @type {FlowError} */ (error)
}

/** @param {string} projectRoot @param {string} flowsDir @param {string} id @param {Record<string, string>} param3 */
function writeFlow(projectRoot, flowsDir, id, { title = id, description = '', promptBody = 'Prompt body' } = {}) {
  const flowDir = path.join(projectRoot, flowsDir, id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    `title: ${title}`,
    description ? `description: ${description}` : '',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    title: One',
    '    prompt: prompts/one.md',
    '',
  ].filter((line) => line !== '').join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), `---\ntitle: One Prompt\n---\n\n${promptBody}\n`)
  return flowDir
}

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
  assert.equal(flow.steps[0].autoArchive, null)
  assert.equal(flow.steps[0].isArchivable, true)
})

test('listFlows discovers flow directories', async () => {
  const flows = await listFlows()
  const ids = flows.map((flow) => flow.id)
  for (const id of [
    'review',
    'long-descriptions',
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

test('listFlows discovers project workflows before bundled workflows', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-project-'))
  writeFlow(projectRoot, DEFAULT_PROJECT_FLOWS_DIRS[0], 'conversion-audit', {
    title: 'Conversion Audit',
    description: 'Project conversion review',
  })

  const flows = await listFlows({ projectRoot })
  assert.equal(flows[0].id, 'conversion-audit')
  assert.equal(flows[0].source, 'project')
  assert.equal(flows[0].sourceLabel, 'project .github/nax-flows')
  assert.ok(flows.some((flow) => flow.id === 'review' && flow.source === 'bundled'))
})

test('loadFlow uses nax.config.json flowsDirs and project flows shadow bundled flows', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-config-'))
  fs.writeFileSync(path.join(projectRoot, 'nax.config.json'), JSON.stringify({
    flowsDirs: ['tools/nax/flows', '.github/nax-flows'],
  }, null, 2))
  writeFlow(projectRoot, 'tools/nax/flows', 'review', {
    title: 'Project Review',
    promptBody: 'Project review prompt',
  })
  writeFlow(projectRoot, '.github/nax-flows', 'release-readiness', {
    title: 'Release Readiness',
  })

  const dirs = await projectFlowDirs({ projectRoot })
  assert.deepEqual(dirs.map((dir) => path.relative(projectRoot, dir)), ['tools/nax/flows', '.github/nax-flows'])

  const flow = await loadFlow('review', { projectRoot })
  assert.equal(flow.title, 'Project Review')
  assert.equal(flow.source, 'project')
  assert.equal(flow.sourceLabel, 'project tools/nax/flows')
  assert.equal(loadStepPrompt(flow, flow.steps[0]).body.trim(), 'Project review prompt')

  const flows = await listFlows({ projectRoot })
  assert.equal(flows.filter((candidate) => candidate.id === 'review').length, 1)
  assert.equal(flows.find((candidate) => candidate.id === 'release-readiness').sourceLabel, 'project .github/nax-flows')
})

test('loadFlow uses JavaScript nax config files', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-js-config-'))
  fs.writeFileSync(path.join(projectRoot, 'nax.config.js'), [
    'module.exports = {',
    '  flowsDirs: ["tools/nax/flows"],',
    '}',
    '',
  ].join('\n'))
  writeFlow(projectRoot, 'tools/nax/flows', 'js-config-flow', {
    title: 'JS Config Flow',
  })

  const dirs = await projectFlowDirs({ projectRoot })
  assert.deepEqual(dirs.map((dir) => path.relative(projectRoot, dir)), ['tools/nax/flows'])

  const flow = await loadFlow('js-config-flow', { projectRoot })
  assert.equal(flow.title, 'JS Config Flow')
  assert.equal(flow.sourceLabel, 'project tools/nax/flows')
})

test('loadFlow accepts explicit project workflow directories', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-explicit-'))
  writeFlow(projectRoot, 'agent/flows', 'custom-flow', {
    title: 'Custom Flow',
  })

  const flow = await loadFlow('custom-flow', { projectRoot, flowsDir: 'agent/flows' })
  assert.equal(flow.title, 'Custom Flow')
  assert.equal(flow.sourceLabel, 'project agent/flows')
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

test('loadFlow accepts toml flow files through configorama', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'toml-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.toml'), [
    'id = "toml-flow"',
    'title = "TOML Flow"',
    '',
    '[[steps]]',
    'id = "one"',
    'prompt = "prompts/one.md"',
    'agents = ["codex"]',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nBody\n')

  const flow = await loadFlow('toml-flow', { flowsDir: tmp })
  assert.equal(flow.id, 'toml-flow')
  assert.equal(flow.title, 'TOML Flow')
  assert.equal(flow.steps[0].id, 'one')
  assert.equal(loadStepPrompt(flow, flow.steps[0]).title, 'One')
})

test('loadFlow accepts JavaScript flow files through configorama', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'js-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.js'), [
    'module.exports = {',
    '  id: "js-flow",',
    '  title: "JavaScript Flow",',
    '  steps: [{ id: "one", prompt: "prompts/one.md", agents: ["codex"] }],',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nBody\n')

  const flow = await loadFlow('js-flow', { flowsDir: tmp })
  assert.equal(flow.id, 'js-flow')
  assert.equal(flow.title, 'JavaScript Flow')
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

test('validateFlowStructure accepts a valid bundled resolved flow', async () => {
  const flow = await loadFlow('error-handling')
  assert.deepEqual(validateFlowStructure(flow), { errors: [], warnings: [] })
})

test('loadFlow rejects missing prompt files with the resolved path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'missing-prompt')
  fs.mkdirSync(flowDir, { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: missing-prompt',
    'steps:',
    '  - id: one',
    '    prompt: prompts/missing.md',
    '    agents: [codex]',
    '',
  ].join('\n'))

  await assert.rejects(
    () => loadFlow('missing-prompt', { flowsDir: tmp }),
    (error) => {
      const err = flowError(error)
      assert.equal(err.code, 'invalid_flow')
      assert.match(err.message, /step "one": Step "one" prompt file does not exist:/)
      assert.match(err.message, new RegExp(path.join(flowDir, 'prompts', 'missing.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    },
  )
})

test('loadFlow rejects bad input step references', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'bad-inputs')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nOne\n')
  fs.writeFileSync(path.join(flowDir, 'prompts', 'two.md'), '---\ntitle: Two\n---\n\nTwo\n')
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: bad-inputs',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
    '    agents: [codex]',
    '    input:',
    '      - step: two',
    '      - step: missing',
    '  - id: two',
    '    prompt: prompts/two.md',
    '    agents: [codex]',
    '    input:',
    '      - step: two',
    '',
  ].join('\n'))

  await assert.rejects(
    () => loadFlow('bad-inputs', { flowsDir: tmp }),
    (error) => {
      const err = flowError(error)
      assert.match(err.message, /Step "one" references later input step "two"/)
      assert.match(err.message, /Step "one" references unknown input step "missing"/)
      assert.match(err.message, /Step "two" cannot use itself as an input source/)
      return true
    },
  )
})

test('loadFlow rejects invalid action and submit modes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'bad-enums')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nOne\n')
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: bad-enums',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
    '    action: bogus',
    '    submit: sideways',
    '    agents: [codex]',
    '',
  ].join('\n'))

  await assert.rejects(
    () => loadFlow('bad-enums', { flowsDir: tmp }),
    (error) => {
      const err = flowError(error)
      assert.match(err.message, /unsupported action "bogus"/)
      assert.match(err.message, /Allowed actions: "issue", "comment"/)
      assert.match(err.message, /unsupported submit "sideways"/)
      assert.match(err.message, /Allowed submit modes: "new-run", "follow-up"/)
      return true
    },
  )
})

test('flow validation returns multiple diagnostics together', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-test-'))
  const flowDir = path.join(tmp, 'many-errors')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'prompts', 'two.md'), '---\ntitle: Two\n---\n\nTwo\n')
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: many-errors',
    'steps:',
    '  - id: one',
    '    prompt: prompts/missing.md',
    '    action: bogus',
    '    submit: sideways',
    '    waitFor: submitted',
    '    agents: [codex]',
    '    input:',
    '      - step: two',
    '  - id: two',
    '    prompt: prompts/two.md',
    '    agents: [codex]',
    '',
  ].join('\n'))

  await assert.rejects(
    () => loadFlow('many-errors', { flowsDir: tmp }),
    (error) => {
      const err = flowError(error)
      assert.ok(err.validation)
      const codes = err.validation.errors.map((item) => item.code)
      assert.ok(codes.includes('missing_prompt_file'))
      assert.ok(codes.includes('invalid_action'))
      assert.ok(codes.includes('invalid_submit'))
      assert.ok(codes.includes('invalid_wait_for'))
      assert.ok(codes.includes('future_input_step'))
      return true
    },
  )
})
