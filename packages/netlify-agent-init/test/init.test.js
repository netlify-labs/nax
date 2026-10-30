const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { START } = require('../src/agents-md')
const { applyInit, buildPostinstall, planInit } = require('../src/init')
const { tempDir } = require('./helpers')

test('buildPostinstall guards our command and chains onto an existing script once', () => {
  assert.equal(buildPostinstall(undefined), 'netlify-agent-init || exit 0')
  assert.equal(buildPostinstall('husky install'), 'husky install && (netlify-agent-init || exit 0)')
  assert.equal(buildPostinstall('husky install && (netlify-agent-init || exit 0)'), 'husky install && (netlify-agent-init || exit 0)')
})

test('init adds the dependency, postinstall, config and an AGENTS.md section, idempotently', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'site', private: true, scripts: { build: 'x' } }))
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent guide\n\nExisting notes.\n')

  const plan = planInit({ cwd: dir, presets: { hyperframes: { version: '0.8.217', dir: 'video' } } })
  assert.deepEqual(plan.errors, [])
  applyInit(plan)
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.build, 'x')
  assert.equal(pkg.scripts.postinstall, 'netlify-agent-init || exit 0')
  assert.match(pkg.devDependencies['netlify-agent-init'], /^\^\d+\.\d+\.\d+$/)
  assert.deepEqual(pkg.netlifyAgent, { schemaVersion: 1, presets: { hyperframes: { version: '0.8.217', dir: 'video' } } })

  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
  assert.match(agents, /^# Agent guide\n\nExisting notes\.\n\n<!-- netlify-agent-init:start -->/)
  assert.match(agents, /read the `hyperframes` skill first/)

  applyInit(planInit({ cwd: dir, presets: { hyperframes: { version: '0.8.217', dir: 'video' } } }))
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').split(START).length - 1, 1)
})

test('init warns for packages that are not private and creates package.json when missing', () => {
  const published = tempDir()
  fs.writeFileSync(path.join(published, 'package.json'), JSON.stringify({ name: 'lib' }))
  assert.match(planInit({ cwd: published }).warnings.join('\n'), /not "private": true/)
  const empty = tempDir()
  const plan = planInit({ cwd: empty })
  assert.equal(plan.isNewPackage, true)
  assert.equal(plan.packageJson.private, true)
})

test('init reports preset errors instead of writing', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true }))
  assert.match(planInit({ cwd: dir, presets: { hyperframes: {} } }).errors.join('\n'), /needs a "version"/)
})
