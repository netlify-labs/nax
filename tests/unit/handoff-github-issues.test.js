// Verifies `nax handoff --to github-issues` selection, planning, idempotency and partial-failure behavior.
// Runs the real CLI as a subprocess with a fake `gh` executable prefixed on PATH (process boundary only).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { candidateFindings, defaultPreselection, selectFindings } = require('../../src/workflows/handoff-targets')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
const FAKE_BIN = path.join(__dirname, '..', 'fixtures', 'bin')
const RUN_ID = '2026-09-25T12-00-00-000Z-review'
const synthesizeText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'findings', 'synthesize-7-findings.md'), 'utf8')

function project() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-handoff-issues-'))
  const dir = path.join(projectRoot, '.nax', 'workflows', RUN_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId: RUN_ID,
    flowId: 'review',
    status: 'completed',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
    target: { branch: 'main', sha: 'e'.repeat(40) },
    flow: { id: 'review', title: 'Review', findings: { step: 'synthesize', adapter: 'review-consensus' }, steps: [{ id: 'synthesize', agents: ['codex'] }] },
    steps: [{ id: 'synthesize', runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', resultText: synthesizeText }] }],
  }))
  const statePath = path.join(projectRoot, 'fake-gh-state.json')
  const logPath = path.join(projectRoot, 'fake-gh.log')
  return { projectRoot, statePath, logPath }
}

/** @param {ReturnType<typeof project>} fixture @param {string[]} args @param {Record<string, string>} [env] */
function handoff(fixture, args, env = {}) {
  return spawnSync(process.execPath, [NAX_BIN, 'handoff', '--to', 'github-issues', '--repo', 'example-org/example-repo', '--project-root', fixture.projectRoot, ...args], {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: fixture.statePath, FAKE_GH_LOG: fixture.logPath, ...env },
  })
}

/** @param {ReturnType<typeof project>} fixture */
function ghState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'))
}

/** @param {Array<Partial<import('../../src/workflows/findings').Finding>>} items */
function findings(items) {
  return /** @type {import('../../src/workflows/findings').Finding[]} */ (items.map((item, index) => ({ localId: `S${index + 1}`, rank: index + 1, bucket: 'consensus', severity: 'high', status: 'open', ...item })))
}

test('selection filters by bucket, status and severity, and preselects the top five', () => {
  const list = findings([
    {}, { severity: 'low' }, { status: 'dropped' }, { bucket: 'contested', rank: null }, {}, {}, {}, {},
  ])
  assert.deepEqual(candidateFindings(list, { minSeverity: 'medium' }).map((finding) => finding.localId), ['S1', 'S5', 'S6', 'S7', 'S8'])
  assert.ok(candidateFindings(list, { includeContested: true }).some((finding) => finding.localId === 'S4'))
  assert.ok(candidateFindings(list, { includeRejected: true }).some((finding) => finding.localId === 'S3'))
  assert.deepEqual(defaultPreselection(candidateFindings(list)).map((finding) => finding.localId), ['S1', 'S2', 'S5'])
  assert.deepEqual(selectFindings(list, { limit: 2 }).selected.map((finding) => finding.localId), ['S1', 'S2'])
  assert.deepEqual(selectFindings(list, { select: ['S3', 'S9'] }).unknown, ['S9'])
})

test('without a terminal, --to needs --select or --limit', () => {
  const fixture = project()
  const result = handoff(fixture, [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /needs --select <ids> or --limit <n>/)
})

test('--dry prints the plan and creates nothing', () => {
  const fixture = project()
  const result = handoff(fixture, ['--limit', '2', '--dry'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Plan for github-issues/)
  assert.equal((result.stdout.match(/^\s+create\s/gm) || []).length, 2)
  const created = fs.existsSync(fixture.statePath) ? ghState(fixture).issues : []
  assert.equal(created.length, 0)
})

test('non-interactive apply requires --force', () => {
  const fixture = project()
  const result = handoff(fixture, ['--limit', '2'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Re-run with --force/)
})

test('creates labeled issues with markers and a rerun creates none', () => {
  const fixture = project()
  const first = handoff(fixture, ['--limit', '3', '--force', '--label', 'triage', '--json'])
  assert.equal(first.status, 0, first.stderr)
  const payload = JSON.parse(first.stdout)
  assert.equal(payload.applied.length, 3)
  const issues = ghState(fixture).issues
  assert.equal(issues.length, 3)
  assert.ok(issues[0].labels.includes('nax-finding'))
  assert.ok(issues[0].labels.some((/** @type {string} */ label) => label.startsWith('severity:')))
  assert.ok(issues[0].labels.includes('triage'))
  assert.match(issues[0].body, new RegExp(`<!-- nax-finding:${RUN_ID}/synthesize/S1 -->`))
  assert.match(issues[0].body, /blob\/e{40}\//)

  const second = handoff(fixture, ['--limit', '3', '--force', '--json'])
  assert.equal(second.status, 0, second.stderr)
  const rerun = JSON.parse(second.stdout)
  assert.equal(rerun.applied.length, 0)
  assert.equal(rerun.skipped.length, 3)
  assert.equal(ghState(fixture).issues.length, 3)
})

test('a label that cannot be created is warned about and the issue is still created', () => {
  const fixture = project()
  const result = handoff(fixture, ['--select', 'S1', '--force', '--label', 'broken-label'], { FAKE_GH_FAIL_LABELS: 'broken-label' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Label "broken-label" could not be created/)
  const [issue] = ghState(fixture).issues
  assert.ok(!issue.labels.includes('broken-label'))
})

test('a failure mid-list stops, reports what was created, and a rerun finishes the rest', () => {
  const fixture = project()
  const secondTitle = spawnSync(process.execPath, [NAX_BIN, 'handoff', '--findings', '--json', '--project-root', fixture.projectRoot], { encoding: 'utf8' })
  const titles = JSON.parse(secondTitle.stdout).findings.filter((/** @type {{ bucket: string }} */ finding) => finding.bucket === 'consensus').map((/** @type {{ title: string }} */ finding) => finding.title)
  const failing = handoff(fixture, ['--limit', '3', '--force'], { FAKE_GH_FAIL_TITLE: titles[1] })
  assert.equal(failing.status, 1)
  assert.match(failing.stdout, /Created https:\/\/github\.com\/example-org\/example-repo\/issues\/1/)
  assert.match(failing.stderr, /Failed .*\/S2/)
  assert.equal(ghState(fixture).issues.length, 1)

  const retry = handoff(fixture, ['--limit', '3', '--force', '--json'])
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(JSON.parse(retry.stdout).applied.length, 2)
  assert.equal(ghState(fixture).issues.length, 3)
})
