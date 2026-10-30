const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { installTool } = require('../src/tools')
const { makeEnv, makeRepo, tempDir } = require('./helpers')

/**
 * A recipe that "installs" a fake binary into installDir.
 * @param {string[]} calls
 * @returns {Record<string, import('../src/tools').ToolRecipe>}
 */
function fakeRecipes(calls) {
  return {
    faketool: {
      name: 'faketool',
      version: '1.0.0',
      provides: ['faketool-bin-xyz'],
      async install({ installDir }) {
        calls.push(installDir)
        fs.mkdirSync(installDir, { recursive: true })
        const bin = path.join(installDir, 'faketool-bin-xyz')
        fs.writeFileSync(bin, '#!/bin/sh\necho fake\n', { mode: 0o755 })
        return { 'faketool-bin-xyz': bin }
      },
    },
  }
}

test('installs into the cache and links into ~/.local/bin when it is on PATH', async () => {
  const env = makeEnv()
  const calls = []
  const { step } = await installTool({ name: 'faketool', link: [] }, { env, recipes: fakeRecipes(calls) })
  assert.equal(step.status, 'installed')
  assert.equal(calls[0].startsWith(path.join(env.HOME, '.cache', 'netlify-agent-kit', 'tools', 'faketool@1.0.0')), true)
  assert.equal(fs.readlinkSync(path.join(env.HOME, '.local', 'bin', 'faketool-bin-xyz')), path.join(calls[0], 'faketool-bin-xyz'))
  assert.deepEqual(step.links, ['~/.local/bin/faketool-bin-xyz'])
})

test('falls back to the cache bin with a warning when ~/.local/bin is not on PATH', async () => {
  const env = makeEnv({}, { onPath: false })
  const { step } = await installTool({ name: 'faketool', link: [] }, { env, recipes: fakeRecipes([]) })
  assert.deepEqual(step.links, ['~/.cache/netlify-agent-kit/bin/faketool-bin-xyz'])
  assert.match(/** @type {string[]} */ (step.warnings)[0], /not on PATH/)
})

test('skips installing when the tool is already on PATH, but still makes project links', async () => {
  const env = makeEnv()
  const existing = path.join(env.HOME, '.local', 'bin', 'faketool-bin-xyz')
  fs.writeFileSync(existing, '#!/bin/sh\n', { mode: 0o755 })
  const calls = []
  const repo = makeRepo()
  const { step, repoPaths } = await installTool({ name: 'faketool', link: ['video/.hyperframes/bin'] }, { env, cwd: repo, recipes: fakeRecipes(calls) })
  assert.equal(step.status, 'already-on-path')
  assert.equal(calls.length, 0)
  assert.equal(fs.readlinkSync(path.join(repo, 'video', '.hyperframes', 'bin', 'faketool-bin-xyz')), existing)
  assert.deepEqual(repoPaths, [path.join(repo, 'video', '.hyperframes', 'bin')])
})

test('unknown tools are an error step, not an exception', async () => {
  const { step } = await installTool({ name: 'nope', link: [] }, { env: makeEnv(), recipes: {} })
  assert.equal(step.status, 'error')
  assert.match(String(step.error), /unknown tool "nope"/)
})

test('the ffmpeg recipe installs the pinned npm packages', async () => {
  const { ffmpeg } = require('../src/tools/ffmpeg')
  const installs = []
  const installDir = tempDir()
  const fakeModules = path.join(installDir, 'node_modules')
  fs.mkdirSync(path.join(fakeModules, 'ffmpeg-static'), { recursive: true })
  fs.writeFileSync(path.join(fakeModules, 'ffmpeg-static', 'index.js'), "module.exports = '/fake/ffmpeg'")
  fs.mkdirSync(path.join(fakeModules, '@ffprobe-installer', 'ffprobe'), { recursive: true })
  fs.writeFileSync(path.join(fakeModules, '@ffprobe-installer', 'ffprobe', 'index.js'), "module.exports = { path: '/fake/ffprobe' }")
  const result = await ffmpeg.install({ installDir, npmInstall: (dir, packages) => installs.push({ dir, packages }), env: {} })
  assert.deepEqual(installs[0].packages, ['ffmpeg-static@5.3.0', '@ffprobe-installer/ffprobe@2.1.2'])
  assert.deepEqual(result, { ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' })
})
