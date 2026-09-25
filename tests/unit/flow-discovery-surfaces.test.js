// Verifies list surfaces keep working with a broken flow present and report it separately.
// Runs the real CLI as a subprocess and the real local dashboard workflow store.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { createLocalWorkflowStore } = require('../../src/dashboard/storage/local-workflows')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
const FLOWS_DIR = 'custom/flows'

/** @param {string} projectRoot @param {string} id @param {{ broken?: boolean }} [options] */
function writeFlow(projectRoot, id, { broken = false } = {}) {
  const flowDir = path.join(projectRoot, FLOWS_DIR, id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    `title: ${id}`,
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    title: One',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  if (!broken) fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nPrompt body\n')
}

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-surfaces-'))
  writeFlow(projectRoot, 'good-flow')
  writeFlow(projectRoot, 'broken-flow', { broken: true })
  return projectRoot
}

test('nax list --json excludes a broken flow from stdout and names it on stderr', () => {
  const projectRoot = makeProject()
  const result = spawnSync(process.execPath, [NAX_BIN, 'list', '--json', '--project-root', projectRoot, '--flows-dir', FLOWS_DIR], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  const ids = payload.items.map((/** @type {{ id: string }} */ item) => item.id)
  assert.ok(ids.includes('good-flow'))
  assert.ok(ids.includes('review'))
  assert.ok(!ids.includes('broken-flow'))
  assert.match(result.stderr, /Skipping flow "broken-flow": 1 error\. Run: nax lint broken-flow/)
})

test('dashboard listWorkflows returns runnable items plus invalid summaries', async () => {
  const projectRoot = makeProject()
  const store = createLocalWorkflowStore({ projectRoot, flowsDirs: [FLOWS_DIR] })
  const payload = await store.listWorkflows()
  assert.ok(payload.items.some((item) => item.id === 'good-flow'))
  assert.ok(!payload.items.some((item) => item.id === 'broken-flow'))
  const broken = payload.invalid.find((entry) => entry.id === 'broken-flow')
  assert.equal(broken?.invalid, true)
  assert.equal(broken?.errorCount, 1)
  assert.equal(broken?.diagnostics[0].code, 'missing_prompt_file')
})
