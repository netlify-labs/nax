// Verifies `nax run --resume <run-id>`: the reconciliation preview, --dry, the non-TTY guard and refusals.
// Runs the real CLI as a subprocess against a temp project with a saved, partially failed run.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
const RUN_ID = '2026-09-25T12-00-00-000Z-resume-flow'

/** @param {Record<string, unknown>} [overrides] */
function project(overrides = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-cli-resume-'))
  fs.writeFileSync(path.join(projectRoot, 'review.md'), '---\ntitle: Review\n---\n\nReview it.\n')
  const dir = path.join(projectRoot, '.nax', 'workflows', RUN_ID)
  fs.mkdirSync(dir, { recursive: true })
  /** @param {string} agent @param {Record<string, unknown>} run */
  const saved = (agent, run) => ({ transport: 'netlify-api', agent, instanceId: `${agent}:auto:auto`, attemptId: `${agent}-a1`, promptText: `Saved prompt for ${agent}`, ...run })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId: RUN_ID,
    flowId: 'resume-flow',
    flowTitle: 'Resume flow',
    transport: 'netlify-api',
    status: 'interrupted',
    projectRoot,
    dir,
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
    target: { branch: 'main', ref: 'origin/main', sha: 'a'.repeat(40), sourceType: 'explicit-branch', verified: true, caveats: [] },
    branch: 'main',
    options: { branch: 'main', netlifySiteId: 'site_test' },
    flow: {
      id: 'resume-flow',
      title: 'Resume flow',
      dir: projectRoot,
      defaults: {},
      steps: [{ id: 'review', title: 'Review', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'review.md', agents: ['claude', 'gemini', 'codex', 'opencode'] }],
    },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'running',
      runs: [
        saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
        saved('gemini', { status: 'running', runnerId: 'r-gemini' }),
        saved('codex', { status: 'failed', runnerId: 'r-codex', error: 'The Codex model is currently at capacity.' }),
        saved('opencode', { status: 'cancelled', runnerId: 'r-opencode' }),
      ],
    }],
    ...overrides,
  }))
  return projectRoot
}

/** @param {string} projectRoot @param {string[]} args */
function resume(projectRoot, args) {
  return spawnSync(process.execPath, [NAX_BIN, 'run', '--resume', RUN_ID, ...args, '--project-root', projectRoot], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

test('--dry prints the per-instance reconciliation table and submits nothing', () => {
  const projectRoot = project()
  const result = resume(projectRoot, ['--dry'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`Resume ${RUN_ID}\\s+\\(step 1/1: Review\\)`))
  assert.match(result.stdout, /claude:auto:auto\s+keep\s+completed/)
  assert.match(result.stdout, /gemini:auto:auto\s+poll\s+running \(runner r-gemini\)/)
  assert.match(result.stdout, /codex:auto:auto\s+resubmit\s+failed: model_capacity/)
  assert.match(result.stdout, /opencode:auto:auto\s+skip\s+cancelled by user/)
  assert.match(result.stdout, /Branch: main @ aaaaaaaaaaaa/)
  assert.match(result.stdout, /New agent runs: 1\s+Kept: 1\s+Polling: 1\s+Skipped: 1/)
  const saved = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nax', 'workflows', RUN_ID, 'workflow.json'), 'utf8'))
  assert.equal(saved.steps[0].runs[2].attemptId, 'codex-a1')
})

test('--include-cancelled moves cancelled instances to resubmit', () => {
  const result = resume(project(), ['--dry', '--include-cancelled'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /opencode:auto:auto\s+resubmit\s+cancelled/)
  assert.match(result.stdout, /New agent runs: 2/)
})

test('non-TTY resume without --force fails fast naming the flag', () => {
  const result = resume(project(), [])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /needs confirmation\. Re-run with --force/)
})

test('a GitHub-transport run gets an explicit step-level resume error', () => {
  const result = resume(project({ transport: 'github' }), ['--dry'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /mid-step resume supports netlify-api runs; GitHub runs resume at step level/)
})

test('a completed run is not resumable', () => {
  const result = resume(project({ status: 'completed', steps: [{ id: 'review', status: 'completed', runs: [{ agent: 'claude', status: 'completed', resultText: 'ok' }] }] }), ['--dry'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /is completed; nothing to resume/)
})

test('a reconcile stop is printed in the preview and exits non-zero', () => {
  const projectRoot = project({ steps: [{ id: 'review', status: 'running', runs: [{ agent: 'claude', instanceId: 'claude:auto:auto', status: 'pending', runnerId: '', sentAt: '2026-09-25T12:01:00.000Z', promptText: 'p' }] }] })
  const result = resume(projectRoot, ['--dry'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /resume_ambiguous_submission|may already exist remotely/)
})

test('a moved branch head refuses before any prompt unless --force', async () => {
  const { handleResumeCommand } = require('../../src/cli/commands/resume')
  /** @type {string[]} */
  const errors = []
  /** @type {unknown[]} */
  const resumed = []
  const deps = {
    stdout: () => {},
    stderr: (/** @type {string} */ text) => { errors.push(text) },
    isTTY: false,
    resolveRemoteSha: () => 'b'.repeat(40),
    resume: /** @type {typeof import('../../src/workflows/engine/local-executor').resumeLocalFlow} */ (async (input) => { resumed.push(input) }),
  }
  const exitCode = process.exitCode
  const projectRoot = project()
  assert.equal(await handleResumeCommand(RUN_ID, { projectRoot }, deps), 1)
  assert.match(errors.join('\n'), /branch_moved_since_run/)
  assert.equal(resumed.length, 0)
  assert.equal(await handleResumeCommand(RUN_ID, { projectRoot, force: true }, deps), 0)
  assert.equal(resumed.length, 1)
  process.exitCode = exitCode
})
