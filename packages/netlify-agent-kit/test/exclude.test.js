const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { BLOCK_START, excludePaths } = require('../src/exclude')
const { git, makeRepo, tempDir } = require('./helpers')

test('excluded files disappear from git status, and user lines outside the block are kept', () => {
  const repo = makeRepo()
  const exclude = path.join(repo, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  fs.writeFileSync(exclude, '# mine\n*.local\n')
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'demo'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'demo', 'SKILL.md'), 'x')
  assert.notEqual(git(repo, ['status', '--porcelain']), '')

  const result = excludePaths(repo, [path.join(repo, '.claude', 'skills', 'demo')])
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.patterns, ['/.claude/skills/demo/'])
  assert.equal(git(repo, ['status', '--porcelain']), '')
  assert.match(fs.readFileSync(exclude, 'utf8'), /^# mine\n\*\.local\n/)
})

test('rewriting is idempotent and an empty list removes the block', () => {
  const repo = makeRepo()
  const target = path.join(repo, 'a')
  fs.mkdirSync(target)
  excludePaths(repo, [target])
  excludePaths(repo, [target])
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split(BLOCK_START).length - 1, 1)
  excludePaths(repo, [])
  assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes(BLOCK_START), false)
})

test('works in a git worktree, where .git is a file', () => {
  const repo = makeRepo()
  const worktree = path.join(tempDir(), 'wt')
  git(repo, ['worktree', 'add', '--quiet', worktree])
  fs.mkdirSync(path.join(worktree, 'gen'))
  fs.writeFileSync(path.join(worktree, 'gen', 'x'), 'x')
  const result = excludePaths(worktree, [path.join(worktree, 'gen')])
  assert.equal(result.status, 'ok')
  assert.equal(git(worktree, ['status', '--porcelain']), '')
})

test('outside a git checkout it is skipped with a reason', () => {
  const result = excludePaths(tempDir(), ['/tmp/x'])
  assert.equal(result.status, 'skipped')
  assert.match(result.reason, /not a git checkout/)
})

test('paths outside the checkout are never excluded', () => {
  const repo = makeRepo()
  const result = excludePaths(repo, [path.join(tempDir(), 'elsewhere')])
  assert.deepEqual(result.patterns, [])
})
