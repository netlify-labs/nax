const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { readRecord } = require('../src/record')
const { setup } = require('../src/setup')
const { SETUP_ENV, git, makeEnv, makeRepo, writeSkill } = require('./helpers')

/**
 * A committed repo whose package.json config installs a local skill and runs a command.
 * @param {Record<string, unknown>} [extraConfig]
 */
function makeProject(extraConfig = {}) {
  const repo = makeRepo()
  writeSkill(path.join(repo, 'tools', 'skills'), 'house-style')
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    private: true,
    netlifyAgent: {
      schemaVersion: 1,
      secrets: ['PRESENT_SECRET', 'MISSING_SECRET'],
      skills: [{ from: './tools/skills/house-style' }],
      run: ['node -e "require(\'fs\').writeFileSync(require(\'os\').homedir() + \'/ran.txt\', \'ok\')"'],
      ...extraConfig,
    },
  }, null, 2))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'config'])
  return repo
}

const quiet = () => {}

test('deploy builds skip in one line without reading config', async () => {
  const lines = []
  const result = await setup({ cwd: makeRepo(), env: { NETLIFY: 'true', CONTEXT: 'production' }, log: (m) => lines.push(m) })
  assert.equal(result.skipped, true)
  assert.deepEqual(lines, ['skipped (netlify-build: NETLIFY=true and CONTEXT=production)'])
})

test('agent runner setup installs skills, runs commands, keeps git status clean, and records names only', async () => {
  const repo = makeProject()
  const env = { ...makeEnv(), ...SETUP_ENV, PRESENT_SECRET: 'super-SECRET-value' }
  const { record, exitCode } = await setup({ cwd: repo, env, log: quiet })
  assert.equal(exitCode, 0)
  assert.deepEqual(record.errors, [])
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'skills', 'house-style', 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(repo, '.agents', 'skills', 'house-style', 'SKILL.md')), true)
  assert.equal(fs.readFileSync(path.join(env.HOME, 'ran.txt'), 'utf8'), 'ok')
  assert.equal(git(repo, ['status', '--porcelain']), '')

  const secrets = record.steps.find((s) => s.kind === 'secrets')
  assert.deepEqual(secrets.present, ['PRESENT_SECRET'])
  assert.deepEqual(secrets.missing, ['MISSING_SECRET'])
  assert.equal(JSON.stringify(readRecord(env)).includes('super-SECRET-value'), false)
  assert.equal(readRecord(env).detect.label, 'dev-server')
})

test('a second setup run keeps installed skills excluded', async () => {
  const repo = makeProject()
  const env = { ...makeEnv(), ...SETUP_ENV }
  await setup({ cwd: repo, env, log: quiet })
  await setup({ cwd: repo, env, log: quiet })
  assert.equal(git(repo, ['status', '--porcelain']), '')
})

test('failures are recorded and exit 0, unless strict', async () => {
  const repo = makeProject({ tools: ['nope'], run: ['exit 4'] })
  const env = { ...makeEnv(), ...SETUP_ENV }
  const lenient = await setup({ cwd: repo, env, log: quiet })
  assert.equal(lenient.exitCode, 0)
  assert.equal(lenient.record.errors.length, 2)
  const strict = await setup({ cwd: repo, env, log: quiet, strict: true })
  assert.equal(strict.exitCode, 1)
})

test('config errors stop setup before any step runs', async () => {
  const repo = makeProject({ schemaVersion: 9 })
  const env = { ...makeEnv(), ...SETUP_ENV }
  const { record } = await setup({ cwd: repo, env, log: quiet })
  assert.equal(record.steps.length, 0)
  assert.match(record.errors.join('\n'), /schemaVersion 9/)
})

test('dry run reports what would happen and writes nothing', async () => {
  const repo = makeProject({ tools: ['ffmpeg'] })
  const env = { ...makeEnv(), ...SETUP_ENV }
  const { record } = await setup({ cwd: repo, env, log: quiet, dryRun: true })
  assert.deepEqual(record.steps.map((s) => s.status), ['missing', 'would-install', 'would-install', 'would-run'])
  assert.equal(fs.existsSync(path.join(repo, '.claude')), false)
  assert.equal(readRecord(env), null)
})
