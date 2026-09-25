// Verifies `nax handoff --to beads` creates severity-mapped beads idempotently via external refs.
// Runs the real CLI as a subprocess with a fake `br` executable prefixed on PATH (process boundary only).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
const FAKE_BIN = path.join(__dirname, '..', 'fixtures', 'bin')
const RUN_ID = '2026-09-25T12-00-00-000Z-review'
const synthesizeText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'findings', 'synthesize-7-findings.md'), 'utf8')

/** @param {{ beads?: boolean }} [options] */
function project({ beads = true } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-handoff-beads-'))
  if (beads) fs.mkdirSync(path.join(projectRoot, '.beads'))
  const dir = path.join(projectRoot, '.nax', 'workflows', RUN_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId: RUN_ID,
    flowId: 'review',
    status: 'completed',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
    flow: { id: 'review', title: 'Review', findings: { step: 'synthesize', adapter: 'review-consensus' }, steps: [{ id: 'synthesize', agents: ['codex'] }] },
    steps: [{ id: 'synthesize', runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', resultText: synthesizeText }] }],
  }))
  return { projectRoot, statePath: path.join(projectRoot, 'fake-br-state.json') }
}

/** @param {ReturnType<typeof project>} fixture @param {string[]} args @param {Record<string, string>} [env] */
function handoff(fixture, args, env = {}) {
  return spawnSync(process.execPath, [NAX_BIN, 'handoff', '--to', 'beads', '--project-root', fixture.projectRoot, ...args], {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_BR_STATE: fixture.statePath, ...env },
  })
}

test('creates beads with severity-mapped type, priority, labels and external refs; rerun creates none', () => {
  const fixture = project()
  const first = handoff(fixture, ['--limit', '3', '--force', '--json'])
  assert.equal(first.status, 0, first.stderr)
  assert.equal(JSON.parse(first.stdout).applied.length, 3)
  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'))
  assert.equal(state.issues.length, 3)
  const [bead] = state.issues
  assert.equal(bead.external_ref, `nax:${RUN_ID}/synthesize/S1`)
  assert.ok(bead.labels.includes('nax-finding'))
  assert.ok(['bug', 'task'].includes(bead.type))
  assert.ok(Number.isInteger(bead.priority) && bead.priority >= 0 && bead.priority <= 4)
  assert.match(bead.description, /### Claim/)

  const second = handoff(fixture, ['--limit', '3', '--force', '--json'])
  assert.equal(second.status, 0, second.stderr)
  const rerun = JSON.parse(second.stdout)
  assert.equal(rerun.applied.length, 0)
  assert.equal(rerun.skipped.length, 3)
})

test('fails with guidance when the project has no .beads workspace', () => {
  const fixture = project({ beads: false })
  const result = handoff(fixture, ['--limit', '1', '--force'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No \.beads workspace/)
})

test('fails with guidance when br is not installed', () => {
  const fixture = project()
  const result = spawnSync(process.execPath, [NAX_BIN, 'handoff', '--to', 'beads', '--project-root', fixture.projectRoot, '--limit', '1', '--force'], {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: path.dirname(process.execPath) },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /br \(beads_rust\) was not found on PATH/)
})
