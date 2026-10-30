const assert = require('node:assert/strict')
const test = require('node:test')

const { detect } = require('../src/detect')
const { SETUP_ENV } = require('./helpers')

test('agent runner setup (postinstall): CONTEXT=dev-server with build markers and no agent runner ID is active', () => {
  const result = detect(SETUP_ENV)
  assert.equal(result.active, true)
  assert.equal(result.label, 'dev-server')
  assert.deepEqual(result.markers, ['NETLIFY', 'CONTEXT', 'BUILD_ID', 'DEPLOY_ID', 'NETLIFY_BUILD_BASE'])
})

test("the agent's own shell is active and labelled agent-runner", () => {
  const result = detect({ ...SETUP_ENV, NETLIFY_AGENT_RUNNER_ID: 'abc', NETLIFY_DEV_SERVER: 'true' })
  assert.equal(result.active, true)
  assert.equal(result.label, 'agent-runner')
})

test('deploy builds are inactive for every deploy context', () => {
  for (const context of ['production', 'deploy-preview', 'branch-deploy']) {
    const result = detect({ NETLIFY: 'true', CONTEXT: context, BUILD_ID: 'b', DEPLOY_ID: 'd', DEPLOY_URL: 'https://x' })
    assert.equal(result.active, false, context)
    assert.equal(result.label, 'netlify-build')
  }
})

test('local shells and local netlify dev are inactive', () => {
  assert.equal(detect({}).label, 'local')
  assert.equal(detect({}).active, false)
  assert.equal(detect({ NETLIFY: 'true', CONTEXT: 'dev' }).active, false)
})

test('--force makes install run anywhere', () => {
  assert.equal(detect({}, { force: true }).label, 'forced')
  assert.equal(detect({ NETLIFY: 'true', CONTEXT: 'production' }, { force: true }).active, true)
})

test('markers are names only, never values', () => {
  const result = detect({ ...SETUP_ENV, NETLIFY_AGENT_RUNNER_ID: 'secret-looking-value' })
  assert.equal(JSON.stringify(result).includes('secret-looking-value'), false)
})
