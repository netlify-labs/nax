// Verifies `nax handoff --to pr-review` posts one advisory review with inline comments only on diff lines.
// Runs the real CLI with a fake `gh` executable on PATH that serves PR, files, commits and reviews.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
const FAKE_BIN = path.join(__dirname, '..', 'fixtures', 'bin')
const RUN_ID = '2026-09-25T12-00-00-000Z-review'
const RUN_SHA = 'a'.repeat(40)

/** @param {Record<string, unknown>} item */
function consensus(item) {
  return { category: 'defect', status: 'open', evidence: 'e', suggested_fix: 'fix it', confidence: 'high', agents: ['codex'], ...item }
}

const SYNTHESIS = [
  '## 2. Structured Consensus',
  '',
  '```json',
  JSON.stringify({
    consensus_findings: [
      consensus({ id: 'S1', severity: 'high', file: 'src/auth.js', line: 12, claim: 'Token refresh races with logout.' }),
      consensus({ id: 'S2', severity: 'medium', file: 'src/other.js', line: 3, claim: 'Outside the diff entirely.' }),
      consensus({ id: 'S3', severity: 'low', file: 'src/auth.js', line: 99, claim: 'In a changed file but not a changed line.' }),
    ],
    contested_findings: [],
    merge_dependent_findings: [],
  }, null, 2),
  '```',
].join('\n')

/** @param {{ runSha?: string, pullRequest?: boolean, headRefOid?: string, commits?: string[] }} [options] */
function project({ runSha = RUN_SHA, pullRequest = true, headRefOid = RUN_SHA, commits = [RUN_SHA] } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-handoff-review-'))
  const dir = path.join(projectRoot, '.nax', 'workflows', RUN_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId: RUN_ID,
    flowId: 'review',
    status: 'completed',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
    target: { branch: 'fix/auth', sha: runSha, ...(pullRequest ? { pullRequest: { number: 7, url: 'https://github.com/example-org/example-repo/pull/7', isCrossRepository: false } } : {}) },
    flow: { id: 'review', title: 'Review', findings: { step: 'synthesize', adapter: 'review-consensus' }, steps: [{ id: 'synthesize', agents: ['codex'] }] },
    steps: [{ id: 'synthesize', runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', resultText: SYNTHESIS }] }],
  }))
  const statePath = path.join(projectRoot, 'fake-gh-state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    issues: [],
    labels: [],
    pulls: [{
      number: 7,
      url: 'https://github.com/example-org/example-repo/pull/7',
      headRefName: 'fix/auth',
      headRefOid,
      commits,
      files: [{ filename: 'src/auth.js', patch: '@@ -10,3 +10,4 @@\n const a = 1\n-const b = 2\n+const b = 3\n+const c = 4\n return a' }],
      reviews: [],
    }],
  }))
  return { projectRoot, statePath }
}

/** @param {ReturnType<typeof project>} fixture @param {string[]} args */
function handoff(fixture, args) {
  return spawnSync(process.execPath, [NAX_BIN, 'handoff', '--to', 'pr-review', '--repo', 'example-org/example-repo', '--project-root', fixture.projectRoot, '--limit', '3', ...args], {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: fixture.statePath },
  })
}

/** @param {ReturnType<typeof project>} fixture */
function reviews(fixture) {
  return JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).pulls[0].reviews
}

test('posts one COMMENT review with inline comments only on diff lines and the rest outside', () => {
  const fixture = project()
  const result = handoff(fixture, ['--force', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const [review] = reviews(fixture)
  assert.equal(review.event, 'COMMENT')
  assert.equal(review.comments.length, 1)
  assert.deepEqual({ path: review.comments[0].path, line: review.comments[0].line, side: review.comments[0].side }, { path: 'src/auth.js', line: 12, side: 'RIGHT' })
  assert.match(review.body, /### Outside this diff/)
  assert.match(review.body, /Outside the diff entirely/)
  assert.match(review.body, /In a changed file but not a changed line/)
  assert.match(review.body, new RegExp(`<!-- nax-review:${RUN_ID} -->`))
  assert.equal(review.commit_id, undefined)
})

test('a rerun refuses with a link to the existing review unless --force', () => {
  const fixture = project()
  assert.equal(handoff(fixture, ['--force']).status, 0)
  const second = handoff(fixture, ['--dry', '--json'])
  assert.equal(second.status, 0, second.stderr)
  const plan = JSON.parse(second.stdout)
  assert.equal(plan.planned.length, 0)
  assert.match(plan.skipped[0].existingUrl, /pullrequestreview-1$/)
  assert.equal(handoff(fixture, ['--force']).status, 0)
  assert.equal(reviews(fixture).length, 2)
})

test('a moved PR head pins commit_id when the run SHA is in the PR history', () => {
  const fixture = project({ headRefOid: 'b'.repeat(40), commits: [RUN_SHA, 'b'.repeat(40)] })
  assert.equal(handoff(fixture, ['--force']).status, 0)
  const [review] = reviews(fixture)
  assert.equal(review.commit_id, RUN_SHA)
  assert.match(review.body, /may show as outdated/)
})

test('a run SHA outside the PR history falls back to a summary-only review', () => {
  const fixture = project({ headRefOid: 'b'.repeat(40), commits: ['b'.repeat(40)] })
  assert.equal(handoff(fixture, ['--force']).status, 0)
  const [review] = reviews(fixture)
  assert.equal(review.comments.length, 0)
  assert.match(review.body, /not in this PR/)
})

test('without PR identity on the run the branch PR is used, and --pr overrides a missing branch PR', () => {
  const fixture = project({ pullRequest: false })
  assert.equal(handoff(fixture, ['--force']).status, 0)
  assert.equal(reviews(fixture).length, 1)
})
