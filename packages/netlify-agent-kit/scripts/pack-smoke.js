// Packs the package, installs it into a throwaway git project with the real
// postinstall, and runs npm install as a deploy build and as agent runner setup.
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')


/**
 * The environment for child npm commands, without the workspace settings npm
 * passes down when this script runs as a workspace script.
 * @param {NodeJS.ProcessEnv} env
 */
function npmEnv(env) {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (/^npm_config_workspaces?$/i.test(key) || /^npm_config_include_workspace_root$/i.test(key)) delete clean[key]
  }
  return clean
}

const packageRoot = path.resolve(__dirname, '..')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'netlify-agent-kit-smoke-')))
const npmCache = process.env.npm_config_cache || execFileSync('npm', ['config', 'get', 'cache'], { cwd: os.tmpdir(), env: npmEnv(process.env), encoding: 'utf8', shell: process.platform === 'win32' }).trim()

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 */
function npm(args, cwd, env) {
  const result = spawnSync('npm', args, { cwd, env: { ...npmEnv(env), npm_config_cache: npmCache }, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  return `${result.stdout}\n${result.stderr}`
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@s' },
  })
}

function main() {
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: packageRoot, env: npmEnv(process.env), encoding: 'utf8', shell: process.platform === 'win32' }))
  const files = packed.files.map((file) => file.path)
  for (const required of ['bin/netlify-agent-kit.js', 'src/index.js', 'schema.json', 'README.md']) {
    assert.equal(files.includes(required), true, `${required} is missing from the package`)
  }
  assert.equal(files.some((file) => file.startsWith('test/')), false, 'tests must not be published')
  const tarball = path.join(scratch, packed.filename)

  const project = path.join(scratch, 'project')
  fs.mkdirSync(path.join(project, 'tools', 'skills', 'house-style'), { recursive: true })
  fs.writeFileSync(path.join(project, 'tools', 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\ndescription: x\n---\nUse sentence case.\n')
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'smoke-project',
    private: true,
    scripts: { postinstall: 'netlify-agent-kit install || exit 0' },
    devDependencies: { 'netlify-agent-kit': `file:${tarball}` },
    netlifyAgent: {
      skills: [{ from: './tools/skills/house-style' }],
      run: ['node -e "process.stdout.write(\'run-step-ok\')"'],
    },
  }, null, 2))
  git(project, ['init', '--quiet', '-b', 'main'])
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n')

  const home = path.join(scratch, 'home')
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
  const baseEnv = { ...process.env, HOME: home, PATH: `${path.join(home, '.local', 'bin')}${path.delimiter}${process.env.PATH}` }
  for (const name of ['NETLIFY', 'CONTEXT', 'NETLIFY_AGENT_RUNNER_ID']) delete baseEnv[name]

  const deployOutput = npm(['install', '--no-audit', '--no-fund', '--foreground-scripts'], project, { ...baseEnv, NETLIFY: 'true', CONTEXT: 'production', BUILD_ID: 'b' })
  assert.match(deployOutput, /skipped \(netlify-build/)
  assert.equal(fs.existsSync(path.join(project, '.claude')), false)

  if (process.argv.includes('--noop-only')) {
    console.log('pack smoke (no-op only): ok')
    return
  }

  git(project, ['add', '-A'])
  git(project, ['commit', '--quiet', '-m', 'project'])

  const installOutput = npm(['install', '--no-audit', '--no-fund', '--foreground-scripts'], project, {
    ...baseEnv, NETLIFY: 'true', CONTEXT: 'dev-server', BUILD_ID: 'b', DEPLOY_ID: 'd',
  })
  assert.match(installOutput, /installing \(dev-server/)
  assert.match(installOutput, /run-step-ok/)
  assert.equal(fs.existsSync(path.join(project, '.claude', 'skills', 'house-style', 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(project, '.agents', 'skills', 'house-style', 'SKILL.md')), true)
  assert.equal(git(project, ['status', '--porcelain']), '', 'install must not show up in git status')

  const status = execFileSync(path.join(project, 'node_modules', '.bin', 'netlify-agent-kit'), ['status', '--json'], { cwd: project, env: baseEnv, encoding: 'utf8' })
  const parsed = JSON.parse(status)
  assert.equal(parsed.lastRecord.detect.label, 'dev-server')
  assert.equal(parsed.lastRecord.errors.length, 0)

  console.log('pack smoke: ok')
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
}

main()
