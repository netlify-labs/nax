const assert = require('assert/strict')
const test = require('node:test')

const { hostedPlaceholderCapabilities } = require('../../src/dashboard/api/capabilities')
const { createHostedDashboardApi, createNetlifyDashboardFunction } = require('../../src/dashboard/runtime/netlify-function')

/** @param {string} body */
function parseBody(body) {
  return /** @type {Record<string, unknown>} */ (JSON.parse(body))
}

test('Netlify dashboard function serves hosted health without leaking projectRoot', async () => {
  const handler = createNetlifyDashboardFunction({ token: 'token-1' })
  const response = await handler({
    httpMethod: 'GET',
    path: '/api/health',
    headers: { 'x-nax-token': 'token-1' },
  })
  const payload = /** @type {{ ok?: boolean, projectRoot?: string, capabilities: { deploymentMode?: string, canStartRuns?: boolean } }} */ (parseBody(response.body))

  assert.equal(response.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.projectRoot, undefined)
  assert.equal(payload.capabilities.deploymentMode, 'web')
  assert.equal(payload.capabilities.canStartRuns, false)
  assert.match(response.headers['set-cookie'] || '', /HttpOnly/)
  assert.match(response.headers['set-cookie'] || '', /SameSite=Strict/)
  assert.match(response.headers['set-cookie'] || '', /Secure/)
})

test('Netlify dashboard function reports local-only mutations as unsupported', async () => {
  const handler = createNetlifyDashboardFunction({ token: 'token-1' })
  const response = await handler({
    httpMethod: 'POST',
    path: '/api/files/open',
    headers: { 'x-nax-token': 'token-1' },
    body: '{"path":"/tmp/file"}',
  })
  const payload = /** @type {{ error: { code: string } }} */ (parseBody(response.body))

  assert.equal(response.statusCode, 501)
  assert.equal(payload.error.code, 'unsupported_capability')
})

test('hosted dashboard API returns hosted storage errors when capability is enabled without a store', async () => {
  const app = createHostedDashboardApi({
    token: 'token-1',
    capabilities: hostedPlaceholderCapabilities({ canReadRuns: true }),
  })
  const response = await app.request('/api/runs', {
    headers: { 'x-nax-token': 'token-1' },
  })
  const payload = /** @type {{ error: { code: string } }} */ (await response.json())

  assert.equal(response.status, 501)
  assert.equal(payload.error.code, 'hosted_storage_unavailable')
})

test('Netlify dashboard function supports rawUrl and base64 body conversion', async () => {
  const handler = createNetlifyDashboardFunction({ token: 'token-1' })
  const response = await handler({
    httpMethod: 'POST',
    rawUrl: 'https://site.netlify.app/api/runs/run-1/cancel',
    headers: { 'x-nax-token': 'token-1' },
    body: Buffer.from('{}').toString('base64'),
    isBase64Encoded: true,
  })
  const payload = /** @type {{ error: { code: string } }} */ (parseBody(response.body))

  assert.equal(response.statusCode, 501)
  assert.equal(payload.error.code, 'unsupported_capability')
})
