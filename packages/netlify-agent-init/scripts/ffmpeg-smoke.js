// Network test: installs the real static FFmpeg the way an agent runner would.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { installTool } = require('../src/tools')

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


async function main() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'netlify-agent-init-ffmpeg-')))
  const localBin = path.join(home, '.local', 'bin')
  fs.mkdirSync(localBin, { recursive: true })
  const env = { ...npmEnv(process.env), HOME: home, PATH: `${localBin}${path.delimiter}/usr/bin${path.delimiter}/bin${path.delimiter}${path.dirname(process.execPath)}`, npm_config_cache: process.env.npm_config_cache || execFileSync('npm', ['config', 'get', 'cache'], { cwd: os.tmpdir(), env: npmEnv(process.env), encoding: 'utf8' }).trim() }
  try {
    const { step } = await installTool({ name: 'ffmpeg', link: [] }, { env })
    assert.equal(step.status, 'installed', JSON.stringify(step))
    const version = execFileSync(path.join(localBin, 'ffmpeg'), ['-version'], { encoding: 'utf8' }).split('\n')[0]
    const probe = execFileSync(path.join(localBin, 'ffprobe'), ['-version'], { encoding: 'utf8' }).split('\n')[0]
    console.log(`ffmpeg smoke: ok (${version}; ${probe})`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
