const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { loadConfig, normalizeConfig, isPinnedRef, parseNpmSpec } = require('../src/config')
const { tempDir } = require('./helpers')

test('netlify-agent.json wins over package.json#netlifyAgent', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ netlifyAgent: { schemaVersion: 1, tools: ['ffmpeg'] } }))
  fs.writeFileSync(path.join(dir, 'netlify-agent.json'), JSON.stringify({ schemaVersion: 1, secrets: ['A'] }))
  const loaded = loadConfig(dir)
  assert.equal(loaded.source, 'netlify-agent.json')
  assert.deepEqual(loaded.config.secrets, ['A'])
  assert.deepEqual(loaded.config.tools, [])
})

test('no config means no config and no errors', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  const loaded = loadConfig(dir)
  assert.equal(loaded.config, null)
  assert.deepEqual(loaded.errors, [])
})

test('the hyperframes preset expands to ffmpeg, the four skills and browser ensure, merged with explicit config', () => {
  const { config, errors } = normalizeConfig({
    schemaVersion: 1,
    presets: { hyperframes: { version: '0.8.217', dir: 'video' } },
    tools: ['ffmpeg', { name: 'ffmpeg', link: ['video/.hyperframes/bin'] }],
  }, 'test')
  assert.deepEqual(errors, [])
  assert.deepEqual(config.tools, [{ name: 'ffmpeg', link: ['video/.hyperframes/bin'] }])
  assert.equal(config.skills[0].from, 'npm:hyperframes@0.8.217')
  assert.equal(config.skills[0].path, 'dist/skills')
  assert.deepEqual(config.skills[0].names, ['hyperframes', 'hyperframes-cli', 'hyperframes-registry', 'media-use'])
  assert.deepEqual(config.run, [{ cwd: 'video', command: 'npx -y hyperframes@0.8.217 browser ensure' }])
  assert.equal(config.agentsMd.length > 0, true)
})

test('schemaVersion: missing warns, newer than supported is an error', () => {
  assert.match(normalizeConfig({}, 'test').warnings.join('\n'), /schemaVersion/)
  assert.match(normalizeConfig({ schemaVersion: 2 }, 'test').errors.join('\n'), /only understands 1/)
})

test('validation errors and pinning warnings', () => {
  const { errors, warnings } = normalizeConfig({
    schemaVersion: 1,
    presets: { nope: {}, hyperframes: {} },
    skills: [
      { from: 'npm:hyperframes@^0.8.0' },
      { from: 'github:o/r#main' },
      { from: 'ftp://x' },
      { from: 'github:o/r#v1.2.0', auth: { token: 'x' } },
    ],
    repositories: [{ repo: 'not a repo' }, { repo: 'o/r' }],
    secrets: [1],
    surprise: true,
  }, 'test')
  assert.match(errors.join('\n'), /unknown preset "nope"/)
  assert.match(errors.join('\n'), /needs a "version"/)
  assert.match(errors.join('\n'), /must start with npm:, github:, or \.\//)
  assert.match(errors.join('\n'), /auth must be \{ "env"/)
  assert.match(errors.join('\n'), /repositories\[0\]\.repo/)
  assert.match(errors.join('\n'), /secrets must be a list/)
  assert.match(warnings.join('\n'), /pin an exact version/)
  assert.match(warnings.join('\n'), /looks like a branch/)
  assert.match(warnings.join('\n'), /has no "ref"/)
  assert.match(warnings.join('\n'), /unknown key "surprise"/)
})

test('mcpServers is ignored with a warning unless the experimental flag is on', () => {
  const off = normalizeConfig({ schemaVersion: 1, mcpServers: { a: { url: 'https://x' } } }, 'test')
  assert.equal(off.config.experimental.mcpServers, false)
  assert.match(off.warnings.join('\n'), /experimental/)
  const on = normalizeConfig({ schemaVersion: 1, mcpServers: { a: { url: 'https://x' } }, experimental: { mcpServers: true } }, 'test')
  assert.equal(on.config.experimental.mcpServers, true)
})

test('spec parsing helpers', () => {
  assert.deepEqual(parseNpmSpec('npm:@scope/pkg@1.2.3'), { name: '@scope/pkg', version: '1.2.3' })
  assert.equal(isPinnedRef('9f3c2e1'), true)
  assert.equal(isPinnedRef('v1.4.0'), true)
  assert.equal(isPinnedRef('main'), false)
})
