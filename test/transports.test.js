const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  detectTransports,
  hasAgentRunnerAction,
  hasLocalNetlifySite,
  resolveTransport,
  formatTransportSetupHelp,
} = require('../lib/transports')

test('hasAgentRunnerAction detects the Netlify action in workflow yaml', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-transport-test-'))
  const workflows = path.join(tmp, '.github', 'workflows')
  fs.mkdirSync(workflows, { recursive: true })
  fs.writeFileSync(path.join(workflows, 'netlify-agents.yml'), 'steps:\n  - uses: netlify-labs/agent-runner-action@main\n')
  assert.equal(hasAgentRunnerAction(tmp), true)
})

test('hasAgentRunnerAction returns false when workflow is absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-transport-test-'))
  assert.equal(hasAgentRunnerAction(tmp), false)
})

test('hasLocalNetlifySite accepts env site id or Netlify state but not build config alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-transport-test-'))
  assert.equal(hasLocalNetlifySite(tmp, { NETLIFY_SITE_ID: 'site-1' }), true)
  assert.equal(hasLocalNetlifySite(tmp, {}), false)
  fs.writeFileSync(path.join(tmp, 'netlify.toml'), '[build]\n')
  assert.equal(hasLocalNetlifySite(tmp, {}), false)
  fs.mkdirSync(path.join(tmp, '.netlify'))
  fs.writeFileSync(path.join(tmp, '.netlify', 'state.json'), JSON.stringify({ siteId: 'site-from-state' }))
  assert.equal(hasLocalNetlifySite(tmp, {}), true)
})

test('resolveTransport honors explicit transports and auto-picks available transport', () => {
  assert.equal(resolveTransport('github', []), 'github')
  assert.equal(resolveTransport('github-actions', []), 'github')
  assert.equal(resolveTransport('netlify-api', []), 'netlify-api')
  assert.equal(resolveTransport('local', []), 'netlify-api')
  assert.equal(resolveTransport('local-machine', []), 'netlify-api')
  assert.equal(resolveTransport('auto', [
    { id: 'github', available: false },
    { id: 'netlify-api', available: true },
  ]), 'netlify-api')
  assert.throws(() => resolveTransport('bad', []), /Unknown run location/)
})

test('resolveTransport rejects auto when no transports are available', () => {
  assert.throws(() => resolveTransport('auto', [
    { id: 'github', available: false },
    { id: 'netlify-api', available: false },
  ]), /No runnable transport detected/)
})

test('detectTransports returns github and netlify-api entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-transport-test-'))
  const transports = detectTransports({ projectRoot: tmp, env: {} })
  assert.deepEqual(transports.map((transport) => transport.id), ['github', 'netlify-api'])
})

test('formatTransportSetupHelp includes setup steps for both transports', () => {
  const help = formatTransportSetupHelp([
    { id: 'github', title: 'GitHub Actions via agent-runner-action', reason: 'No workflow detected.' },
    { id: 'netlify-api', title: 'This machine via the Netlify CLI', reason: 'No site context.' },
  ])
  assert.match(help, /To run in GitHub Actions:/)
  assert.match(help, /netlify-labs\/agent-runner-action/)
  assert.match(help, /NETLIFY_SITE_ID/)
  assert.match(help, /NETLIFY_AUTH_TOKEN/)
  assert.match(help, /To run via the Netlify API from this machine:/)
  assert.match(help, /netlify login/)
  assert.match(help, /netlify link/)
})
