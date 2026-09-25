// Verifies local-only git state (uncommitted or unpushed) is surfaced before remote agent runs.
// Uses real temp git repositories; only the TTY flag and output sink are injected.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { checkRemoteInvisibleLocalChanges } = require('../../src/cli/main')

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** Creates a repo with one pushed commit on `main` tracking a bare `origin`. */
function makeSyncedRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-remote-invisible-'))
  const remote = path.join(tmp, 'remote.git')
  const repo = path.join(tmp, 'repo')
  git(tmp, ['init', '--bare', '-q', remote])
  git(tmp, ['init', '-q', '-b', 'main', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  return repo
}

function collectingWarn() {
  /** @type {string[]} */
  const lines = []
  return { lines, warn: (/** @type {string} */ line) => { lines.push(line) } }
}

test('non-interactive run warns about uncommitted files without prompting', async () => {
  const repo = makeSyncedRepo()
  fs.writeFileSync(path.join(repo, 'local-only.md'), 'draft\n')
  const { lines, warn } = collectingWarn()

  await checkRemoteInvisibleLocalChanges({ projectRoot: repo, branch: 'main', options: {}, isTTY: false, warn })

  const output = lines.join('\n')
  assert.match(output, /not visible to remote Netlify agent runners/)
  assert.match(output, /local-only\.md/)
  assert.match(output, /'main'/)
})

test('non-interactive run warns about unpushed commits', async () => {
  const repo = makeSyncedRepo()
  fs.writeFileSync(path.join(repo, 'plan.md'), 'plan\n')
  git(repo, ['add', 'plan.md'])
  git(repo, ['commit', '-q', '-m', 'local only'])
  const { lines, warn } = collectingWarn()

  await checkRemoteInvisibleLocalChanges({ projectRoot: repo, branch: 'main', options: {}, isTTY: false, warn })

  assert.match(lines.join('\n'), /ahead 1/)
})

test('--force/--yes in a TTY warns instead of prompting', async () => {
  const repo = makeSyncedRepo()
  fs.writeFileSync(path.join(repo, 'local-only.md'), 'draft\n')
  const { lines, warn } = collectingWarn()

  await checkRemoteInvisibleLocalChanges({ projectRoot: repo, branch: 'main', options: { yes: true }, isTTY: true, warn })

  assert.match(lines.join('\n'), /local-only\.md/)
})

test('clean synced repo produces no warning', async () => {
  const repo = makeSyncedRepo()
  const { lines, warn } = collectingWarn()

  await checkRemoteInvisibleLocalChanges({ projectRoot: repo, branch: 'main', options: {}, isTTY: false, warn })

  assert.deepEqual(lines, [])
})

test('dry runs skip the check', async () => {
  const repo = makeSyncedRepo()
  fs.writeFileSync(path.join(repo, 'local-only.md'), 'draft\n')
  const { lines, warn } = collectingWarn()

  await checkRemoteInvisibleLocalChanges({ projectRoot: repo, branch: 'main', options: { dryRun: true }, isTTY: false, warn })

  assert.deepEqual(lines, [])
})
