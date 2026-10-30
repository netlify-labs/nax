const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { configureMcpServers } = require('../src/mcp')
const { makeEnv } = require('./helpers')

test('adds servers to ~/.claude.json with 0600, keeps existing ones, skips servers with missing variables', () => {
  const env = { ...makeEnv(), SENTRY_TOKEN: 'sntrys_VALUE' }
  const file = path.join(env.HOME, '.claude.json')
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { existing: { url: 'https://keep' } } }))
  const step = configureMcpServers({
    existing: { url: 'https://replace-me' },
    sentry: { url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: { env: 'SENTRY_TOKEN', prefix: 'Bearer ' } } },
    broken: { url: 'https://x', headers: { Authorization: { env: 'NOT_SET' } } },
  }, { env })
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.theme, 'dark')
  assert.equal(written.mcpServers.existing.url, 'https://keep')
  assert.equal(written.mcpServers.sentry.headers.Authorization, 'Bearer sntrys_VALUE')
  assert.equal(written.mcpServers.broken, undefined)
  assert.deepEqual(step.added, ['sentry'])
  assert.deepEqual(step.missingEnv, ['NOT_SET'])
  assert.equal(JSON.stringify(step).includes('sntrys_VALUE'), false)
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
})
