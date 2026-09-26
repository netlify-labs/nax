// Verifies the run lock across real node processes: contention, dead-owner takeover, nonce-checked
// release, and two concurrent resumes of one run where exactly one proceeds.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const { runLockDir } = require('../../src/storage/local/run-lock')

const WORKER = path.join(__dirname, '..', 'fixtures', 'run-lock', 'worker.js')

function runDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-lock-proc-')), '.nax', 'workflows', 'run-1')
}

/** @param {string[]} args @returns {Record<string, unknown>} */
function runWorker(args) {
  const result = spawnSync(process.execPath, [WORKER, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = result.stdout.split('\n').find((line) => line.startsWith('REPORT ')) || 'REPORT {}'
  return JSON.parse(report.slice('REPORT '.length))
}

/**
 * Starts a worker and resolves with it once it prints its first report.
 * @param {string[]} args
 * @returns {Promise<{ child: import('child_process').ChildProcess, first: Record<string, unknown>, next: () => Promise<Record<string, unknown>>, stderr: () => string }>}
 */
function startWorker(args) {
  const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  /** @type {Record<string, unknown>[]} */
  const lines = []
  /** @type {Array<(line: Record<string, unknown>) => void>} */
  const waiters = []
  let buffer = ''
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const text = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!text.startsWith('REPORT ')) continue
      const line = JSON.parse(text.slice('REPORT '.length))
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else lines.push(line)
    }
  })
  const next = () => new Promise((resolve) => {
    const line = lines.shift()
    if (line) resolve(line)
    else waiters.push(resolve)
  })
  return next().then((first) => ({ child, first, next, stderr: () => stderr }))
}

/** @param {import('child_process').ChildProcess} child */
function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(undefined)
    else child.once('exit', () => resolve(undefined))
  })
}

test('a second process gets run_locked while the first holds the lock', async () => {
  const dir = runDir()
  const holder = await startWorker(['hold', dir])
  assert.equal(holder.first.locked, true)
  assert.deepEqual(runWorker(['try', dir]), { locked: false, code: 'run_locked' })
  holder.child.stdin?.write('release\n')
  assert.deepEqual(await holder.next(), { released: true })
  await exited(holder.child)
  assert.equal(runWorker(['try', dir]).locked, true)
})

test('a killed holder leaves a stale lock that the next process reclaims', async () => {
  const dir = runDir()
  const holder = await startWorker(['hold', dir])
  holder.child.kill('SIGKILL')
  await exited(holder.child)
  assert.equal(fs.existsSync(runLockDir(dir)), true)
  assert.equal(runWorker(['try', dir]).locked, true)
})

test("a replaced lock is not deleted by the old owner's release", async () => {
  const dir = runDir()
  const holder = await startWorker(['hold', dir])
  const ownerFile = path.join(runLockDir(dir), 'owner.json')
  const replaced = { ...JSON.parse(fs.readFileSync(ownerFile, 'utf8')), nonce: 'taken-over' }
  fs.writeFileSync(ownerFile, JSON.stringify(replaced))
  holder.child.stdin?.write('release\n')
  assert.deepEqual(await holder.next(), { released: false })
  await exited(holder.child)
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).nonce, 'taken-over')
})

test('two concurrent resumes of one run: exactly one proceeds, the other gets run_locked', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-lock-resume-'))
  fs.writeFileSync(path.join(projectRoot, 'review.md'), '---\ntitle: Review\n---\n\nReview it.\n')
  const dir = path.join(projectRoot, '.nax', 'workflows', 'run-1')
  fs.mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, 'workflow.json')
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    runId: 'run-1',
    flowId: 'resume-flow',
    transport: 'netlify-api',
    status: 'interrupted',
    projectRoot,
    dir,
    target: { branch: 'main', ref: 'origin/main', sha: 'a'.repeat(40), sourceType: 'explicit-branch', verified: true, caveats: [] },
    branch: 'main',
    options: { branch: 'main', netlifySiteId: 'site_test', autoContext: false, timeoutMinutes: 1 },
    flow: { id: 'resume-flow', title: 'Resume flow', dir: projectRoot, defaults: {}, steps: [{ id: 'review', title: 'Review', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'review.md', agents: ['claude', 'codex'] }] },
    steps: [{ id: 'review', title: 'Review', status: 'running', runs: [
      { transport: 'netlify-api', agent: 'claude', instanceId: 'claude:auto:auto', attemptId: 'c1', status: 'completed', runnerId: 'r-claude', resultText: 'done', promptText: 'p' },
      { transport: 'netlify-api', agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'x1', status: 'failed', runnerId: 'r-codex', promptText: 'p' },
    ] }],
  }))
  const results = await Promise.all([startWorker(['resume', statePath]), startWorker(['resume', statePath])])
  await Promise.all(results.map(({ child }) => exited(child)))
  const outcomes = results.map(({ first }) => first)
  for (const { stderr } of results) assert.equal(stderr(), '')
  assert.equal(outcomes.filter((outcome) => outcome.ok === true && outcome.submitted === 1).length, 1, JSON.stringify(outcomes))
  assert.equal(outcomes.filter((outcome) => outcome.ok === false && outcome.code === 'run_locked' && outcome.submitted === 0).length, 1, JSON.stringify(outcomes))
  assert.equal(fs.existsSync(runLockDir(dir)), false)
})

test('many processes racing to take over one stale lock: exactly one acquires it', async () => {
  const dir = runDir()
  fs.mkdirSync(runLockDir(dir), { recursive: true })
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify({ pid: Number(dead.stdout), hostname: os.hostname(), nonce: 'crashed', command: 'crashed' }))
  const workers = await Promise.all(Array.from({ length: 8 }, () => startWorker(['hold', dir])))
  const acquired = workers.filter(({ first }) => first.locked === true)
  assert.equal(acquired.length, 1, JSON.stringify(workers.map(({ first }) => first)))
  assert.equal(workers.filter(({ first }) => first.code === 'run_locked').length, 7)
  for (const { child } of workers) child.kill('SIGKILL')
  await Promise.all(workers.map(({ child }) => exited(child)))
})
