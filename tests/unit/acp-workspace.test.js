const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const {
  applyPatchFile,
  inspectWorkspace,
  workspaceWarnings,
} = require('../../src/integrations/acp/workspace')

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Creates a clone of a bare origin with one pushed commit on main. */
function clonedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-acp-ws-'))
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  git(root, ['init', '-q', '--bare', '-b', 'main', origin])
  git(root, ['clone', '-q', origin, work])
  git(work, ['config', 'user.email', 'nax@example.com'])
  git(work, ['config', 'user.name', 'nax'])
  git(work, ['checkout', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(work, 'readme.md'), 'hello\n')
  git(work, ['add', '.'])
  git(work, ['commit', '-q', '-m', 'init'])
  git(work, ['push', '-q', 'origin', 'main'])
  return { root, work }
}

const PATCH = [
  'diff --git a/readme.md b/readme.md',
  '--- a/readme.md',
  '+++ b/readme.md',
  '@@ -1 +1,2 @@',
  ' hello',
  '+world',
  'diff --git a/notes.txt b/notes.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.txt',
  '@@ -0,0 +1 @@',
  '+note',
  '',
].join('\n')

test('inspects the branch, local and remote heads, and dirty state', () => {
  const { work } = clonedRepo()
  const head = git(work, ['rev-parse', 'HEAD'])
  assert.deepEqual(inspectWorkspace({ cwd: work }), { branch: 'main', headSha: head, remoteSha: head, dirty: false })
  fs.writeFileSync(path.join(work, 'readme.md'), 'changed\n')
  assert.equal(inspectWorkspace({ cwd: work }).dirty, true)
})

test('a clean workspace at the pushed branch tip has no warnings', () => {
  const { work } = clonedRepo()
  assert.deepEqual(workspaceWarnings(inspectWorkspace({ cwd: work })), [])
})

test('warns when local commits or edits are invisible to the runner', () => {
  const { work } = clonedRepo()
  fs.writeFileSync(path.join(work, 'local.txt'), 'x\n')
  git(work, ['add', '.'])
  git(work, ['commit', '-q', '-m', 'local only'])
  fs.writeFileSync(path.join(work, 'readme.md'), 'edited\n')
  const warnings = workspaceWarnings(inspectWorkspace({ cwd: work }))
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /Local HEAD [0-9a-f]{12} differs from origin\/main [0-9a-f]{12}/)
  assert.match(warnings[1], /Uncommitted local changes are not visible to the agent runner/)
})

test('warns when the branch is not on origin', () => {
  const { work } = clonedRepo()
  git(work, ['checkout', '-q', '-b', 'feature'])
  assert.match(workspaceWarnings(inspectWorkspace({ cwd: work }))[0], /Branch feature is not on origin/)
})

test('applies a patch file and reports the files it touched', () => {
  const { root, work } = clonedRepo()
  const patchPath = path.join(root, 'turn.patch')
  fs.writeFileSync(patchPath, PATCH)
  assert.deepEqual(applyPatchFile({ cwd: work, patchPath }), { status: 'applied', files: ['readme.md', 'notes.txt'], detail: '' })
  assert.equal(fs.readFileSync(path.join(work, 'readme.md'), 'utf8'), 'hello\nworld\n')
  assert.equal(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8'), 'note\n')
})

test('a patch that does not apply leaves the workspace untouched', () => {
  const { root, work } = clonedRepo()
  fs.writeFileSync(path.join(work, 'readme.md'), 'diverged\n')
  const patchPath = path.join(root, 'turn.patch')
  fs.writeFileSync(patchPath, PATCH)
  const result = applyPatchFile({ cwd: work, patchPath })
  assert.equal(result.status, 'conflict')
  assert.deepEqual(result.files, ['readme.md', 'notes.txt'])
  assert.match(result.detail, /patch does not apply/)
  assert.equal(fs.existsSync(path.join(work, 'notes.txt')), false)
  assert.equal(fs.readFileSync(path.join(work, 'readme.md'), 'utf8'), 'diverged\n')
})
