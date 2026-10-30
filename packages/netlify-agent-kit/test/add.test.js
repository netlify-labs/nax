const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { applyAdd, buildPostinstall, planAdd } = require('../src/add')
const { findProjects, pinnedVersion } = require('../src/presets/hyperframes')
const { tempDir } = require('./helpers')

/** @type {import('../src/process').RunFile} */
const noNpm = () => {
  throw new Error('npm should not be called')
}

/**
 * A repo with a HyperFrames project the way `npx hyperframes init video` writes it.
 * @param {{ root?: Record<string, unknown>, videoScripts?: Record<string, string> }} [options]
 */
function makeSite({ root = { name: 'site', private: true, scripts: { build: 'x' } }, videoScripts = { render: 'npx --yes hyperframes@0.8.217 render' } } = {}) {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(root))
  fs.mkdirSync(path.join(dir, 'video'))
  fs.writeFileSync(path.join(dir, 'video', 'hyperframes.json'), '{}')
  fs.writeFileSync(path.join(dir, 'video', 'package.json'), JSON.stringify({ name: 'video', private: true, scripts: videoScripts }))
  return dir
}

test('buildPostinstall runs install, guarded, and chains onto an existing script once', () => {
  assert.equal(buildPostinstall(undefined), 'netlify-agent-kit install || exit 0')
  assert.equal(buildPostinstall('husky install'), 'husky install && (netlify-agent-kit install || exit 0)')
  assert.equal(buildPostinstall('husky install && (netlify-agent-kit install || exit 0)'), 'husky install && (netlify-agent-kit install || exit 0)')
})

test('add hyperframes finds the project and its pinned version, and changes only package.json', () => {
  const dir = makeSite()

  const plan = planAdd({ cwd: dir, preset: 'hyperframes', runFile: noNpm })
  assert.deepEqual(plan.errors, [])
  assert.match(plan.notes.join('\n'), /found the HyperFrames project in video/)
  assert.match(plan.notes.join('\n'), /hyperframes@0\.8\.217, the version the project pins/)
  applyAdd(plan)

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.build, 'x')
  assert.equal(pkg.scripts.postinstall, 'netlify-agent-kit install || exit 0')
  assert.match(pkg.devDependencies['netlify-agent-kit'], /^\^\d+\.\d+\.\d+$/)
  assert.deepEqual(pkg.netlifyAgent, { hyperframes: { version: '0.8.217', dir: 'video' } })

  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false)

  applyAdd(planAdd({ cwd: dir, preset: 'hyperframes', runFile: noNpm }))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), pkg)
})

test('add uses the latest published version when the project pins none', () => {
  const dir = makeSite({ videoScripts: { render: 'hyperframes render' } })
  const calls = []
  /** @type {import('../src/process').RunFile} */
  const npm = (command, args) => {
    calls.push([command, ...args].join(' '))
    return { status: 0, stdout: '0.9.1\n', stderr: '' }
  }
  const plan = planAdd({ cwd: dir, preset: 'hyperframes', runFile: npm })
  assert.deepEqual(calls, ['npm view hyperframes version'])
  assert.deepEqual(plan.packageJson.netlifyAgent, { hyperframes: { version: '0.9.1', dir: 'video' } })
  assert.match(plan.notes.join('\n'), /using the latest, hyperframes@0\.9\.1/)
})

test('--version and --dir override detection', () => {
  const dir = makeSite()
  const plan = planAdd({ cwd: dir, preset: 'hyperframes', options: { version: '0.8.100', dir: 'video' }, runFile: noNpm })
  assert.deepEqual(plan.packageJson.netlifyAgent, { hyperframes: { version: '0.8.100', dir: 'video' } })
})

test('add reports a missing project or an unknown preset instead of writing', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true }))
  assert.match(planAdd({ cwd: dir, preset: 'hyperframes', runFile: noNpm }).errors.join('\n'), /no HyperFrames project found/)
  assert.match(planAdd({ cwd: dir, preset: 'nope' }).errors.join('\n'), /unknown preset "nope"/)
})

test('add with no preset wires the hook and keeps existing config; missing package.json is created', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib', netlifyAgent: { secrets: ['A'] } }))
  const plan = planAdd({ cwd: dir })
  assert.match(plan.warnings.join('\n'), /not "private": true/)
  assert.deepEqual(plan.packageJson.netlifyAgent, { secrets: ['A'] })
  assert.equal(/** @type {Record<string, string>} */ (plan.packageJson.scripts).postinstall, 'netlify-agent-kit install || exit 0')
  const empty = planAdd({ cwd: tempDir() })
  assert.equal(empty.isNewPackage, true)
  assert.equal(empty.packageJson.private, true)
})

test('project and version detection helpers', () => {
  const dir = makeSite()
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'hyperframes.json'), '{}')
  assert.deepEqual(findProjects(dir), ['video'])
  const pkg = path.join(tempDir(), 'package.json')
  fs.writeFileSync(pkg, JSON.stringify({ devDependencies: { hyperframes: '^0.8.5' } }))
  assert.equal(pinnedVersion(pkg), '0.8.5')
  fs.writeFileSync(pkg, JSON.stringify({ dependencies: { hyperframes: '>=0.8' } }))
  assert.equal(pinnedVersion(pkg), null)
})
