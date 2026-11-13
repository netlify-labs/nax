const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const {
  applyPatchFile,
  inspectWorkspace,
  runnerWorkspaceNote,
  workspaceWarnings,
} = require('../../src/integrations/acp/workspace')
const { clonedRepo, git } = require('../fixtures/acp/harness')

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
  const work = clonedRepo()
  const head = git(work, ['rev-parse', 'HEAD'])
  assert.deepEqual(inspectWorkspace({ cwd: work }), { branch: 'main', headSha: head, remoteSha: head, dirty: false, changedFiles: [] })
  fs.writeFileSync(path.join(work, 'readme.md'), 'changed\n')
  fs.writeFileSync(path.join(work, 'new file.txt'), 'x\n')
  const changed = inspectWorkspace({ cwd: work })
  assert.equal(changed.dirty, true)
  assert.deepEqual(changed.changedFiles, ['new file.txt', 'readme.md'])
})

test('a clean workspace at the pushed branch tip has no warnings', () => {
  const work = clonedRepo()
  assert.deepEqual(workspaceWarnings(inspectWorkspace({ cwd: work })), [])
})

test('warns when local commits or edits are invisible to the runner', () => {
  const work = clonedRepo()
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
  const work = clonedRepo()
  git(work, ['checkout', '-q', '-b', 'feature'])
  assert.match(workspaceWarnings(inspectWorkspace({ cwd: work }))[0], /Branch feature is not on origin/)
})

test('applies a patch file and reports the files it touched', () => {
  const work = clonedRepo()
  const root = path.dirname(work)
  const patchPath = path.join(root, 'turn.patch')
  fs.writeFileSync(patchPath, PATCH)
  assert.deepEqual(applyPatchFile({ cwd: work, patchPath }), { status: 'applied', files: ['readme.md', 'notes.txt'], detail: '' })
  assert.equal(fs.readFileSync(path.join(work, 'readme.md'), 'utf8'), 'hello\nworld\n')
  assert.equal(fs.readFileSync(path.join(work, 'notes.txt'), 'utf8'), 'note\n')
})

test('a patch that does not apply leaves the workspace untouched', () => {
  const work = clonedRepo()
  const root = path.dirname(work)
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

test('the runner note is empty when the runner sees exactly the local checkout', () => {
  assert.equal(runnerWorkspaceNote(inspectWorkspace({ cwd: clonedRepo() })), '')
})

test('the runner note tells the remote agent what local work it cannot see', () => {
  const note = runnerWorkspaceNote({
    branch: 'master',
    headSha: 'b86218921dc3aaaa',
    remoteSha: '3cbe951de7f0bbbb',
    dirty: true,
    changedFiles: ['a.js', 'b.js', 'c.js'],
  })
  assert.match(note, /^<local_workspace>/)
  assert.match(note, /You are working on origin\/master at 3cbe951de7f0\./)
  assert.match(note, /local checkout is at b86218921dc3, which differs from origin\/master/)
  assert.match(note, /3 uncommitted files you cannot see: a\.js, b\.js, c\.js/)
  assert.match(note, /commit and push it to master/)
})

test('the runner note lists at most 20 files and counts the rest', () => {
  const changedFiles = Array.from({ length: 23 }, (_, index) => `f${index}.js`)
  const note = runnerWorkspaceNote({ branch: 'main', headSha: 'a', remoteSha: 'a', dirty: true, changedFiles })
  assert.match(note, /23 uncommitted files you cannot see: f0\.js, .*f19\.js, and 3 more/)
})

test('the runner note says when the local branch is not pushed', () => {
  const note = runnerWorkspaceNote({ branch: 'feature', headSha: 'a', remoteSha: '', dirty: false, changedFiles: [] })
  assert.match(note, /local branch feature is not on origin, so you are working on the site's production branch/)
})

test('changed files cover the whole repository when inspected from a subfolder', () => {
  const work = clonedRepo()
  fs.mkdirSync(path.join(work, 'app'))
  fs.writeFileSync(path.join(work, 'root-notes.txt'), 'x\n')
  fs.writeFileSync(path.join(work, 'app', 'page.js'), 'x\n')
  assert.deepEqual(inspectWorkspace({ cwd: path.join(work, 'app') }).changedFiles, ['app/page.js', 'root-notes.txt'])
})
