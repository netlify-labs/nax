const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  checkSkills,
  findExistingProviders,
  installSkills,
  listBundledSkills,
  readInstalledVersion,
  resolveProviders,
} = require('../../src/integrations/skills')

function makeProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-skills-test-'))
  fs.mkdirSync(path.join(tmp, '.git'))
  return tmp
}

test('listBundledSkills includes nax-workflows', () => {
  assert.ok(listBundledSkills().includes('nax-workflows'))
})

test('resolveProviders detects existing AI harness directories', () => {
  const tmp = makeProject()
  fs.mkdirSync(path.join(tmp, '.codex'))
  fs.mkdirSync(path.join(tmp, '.cursor'))

  assert.deepEqual(findExistingProviders(tmp), ['.codex', '.cursor'])
  assert.deepEqual(resolveProviders({ projectRoot: tmp }), ['.codex', '.cursor'])
})

test('resolveProviders falls back to .claude when no provider directory exists', () => {
  const tmp = makeProject()

  assert.deepEqual(resolveProviders({ projectRoot: tmp }), ['.claude'])
})

test('installSkills installs bundled skill into detected providers with version stamp', () => {
  const tmp = makeProject()
  fs.mkdirSync(path.join(tmp, '.codex'))

  const results = installSkills({
    projectRoot: tmp,
    version: '9.8.7',
  })

  const skillRoot = path.join(tmp, '.codex', 'skills', 'nax-workflows')
  assert.deepEqual(results.map((result) => ({
    provider: result.provider,
    skill: result.skill,
    status: result.status,
    version: result.version,
  })), [{
    provider: '.codex',
    skill: 'nax-workflows',
    status: 'installed',
    version: '9.8.7',
  }])
  assert.equal(readInstalledVersion(skillRoot), '9.8.7')
  assert.match(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'), /name: nax-workflows/)
  assert.ok(fs.existsSync(path.join(skillRoot, 'references', 'FLOWS.md')))
})

test('installSkills supports explicit provider and dry-run without writes', () => {
  const tmp = makeProject()

  const results = installSkills({
    projectRoot: tmp,
    providers: ['codex'],
    dryRun: true,
    version: '1.2.3',
  })

  assert.equal(results[0].provider, '.codex')
  assert.equal(results[0].status, 'would-install')
  assert.equal(fs.existsSync(path.join(tmp, '.codex')), false)
})

test('checkSkills reports installed and stale versions', () => {
  const tmp = makeProject()
  fs.mkdirSync(path.join(tmp, '.claude'))

  installSkills({
    projectRoot: tmp,
    version: '1.0.0',
  })
  const current = checkSkills({
    projectRoot: tmp,
    version: '1.0.0',
  })
  const stale = checkSkills({
    projectRoot: tmp,
    version: '2.0.0',
  })

  assert.equal(current[0].installed, true)
  assert.equal(current[0].current, true)
  assert.equal(stale[0].installedVersion, '1.0.0')
  assert.equal(stale[0].current, false)
})
