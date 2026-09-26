// Verifies a plan-started run refuses to start when the loaded flow no longer matches the plan digest.
// Calls the real in-process engine against a temp project flow; no run artifacts may be created.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { handleRunEngine } = require('../../src/cli/main')

test('handleRunEngine rejects a control-plane digest that differs from the loaded flow', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-engine-digest-'))
  const flowDir = path.join(projectRoot, 'flows', 'pinned-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nOne\n')
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: pinned-flow',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))

  await assert.rejects(
    handleRunEngine('pinned-flow', { projectRoot, flowsDir: 'flows', yes: true, force: true, controlPlaneFlowDigest: '0'.repeat(64) }),
    (error) => {
      const coded = /** @type {Error & { code?: string, statusCode?: number }} */ (error)
      assert.equal(coded.code, 'flow_changed_since_plan')
      assert.equal(coded.statusCode, 409)
      return true
    },
  )
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax', 'workflows')), false)
})
