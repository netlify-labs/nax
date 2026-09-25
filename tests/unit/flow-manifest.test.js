// Verifies the versioned flow manifest and digest pin exactly what a flow will run.
// Uses real temp flow directories so prompt bytes are read from disk.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { loadFlow } = require('../../src/workflows/catalog/flows')
const { flowDigest, flowManifest } = require('../../src/workflows/catalog/flow-manifest')

/** @param {string} root @param {{ title?: string, prompt?: string }} [options] */
function writeFlow(root, { title = 'One', prompt = '---\ntitle: One\n---\n\nDo the thing.\n' } = {}) {
  const flowDir = path.join(root, 'pinned-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: pinned-flow',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    `    title: ${title}`,
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), prompt)
  return flowDir
}

/** @param {string} root */
async function load(root) {
  return loadFlow('pinned-flow', { flowsDir: root })
}

test('manifest is versioned and hashes prompt bytes per step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-manifest-'))
  writeFlow(root)
  const manifest = flowManifest(await load(root))
  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.flowId, 'pinned-flow')
  assert.equal(manifest.steps[0].id, 'one')
  assert.match(manifest.prompts[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(manifest.prompts[0].stepId, 'one')
})

test('digest is stable for identical content in a different directory', async () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-manifest-a-'))
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-manifest-b-'))
  writeFlow(first)
  writeFlow(second)
  assert.equal(flowDigest(await load(first)), flowDigest(await load(second)))
})

test('digest changes when a prompt file changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-manifest-'))
  const flowDir = writeFlow(root)
  const before = flowDigest(await load(root))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nDo a different thing.\n')
  assert.notEqual(flowDigest(await load(root)), before)
})

test('digest changes when a step definition changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-manifest-'))
  writeFlow(root)
  const before = flowDigest(await load(root))
  writeFlow(root, { title: 'Renamed' })
  assert.notEqual(flowDigest(await load(root)), before)
})
