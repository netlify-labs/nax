// Verifies flow discovery isolates broken flows without breaking or unshadowing others.
// Uses real temp project flow directories across two prioritized sources plus the bundled flows.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { discoverFlowEntries, listFlows, loadFlow } = require('../../src/workflows/catalog/flows')

const HIGH = 'high/flows'
const LOW = 'low/flows'

/** @param {string} projectRoot @param {string} flowsDir @param {string} dirName @param {{ id?: string, title?: string, extra?: string[], disabled?: boolean }} [options] */
function writeFlow(projectRoot, flowsDir, dirName, { id = dirName, title = dirName, extra = [], disabled = false } = {}) {
  const flowDir = path.join(projectRoot, flowsDir, dirName)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    `title: ${title}`,
    ...(disabled ? ['disabled: true'] : []),
    ...extra,
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    title: One',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nPrompt body\n')
  return flowDir
}

/** Writes a flow whose only step points at a missing prompt file (validation error). */
function writeInvalidFlow(projectRoot, flowsDir, dirName) {
  const flowDir = writeFlow(projectRoot, flowsDir, dirName)
  fs.rmSync(path.join(flowDir, 'prompts', 'one.md'))
  return flowDir
}

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-discovery-'))
  return { projectRoot, options: { projectRoot, flowsDirs: [HIGH, LOW] } }
}

/** @param {unknown} error */
function asCoded(error) {
  assert.ok(error instanceof Error)
  return /** @type {Error & { code?: string, details?: { flowId?: string, diagnostics?: Array<{ code: string }> } }} */ (error)
}

test('valid and invalid siblings: listFlows keeps the valid flow and loadFlow still works', async () => {
  const { projectRoot, options } = makeProject()
  writeFlow(projectRoot, HIGH, 'good-flow')
  writeInvalidFlow(projectRoot, HIGH, 'broken-flow')

  const ids = (await listFlows(options)).map((flow) => flow.id)
  assert.ok(ids.includes('good-flow'))
  assert.ok(!ids.includes('broken-flow'))
  assert.equal((await loadFlow('good-flow', options)).id, 'good-flow')
})

test('an invalid high-priority override shadows the valid lower-priority flow', async () => {
  const { projectRoot, options } = makeProject()
  writeInvalidFlow(projectRoot, HIGH, 'shared-flow')
  writeFlow(projectRoot, LOW, 'shared-flow', { title: 'Lower Priority' })

  await assert.rejects(loadFlow('shared-flow', options), (error) => {
    const coded = asCoded(error)
    assert.equal(coded.code, 'invalid_flow')
    assert.equal(coded.details?.flowId, 'shared-flow')
    assert.ok(coded.details?.diagnostics?.some((diagnostic) => diagnostic.code === 'missing_prompt_file'))
    return true
  })
  const listed = (await listFlows(options)).find((flow) => flow.id === 'shared-flow')
  assert.equal(listed, undefined)
})

test('a load-failed high-priority directory shadows a lower flow by directory name', async () => {
  const { projectRoot, options } = makeProject()
  const flowDir = path.join(projectRoot, HIGH, 'shared-flow')
  fs.mkdirSync(flowDir, { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), 'id: shared-flow\nsteps: [\n  - broken yaml')
  writeFlow(projectRoot, LOW, 'shared-flow')

  const entries = await discoverFlowEntries(options)
  const entry = entries.find((candidate) => candidate.id === 'shared-flow')
  assert.equal(entry?.status, 'load-failed')
  assert.equal(entry?.status === 'load-failed' && entry.loadError.code, 'flow_load_failed')
  assert.equal(entry?.shadowed.length, 1)
  await assert.rejects(loadFlow('shared-flow', options), (error) => asCoded(error).code === 'flow_load_failed')
})

test('raw.id different from the directory name groups by raw.id with a flow_id_mismatch warning', async () => {
  const { projectRoot, options } = makeProject()
  writeFlow(projectRoot, HIGH, 'dir-name', { id: 'declared-id' })

  const entries = await discoverFlowEntries(options)
  const entry = entries.find((candidate) => candidate.id === 'declared-id')
  assert.equal(entry?.status, 'valid')
  const warnings = entry?.status === 'valid' ? entry.flow.warnings || [] : []
  assert.ok(warnings.some((warning) => warning.code === 'flow_id_mismatch'))
  assert.equal(entries.find((candidate) => candidate.id === 'dir-name'), undefined)
})

test('a disabled high-priority flow does not shadow the lower-priority flow', async () => {
  const { projectRoot, options } = makeProject()
  writeFlow(projectRoot, HIGH, 'shared-flow', { disabled: true, title: 'Disabled High' })
  writeFlow(projectRoot, LOW, 'shared-flow', { title: 'Enabled Low' })

  const flow = await loadFlow('shared-flow', options)
  assert.equal(flow.title, 'Enabled Low')
})

test('a normalizeFlow pre-validation throw becomes an invalid entry with one diagnostic', async () => {
  const { projectRoot, options } = makeProject()
  writeFlow(projectRoot, HIGH, 'wrapper-flow', { extra: ['defaults_placeholder: true'] })
  const flowFile = path.join(projectRoot, HIGH, 'wrapper-flow', 'flow.yml')
  fs.writeFileSync(flowFile, fs.readFileSync(flowFile, 'utf8').replace('defaults:\n', 'defaults:\n  agentConfig: {}\n'))

  const entries = await discoverFlowEntries(options)
  const entry = entries.find((candidate) => candidate.id === 'wrapper-flow')
  assert.equal(entry?.status, 'invalid')
  const errors = entry?.status === 'invalid' ? entry.validation.errors : []
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'invalid_agent_config_wrapper')
})

test('Unknown flow errors list valid ids and invalid ids separately', async () => {
  const { projectRoot, options } = makeProject()
  writeFlow(projectRoot, HIGH, 'good-flow')
  writeInvalidFlow(projectRoot, HIGH, 'broken-flow')

  await assert.rejects(loadFlow('missing-flow', options), (error) => {
    const message = asCoded(error).message
    assert.match(message, /Unknown flow "missing-flow"/)
    assert.match(message, /Available flows: .*good-flow/)
    assert.match(message, /Invalid flows: broken-flow/)
    return true
  })
})
