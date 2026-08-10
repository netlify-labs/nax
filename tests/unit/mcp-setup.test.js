const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  claudeConfigLocation,
  configuredNaxClaudeServer,
  formatClaudeMcpSetupPreview,
  naxClaudeServer,
  probeClaudeCli,
  readClaudeConfig,
  setupClaudeMcp,
} = require('../../src/mcp/setup')

/** @returns {import('../../src/mcp/setup').ClaudeCliProbe} */
function supportedClaude() {
  return { ok: true, executable: '/tools/claude', message: 'supported' }
}

/** @param {string} directory */
function jsonFiles(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : []
}

test('Claude MCP setup dry-run previews the exact portable project change without writing', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-setup-dry-'))
  /** @type {Array<import('../../src/mcp/setup').ClaudeMcpSetupResult>} */
  const previews = []
  const result = setupClaudeMcp({
    projectRoot,
    dryRun: true,
    probe: supportedClaude,
    onPreview: (preview) => previews.push(preview),
  })

  assert.equal(result.scope, 'project')
  assert.equal(result.changed, true)
  assert.equal(fs.existsSync(path.join(projectRoot, '.mcp.json')), false)
  assert.equal(previews.length, 1)
  assert.deepEqual(result.server, {
    type: 'stdio',
    command: 'nax',
    args: ['mcp'],
  })
  assert.match(formatClaudeMcpSetupPreview(result), /Set mcpServers\.nax to:/)
  assert.doesNotMatch(JSON.stringify(result.server), new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('project setup preserves unrelated servers, backs up before replacement, and is idempotent', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-setup-project-'))
  const configPath = path.join(projectRoot, '.mcp.json')
  const original = { mcpServers: { other: { type: 'http', url: 'https://example.test/mcp' }, nax: { command: 'old-nax' } }, future: { enabled: true } }
  fs.writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`)
  /** @type {boolean[]} */
  const existedAtPreview = []

  const result = setupClaudeMcp({
    projectRoot,
    probe: supportedClaude,
    now: () => '2026-08-08T12:34:56.000Z',
    randomId: () => 'fixed',
    onPreview: () => existedAtPreview.push(fs.readFileSync(configPath, 'utf8').includes('old-nax')),
  })
  const updated = readClaudeConfig(configPath)
  assert.deepEqual(existedAtPreview, [true])
  assert.deepEqual(updated?.future, { enabled: true })
  assert.deepEqual(/** @type {Record<string, unknown>} */ (updated?.mcpServers).other, original.mcpServers.other)
  assert.deepEqual(/** @type {Record<string, unknown>} */ (updated?.mcpServers).nax, naxClaudeServer())
  assert.deepEqual(readClaudeConfig(result.backupPath), original)

  const repeated = setupClaudeMcp({ projectRoot, probe: supportedClaude })
  assert.equal(repeated.changed, false)
  assert.equal(repeated.backupPath, '')
  assert.equal(fs.readdirSync(projectRoot).filter((name) => name.includes('.nax-backup-')).length, 1)
})

test('local and user setup use the correct Claude config shape without duplicating NAX', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-setup-scopes-'))
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-home-'))
  const userConfigPath = path.join(homeDir, '.claude.json')
  fs.writeFileSync(userConfigPath, `${JSON.stringify({ theme: 'dark', mcpServers: { shared: { command: 'shared' } } }, null, 2)}\n`)

  setupClaudeMcp({ projectRoot, homeDir, scope: 'local', probe: supportedClaude })
  setupClaudeMcp({ projectRoot, homeDir, scope: 'user', probe: supportedClaude })
  const config = /** @type {Record<string, unknown>} */ (readClaudeConfig(userConfigPath))
  assert.deepEqual(configuredNaxClaudeServer(config, 'local', projectRoot), naxClaudeServer())
  assert.deepEqual(configuredNaxClaudeServer(config, 'user', projectRoot), naxClaudeServer())
  assert.deepEqual(/** @type {Record<string, unknown>} */ (config.mcpServers).shared, { command: 'shared' })
  assert.equal(config.theme, 'dark')
  assert.equal(Object.keys(/** @type {Record<string, unknown>} */ (config.mcpServers)).filter((key) => key === 'nax').length, 1)
  const projects = /** @type {Record<string, unknown>} */ (config.projects)
  const localProject = /** @type {Record<string, unknown>} */ (projects[fs.realpathSync(projectRoot)])
  assert.equal(Object.keys(/** @type {Record<string, unknown>} */ (localProject.mcpServers)).filter((key) => key === 'nax').length, 1)
  assert.equal(claudeConfigLocation('local', projectRoot, { homeDir }).configPath, userConfigPath)
})

test('setup rejects missing Claude and malformed configs without filesystem changes', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-setup-invalid-'))
  const configPath = path.join(projectRoot, '.mcp.json')
  fs.writeFileSync(configPath, '{broken')

  assert.throws(() => setupClaudeMcp({
    projectRoot,
    probe: () => ({ ok: false, executable: '', message: 'Claude Code CLI was not found on PATH.' }),
  }), /not found on PATH/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{broken')
  assert.throws(() => setupClaudeMcp({ projectRoot, probe: supportedClaude }), /not valid JSON/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{broken')
  assert.deepEqual(jsonFiles(projectRoot), ['.mcp.json'])
})

test('failed atomic config replacement leaves the original and a complete backup', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-setup-atomic-'))
  const configPath = path.join(projectRoot, '.mcp.json')
  const original = '{\n  "mcpServers": { "old": { "command": "old" } }\n}\n'
  fs.writeFileSync(configPath, original)
  let renames = 0
  const fileSystem = {
    ...fs,
    renameSync(oldPath, newPath) {
      renames += 1
      if (renames === 2) throw new Error('injected rename failure')
      fs.renameSync(oldPath, newPath)
    },
  }

  assert.throws(() => setupClaudeMcp({
    projectRoot,
    probe: supportedClaude,
    fileSystem,
    now: () => '2026-08-08T12:34:56.000Z',
    randomId: () => `fixed-${renames}`,
  }), /injected rename failure/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), original)
  assert.equal(fs.readFileSync(`${configPath}.nax-backup-20260808T123456000Z`, 'utf8'), original)
  assert.equal(fs.readdirSync(projectRoot).some((name) => name.endsWith('.tmp')), false)
})

test('Claude CLI probe detects the supported scope interface and missing executables', () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-bin-'))
  const executable = path.join(binDir, 'claude')
  fs.writeFileSync(executable, '#!/bin/sh\n')
  fs.chmodSync(executable, 0o755)

  const supported = probeClaudeCli({
    env: { PATH: binDir },
    spawn: () => ({
      status: 0,
      stdout: '--scope <scope> local project user --transport stdio',
      stderr: '',
    }),
  })
  assert.equal(supported.ok, true)
  assert.equal(supported.executable, executable)
  assert.equal(probeClaudeCli({ env: { PATH: path.join(binDir, 'missing') } }).ok, false)
})
