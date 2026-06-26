const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('stream')

const { errorPayload, requestError } = require('../../src/dashboard/api/errors')
const {
  sessionBootstrapHeadersForRequest,
  sessionCookieHeader,
  timingSafeTokenEqual,
  tokenFromRequest,
} = require('../../src/dashboard/api/auth')
const { readJsonBody } = require('../../src/dashboard/api/request')
const { securityHeaders } = require('../../src/dashboard/api/security')
const { inferRunStateStatus, projectRunSnapshot, publicFlow, publicRunOptions, publicRunState } = require('../../src/dashboard/api/serializers')

function requestWithBody(body) {
  const req = /** @type {Readable & { headers: Record<string, string> }} */ (Readable.from([body]))
  req.headers = {}
  return req
}

test('dashboard API errors keep the stable response shape', () => {
  assert.deepEqual(errorPayload(400, 'bad', 'Bad request'), {
    error: {
      statusCode: 400,
      code: 'bad',
      message: 'Bad request',
    },
  })
  const error = requestError(409, 'duplicate_run', 'Already running')
  assert.equal(error.statusCode, 409)
  assert.equal(error.code, 'duplicate_run')
  assert.equal(error.message, 'Already running')
})

test('dashboard API security headers include restrictive defaults', () => {
  const headers = securityHeaders()
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/)
})

test('dashboard API auth helpers support header and cookie tokens without query-string auth', () => {
  const token = 'secret-token'
  const queryReq = { headers: {} }
  const queryUrl = new URL(`http://127.0.0.1/?token=${encodeURIComponent(token)}`)
  assert.equal(tokenFromRequest(queryReq, queryUrl), '')
  assert.deepEqual(sessionBootstrapHeadersForRequest(queryReq, queryUrl, token), {})

  const headerReq = { headers: { 'x-nax-token': token } }
  assert.equal(tokenFromRequest(headerReq, new URL('http://127.0.0.1/')), token)
  assert.deepEqual(sessionBootstrapHeadersForRequest(headerReq, new URL('http://127.0.0.1/'), token), {
    'set-cookie': sessionCookieHeader(token),
  })
  assert.deepEqual(sessionBootstrapHeadersForRequest(headerReq, new URL('https://example.netlify.app/'), token, { secure: true }), {
    'set-cookie': sessionCookieHeader(token, { secure: true }),
  })
  assert.match(sessionCookieHeader(token, { secure: true }), /; Secure$/)

  const cookieReq = { headers: { cookie: sessionCookieHeader(token) } }
  assert.equal(tokenFromRequest(cookieReq, new URL('http://127.0.0.1/')), token)
  assert.equal(timingSafeTokenEqual(token, token), true)
  assert.equal(timingSafeTokenEqual(token, 'other'), false)
})

test('dashboard API readJsonBody parses empty, valid, invalid, and oversized bodies', async () => {
  assert.deepEqual(await readJsonBody(requestWithBody('')), {})
  assert.deepEqual(await readJsonBody(requestWithBody('{"ok":true}')), { ok: true })
  await assert.rejects(readJsonBody(requestWithBody('{')), {
    statusCode: 400,
    code: 'invalid_json',
  })
  await assert.rejects(readJsonBody(requestWithBody('{"too":"large"}'), { maxBytes: 4 }), {
    statusCode: 413,
    code: 'payload_too_large',
  })
})

test('dashboard API serializers keep public workflow and run shapes', () => {
  const flow = publicFlow({
    id: 'review',
    title: 'Review',
    steps: [{
      id: 'one',
      title: 'One',
      agents: ['codex'],
      input: ['previous'],
      review: { type: 'human' },
    }],
  })
  assert.deepEqual(flow.steps[0], {
    id: 'one',
    title: 'One',
    description: '',
    prompt: '',
    type: '',
    action: '',
    submit: '',
    agents: ['codex'],
    input: ['previous'],
    waitFor: '',
    review: { type: 'human' },
    autoArchive: undefined,
    isArchivable: undefined,
  })

  const runState = {
    runId: 'run-1',
    flowId: 'review',
    status: '',
    branch: 'main',
    options: {
      transport: 'netlify-api',
      models: ['codex'],
      stepModels: { one: ['codex'] },
    },
    steps: [{ id: 'one', status: 'completed', runs: [] }],
  }
  assert.equal(inferRunStateStatus(runState), 'completed')
  assert.equal(publicRunState(runState).resumable, false)
  assert.deepEqual(publicRunOptions(runState), {
    branch: 'main',
    target: null,
    transport: 'netlify-api',
    models: ['codex'],
    stepModels: { one: ['codex'] },
    context: '',
    step: '',
    fromStep: '',
  })
})

test('dashboard run projection upgrades stale non-terminal workflow status from steps', () => {
  const snapshot = projectRunSnapshot({
    runId: 'run-1',
    flowId: 'review',
    status: 'running',
    steps: [
      { id: 'one', status: 'completed', runs: [{ agent: 'codex', status: 'completed' }] },
      { id: 'two', status: 'complete', runs: [{ agent: 'gemini', status: 'complete' }] },
    ],
  })

  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.steps[1].status, 'completed')
  assert.equal(snapshot.steps[1].runs[0].status, 'completed')
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'workflow_status_conflict'), true)
})

test('dashboard run projection treats active remote agent runs as conflicting authority', () => {
  const snapshot = projectRunSnapshot({
    runId: 'run-1',
    flowId: 'review',
    status: 'completed',
    steps: [{
      id: 'review',
      status: 'completed',
      runs: [{ agent: 'codex', runnerId: 'runner-1', status: 'submitted' }],
    }],
  }, { cancellable: true })

  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.cancellable, true)
  assert.equal(snapshot.steps[0].status, 'running')
  assert.equal(snapshot.steps[0].runs[0].status, 'running')
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
    'step_status_conflict',
    'workflow_status_conflict',
  ])
})
