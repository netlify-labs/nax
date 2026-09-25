// Verifies `nax lint` reports every flow defect in one pass with stable JSON and exit codes.
// Runs the real CLI as a subprocess against temp project flow directories.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
const FLOWS_DIR = 'custom/flows'

/** @param {string} projectRoot @param {string} id @param {{ prompt?: string | null, extraPrompt?: boolean }} [options] */
function writeFlow(projectRoot, id, { prompt = '---\ntitle: One\n---\n\nOne\n', extraPrompt = false } = {}) {
  const flowDir = path.join(projectRoot, FLOWS_DIR, id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  if (prompt !== null) fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), prompt)
  if (extraPrompt) fs.writeFileSync(path.join(flowDir, 'prompts', 'leftover.md'), 'unused\n')
}

/** @param {string} projectRoot @param {string[]} args */
function lint(projectRoot, args) {
  return spawnSync(process.execPath, [NAX_BIN, 'lint', ...args, '--project-root', projectRoot, '--flows-dir', FLOWS_DIR], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
}

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-lint-'))
  writeFlow(projectRoot, 'good-flow')
  writeFlow(projectRoot, 'broken-flow', { prompt: null })
  writeFlow(projectRoot, 'warn-flow', { extraPrompt: true })
  return projectRoot
}

test('nax lint <valid> --json exits 0 with a valid entry', () => {
  const projectRoot = makeProject()
  const result = lint(projectRoot, ['good-flow', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.flows.length, 1)
  assert.equal(payload.flows[0].id, 'good-flow')
  assert.equal(payload.flows[0].status, 'valid')
  assert.deepEqual(payload.flows[0].errors, [])
  assert.deepEqual(payload.summary, { total: 1, invalid: 0, warnings: 0 })
})

test('nax lint <broken> --json exits 1 and lists every diagnostic', () => {
  const projectRoot = makeProject()
  const result = lint(projectRoot, ['broken-flow', 'good-flow', '--json'])
  assert.equal(result.status, 1)
  const payload = JSON.parse(result.stdout)
  const broken = payload.flows.find((/** @type {{ id: string }} */ flow) => flow.id === 'broken-flow')
  assert.equal(broken.status, 'invalid')
  assert.equal(broken.errors[0].code, 'missing_prompt_file')
  assert.equal(payload.summary.invalid, 1)
})

test('warnings pass by default and fail with --strict', () => {
  const projectRoot = makeProject()
  assert.equal(lint(projectRoot, ['warn-flow', '--json']).status, 0)
  const strict = lint(projectRoot, ['warn-flow', '--json', '--strict'])
  assert.equal(strict.status, 1)
  assert.equal(JSON.parse(strict.stdout).summary.warnings, 1)
})

test('human output marks each flow and prints fix hints', () => {
  const projectRoot = makeProject()
  const result = lint(projectRoot, ['broken-flow', 'good-flow'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /✔ good-flow/)
  assert.match(result.stdout, /✖ broken-flow \(1 error, 0 warnings\)/)
  assert.match(result.stdout, /steps\[0\] one missing_prompt_file:/)
  assert.match(result.stdout, /fix: Create the prompt file/)
})

test('an unknown flow id is reported and exits 1', () => {
  const projectRoot = makeProject()
  const result = lint(projectRoot, ['no-such-flow', '--json'])
  assert.equal(result.status, 1)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.flows[0].status, 'unknown')
  assert.equal(payload.flows[0].errors[0].code, 'unknown_flow')
})

test('nax lint with no flow ids lints every discovered flow including bundled ones', () => {
  const projectRoot = makeProject()
  const result = lint(projectRoot, ['--json'])
  const payload = JSON.parse(result.stdout)
  const ids = payload.flows.map((/** @type {{ id: string }} */ flow) => flow.id)
  assert.ok(ids.includes('good-flow'))
  assert.ok(ids.includes('broken-flow'))
  assert.ok(ids.includes('review'))
  assert.equal(result.status, 1)
})
