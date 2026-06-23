const assert = require('assert/strict')
const test = require('node:test')

const { createDashboardApi } = require('../../src/dashboard/api/app')
const { hostedPlaceholderCapabilities, localDashboardCapabilities } = require('../../src/dashboard/api/capabilities')

function api(mutations = {}, capabilities = localDashboardCapabilities()) {
  return createDashboardApi({
    token: 'token-1',
    runtime: { capabilities },
    mutations,
  })
}

test('Hono dashboard mutation routes require auth', async () => {
  const app = api({
    startWorkflow: async () => ({ statusCode: 202, body: { ok: true } }),
  })

  const response = await app.request('/api/workflows/review/runs', {
    method: 'POST',
    body: '{}',
  })
  const payload = /** @type {{ error: { code: string } }} */ (await response.json())

  assert.equal(response.status, 401)
  assert.equal(payload.error.code, 'unauthorized')
})

test('Hono dashboard mutation routes do not accept query-string tokens', async () => {
  const app = api({
    startWorkflow: async () => ({ statusCode: 202, body: { ok: true } }),
  })

  const response = await app.request('/api/workflows/review/runs?token=token-1', {
    method: 'POST',
    body: '{}',
  })
  const payload = /** @type {{ error: { code: string } }} */ (await response.json())

  assert.equal(response.status, 401)
  assert.equal(payload.error.code, 'unauthorized')
})

test('Hono dashboard mutation routes report unsupported hosted capabilities', async () => {
  const app = api({}, hostedPlaceholderCapabilities())

  const response = await app.request('/api/files/open', {
    method: 'POST',
    headers: { 'x-nax-token': 'token-1' },
    body: '{"path":"/tmp/file"}',
  })
  const payload = /** @type {{ error: { code: string } }} */ (await response.json())

  assert.equal(response.status, 501)
  assert.equal(payload.error.code, 'unsupported_capability')
})

test('Hono dashboard mutation routes delegate dry-run, start, cancel, and follow-up services', async () => {
  const calls = []
  const app = api({
    dryRunWorkflow: async (id, body) => {
      calls.push({ name: 'dryRunWorkflow', id, body })
      return { statusCode: 200, body: { dryRun: { exitCode: 0 } } }
    },
    startWorkflow: async (id, body) => {
      calls.push({ name: 'startWorkflow', id, body })
      return { statusCode: 202, body: { run: { id: 'run-1' } } }
    },
    cancelRun: async (id, body) => {
      calls.push({ name: 'cancelRun', id, body })
      return { body: { cancelled: true } }
    },
    submitFollowup: async (id, body) => {
      calls.push({ name: 'submitFollowup', id, body })
      return { statusCode: 202, body: { followup: { id: 'followup-1' } } }
    },
  })
  const headers = { 'x-nax-token': 'token-1' }

  assert.equal((await app.request('/api/workflows/review/dry-run', { method: 'POST', headers, body: '{"branch":"main"}' })).status, 200)
  assert.equal((await app.request('/api/workflows/review/runs', { method: 'POST', headers, body: '{}' })).status, 202)
  assert.equal((await app.request('/api/runs/run-1/cancel', { method: 'POST', headers, body: '{}' })).status, 200)
  assert.equal((await app.request('/api/runs/run-1/followups', { method: 'POST', headers, body: '{"prompt":"next"}' })).status, 202)

  assert.deepEqual(calls.map((call) => call.name), ['dryRunWorkflow', 'startWorkflow', 'cancelRun', 'submitFollowup'])
  assert.deepEqual(calls[0], { name: 'dryRunWorkflow', id: 'review', body: { branch: 'main' } })
})

test('Hono dashboard mutation routes map service null and invalid JSON', async () => {
  const app = api({
    cancelRun: async () => null,
  })
  const headers = { 'x-nax-token': 'token-1' }

  const missing = await app.request('/api/runs/missing/cancel', { method: 'POST', headers, body: '{}' })
  const missingPayload = /** @type {{ error: { code: string } }} */ (await missing.json())
  assert.equal(missing.status, 404)
  assert.equal(missingPayload.error.code, 'not_found')

  const invalid = await app.request('/api/runs/missing/cancel', { method: 'POST', headers, body: 'wat' })
  const invalidPayload = /** @type {{ error: { code: string } }} */ (await invalid.json())
  assert.equal(invalid.status, 400)
  assert.equal(invalidPayload.error.code, 'invalid_json')
})
