const assert = require('assert/strict')
const test = require('node:test')

const { createNetlifyDashboardFunction } = require('../../src/dashboard/runtime/netlify-function')
const { createHostedNetlifyApiTransport, dashboardStatus, idempotencyKey } = require('../../src/dashboard/transports/netlify-api')

function remoteRun(overrides = {}) {
  return {
    runnerId: 'runner-1',
    sessionId: 'session-1',
    state: 'submitted',
    status: 'submitted',
    links: { url: 'https://app.netlify.com/runner-1' },
    raw: { id: 'runner-1' },
    ...overrides,
  }
}

test('hosted Netlify API transport starts runs and deduplicates idempotent submissions', async () => {
  const calls = []
  const transport = createHostedNetlifyApiTransport({
    siteId: 'site-1',
    client: {
      createAgentRunner: async (input) => {
        calls.push(input)
        return remoteRun()
      },
      cancelAgentRunner: async () => remoteRun({ status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async () => remoteRun({ status: 'running', state: 'running' }),
    },
  })
  const body = { prompt: 'Review this', agent: 'codex', branch: 'main' }

  const first = await transport.startWorkflowRun('review', body)
  const second = await transport.startWorkflowRun('review', body)

  assert.equal(first.statusCode, 202)
  assert.equal(first.body.duplicate, false)
  assert.equal(first.body.run.runnerId, 'runner-1')
  assert.equal(second.body.duplicate, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].siteId, 'site-1')
  assert.equal(calls[0].source.idempotencyKey, idempotencyKey('review', body))
})

test('hosted Netlify API transport validates start prompt and maps cancel responses', async () => {
  const transport = createHostedNetlifyApiTransport({
    client: {
      createAgentRunner: async () => remoteRun(),
      cancelAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'running', state: 'running' }),
    },
  })

  await assert.rejects(
    () => transport.startWorkflowRun('review', {}),
    (error) => {
      const typed = /** @type {{ code?: string, statusCode?: number }} */ (error)
      assert.equal(typed.code, 'runner_validation_failed')
      assert.equal(typed.statusCode, 400)
      return true
    }
  )

  const cancelled = await transport.cancelRun('runner-1')
  assert.equal(cancelled.body.cancelled, true)
  assert.equal(cancelled.body.run.status, 'cancelled')
  assert.equal(cancelled.body.remoteStopped, 1)
})

test('hosted Hono mutation routes use Netlify API transport when configured', async () => {
  const handler = createNetlifyDashboardFunction({
    token: 'dashboard-token',
    siteId: 'site-1',
    netlifyApiClient: {
      createAgentRunner: async () => remoteRun(),
      cancelAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'running', state: 'running' }),
    },
  })

  const start = await handler({
    httpMethod: 'POST',
    path: '/api/workflows/review/runs',
    headers: { 'x-nax-token': 'dashboard-token' },
    body: '{"prompt":"Review this","agent":"codex"}',
  })
  const startPayload = /** @type {{ run: { runnerId: string }, duplicate: boolean }} */ (JSON.parse(start.body))
  assert.equal(start.statusCode, 202)
  assert.equal(startPayload.run.runnerId, 'runner-1')
  assert.equal(startPayload.duplicate, false)

  const cancel = await handler({
    httpMethod: 'POST',
    path: '/api/runs/runner-1/cancel',
    headers: { 'x-nax-token': 'dashboard-token' },
    body: '{}',
  })
  const cancelPayload = /** @type {{ cancelled: boolean, run: { status: string } }} */ (JSON.parse(cancel.body))
  assert.equal(cancel.statusCode, 200)
  assert.equal(cancelPayload.cancelled, true)
  assert.equal(cancelPayload.run.status, 'cancelled')
})

test('hosted Hono mutation routes preserve Netlify API transport error codes', async () => {
  const authError = /** @type {Error & { code?: string, statusCode?: number }} */ (new Error('No token'))
  authError.code = 'runner_auth_failed'
  authError.statusCode = 401
  const notFound = /** @type {Error & { code?: string, statusCode?: number }} */ (new Error('Missing runner'))
  notFound.code = 'runner_not_found'
  notFound.statusCode = 404
  const handler = createNetlifyDashboardFunction({
    token: 'dashboard-token',
    netlifyApiClient: {
      createAgentRunner: async () => { throw authError },
      cancelAgentRunner: async () => { throw notFound },
      getAgentRunner: async () => { throw notFound },
    },
  })

  const start = await handler({
    httpMethod: 'POST',
    path: '/api/workflows/review/runs',
    headers: { 'x-nax-token': 'dashboard-token' },
    body: '{"prompt":"Review this"}',
  })
  const startPayload = /** @type {{ error: { code: string } }} */ (JSON.parse(start.body))
  assert.equal(start.statusCode, 401)
  assert.equal(startPayload.error.code, 'runner_auth_failed')

  const cancel = await handler({
    httpMethod: 'POST',
    path: '/api/runs/missing/cancel',
    headers: { 'x-nax-token': 'dashboard-token' },
    body: '{}',
  })
  const cancelPayload = /** @type {{ error: { code: string } }} */ (JSON.parse(cancel.body))
  assert.equal(cancel.statusCode, 404)
  assert.equal(cancelPayload.error.code, 'runner_not_found')
})

test('hosted Netlify API transport maps polling statuses and events', async () => {
  assert.equal(dashboardStatus('queued'), 'submitted')
  assert.equal(dashboardStatus('in_progress'), 'running')
  assert.equal(dashboardStatus('success'), 'completed')
  assert.equal(dashboardStatus('timed_out'), 'failed')
  assert.equal(dashboardStatus('canceled'), 'cancelled')

  const transport = createHostedNetlifyApiTransport({
    client: {
      createAgentRunner: async () => remoteRun(),
      cancelAgentRunner: async () => remoteRun({ status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async () => remoteRun({ runnerId: 'runner-2', sessionId: 'session-2', status: 'in_progress', state: 'in_progress' }),
    },
  })
  const run = await transport.getRun('runner-2')
  assert.equal(run.status, 'running')
  assert.equal(run.runnerId, 'runner-2')

  const replay = await transport.listEvents({ runId: 'runner-2', since: 0 })
  assert.equal(replay.run.status, 'running')
  assert.equal(replay.events[0].type, 'runner_status')
  assert.equal(replay.events[0].runnerId, 'runner-2')
  assert.equal(replay.polling, true)

  const skipped = await transport.listEvents({ runId: 'runner-2', since: 1 })
  assert.equal(skipped.events.length, 0)
})

test('hosted Hono read routes poll Netlify API transport', async () => {
  const handler = createNetlifyDashboardFunction({
    token: 'dashboard-token',
    netlifyApiClient: {
      createAgentRunner: async () => remoteRun(),
      cancelAgentRunner: async () => remoteRun({ status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'completed', state: 'completed' }),
    },
  })
  const headers = { 'x-nax-token': 'dashboard-token' }

  const run = await handler({ httpMethod: 'GET', path: '/api/runs/runner-3', headers })
  const runPayload = /** @type {{ run: { status: string, runnerId: string } }} */ (JSON.parse(run.body))
  assert.equal(run.statusCode, 200)
  assert.equal(runPayload.run.status, 'completed')
  assert.equal(runPayload.run.runnerId, 'runner-3')

  const events = await handler({ httpMethod: 'GET', path: '/api/runs/runner-3/events.json', headers })
  const eventsPayload = /** @type {{ events: Array<{ type: string }>, polling: boolean }} */ (JSON.parse(events.body))
  assert.equal(events.statusCode, 200)
  assert.equal(eventsPayload.events[0].type, 'runner_status')
  assert.equal(eventsPayload.polling, true)
})

test('hosted Netlify API transport submits remote-safe follow-ups', async () => {
  const calls = []
  const transport = createHostedNetlifyApiTransport({
    siteId: 'site-1',
    client: {
      createAgentRunner: async (input) => {
        calls.push(input)
        return remoteRun({
          runnerId: `runner-${calls.length}`,
          sessionId: `session-${calls.length}`,
          status: 'queued',
          state: 'queued',
          links: { url: `https://app.netlify.com/runner-${calls.length}` },
        })
      },
      cancelAgentRunner: async () => remoteRun({ status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async () => remoteRun({ status: 'running', state: 'running' }),
    },
  })

  const response = await transport.submitFollowup('runner-source', {
    prompt: 'Please continue',
    models: ['codex', 'claude'],
    branch: 'main',
    artifacts: [{
      id: 'summary',
      kind: 'markdown',
      url: 'https://example.netlify.app/artifacts/summary.md',
      filePath: '/Users/david/project/.nax/workflows/run/artifacts/summary.md',
    }],
    contextText: 'Remote summary excerpt',
  })

  assert.equal(response.statusCode, 202)
  assert.equal(response.body.status, 'submitted')
  assert.equal(response.body.context.artifactCount, 1)
  assert.equal(response.body.context.artifacts[0].url, 'https://example.netlify.app/artifacts/summary.md')
  assert.equal(Object.hasOwn(response.body.context.artifacts[0], 'filePath'), false)
  assert.deepEqual(response.body.submissions.map((submission) => submission.agent), ['codex', 'claude'])
  assert.equal(response.body.submissions[0].runnerArtifactPath, '')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].siteId, 'site-1')
  assert.equal(calls[0].source.sourceWorkflowRunId, 'runner-source')
  assert.deepEqual(calls[0].source.sourceArtifactIds, ['summary'])
  assert.match(calls[0].promptText, /Remote artifact references/)
})

test('hosted Netlify API transport validates follow-up prompt and unsupported modes', async () => {
  const transport = createHostedNetlifyApiTransport({
    client: {
      createAgentRunner: async () => remoteRun(),
      cancelAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async () => remoteRun({ status: 'running', state: 'running' }),
    },
  })

  await assert.rejects(
    () => transport.submitFollowup('runner-source', {}),
    (error) => {
      const typed = /** @type {{ code?: string, statusCode?: number }} */ (error)
      assert.equal(typed.code, 'missing_prompt')
      assert.equal(typed.statusCode, 400)
      return true
    }
  )
  await assert.rejects(
    () => transport.submitFollowup('runner-source', { prompt: 'next', mode: 'follow-up-thread' }),
    (error) => {
      const typed = /** @type {{ code?: string, statusCode?: number }} */ (error)
      assert.equal(typed.code, 'unsupported_followup_mode')
      assert.equal(typed.statusCode, 501)
      return true
    }
  )

  const cancelled = await transport.cancelFollowup('runner-source', { runnerId: 'runner-followup' })
  assert.equal(cancelled.body.cancelled, true)
  assert.equal(cancelled.body.run.runnerId, 'runner-followup')
})

test('hosted Hono follow-up routes use Netlify API transport when configured', async () => {
  const createCalls = []
  const handler = createNetlifyDashboardFunction({
    token: 'dashboard-token',
    siteId: 'site-1',
    netlifyApiClient: {
      createAgentRunner: async (input) => {
        createCalls.push(input)
        return remoteRun({ runnerId: 'runner-followup', sessionId: 'session-followup', status: 'submitted', state: 'submitted' })
      },
      cancelAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async (input) => remoteRun({ runnerId: input.runnerId || '', status: 'running', state: 'running' }),
    },
  })

  const followup = await handler({
    httpMethod: 'POST',
    path: '/api/runs/runner-source/followups',
    headers: { 'x-nax-token': 'dashboard-token' },
    body: '{"prompt":"Continue from the remote artifact","artifacts":[{"id":"summary","url":"https://example.netlify.app/summary.md"}]}',
  })
  const followupPayload = /** @type {{ submissions: Array<{ runnerId: string }>, context: { artifacts: Array<{ url: string, filePath?: string }> } }} */ (JSON.parse(followup.body))
  assert.equal(followup.statusCode, 202)
  assert.equal(followupPayload.submissions[0].runnerId, 'runner-followup')
  assert.equal(followupPayload.context.artifacts[0].filePath, undefined)
  assert.equal(createCalls[0].source.sourceWorkflowRunId, 'runner-source')

  const cancel = await handler({
    httpMethod: 'POST',
    path: '/api/runs/runner-source/followups/cancel',
    headers: { 'x-nax-token': 'dashboard-token' },
    body: '{"runnerId":"runner-followup"}',
  })
  const cancelPayload = /** @type {{ cancelled: boolean, run: { status: string } }} */ (JSON.parse(cancel.body))
  assert.equal(cancel.statusCode, 200)
  assert.equal(cancelPayload.cancelled, true)
  assert.equal(cancelPayload.run.status, 'cancelled')
})

test('hosted Netlify API transport normalizes run details and expands selected artifacts', async () => {
  const calls = []
  const transport = createHostedNetlifyApiTransport({
    client: {
      createAgentRunner: async (input) => {
        calls.push(input)
        return remoteRun({ runnerId: 'runner-followup', sessionId: 'session-followup' })
      },
      cancelAgentRunner: async () => remoteRun({ status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async (input) => remoteRun({
        runnerId: input.runnerId || '',
        sessionId: 'session-remote',
        status: 'success',
        state: 'success',
        raw: {
          id: input.runnerId || '',
          agent: 'codex',
          summary: '# Hosted result\n\nDone.',
          artifacts: [{
            id: 'summary',
            kind: 'runner-summary',
            label: 'Runner summary',
            url: 'https://example.netlify.app/summary.md',
            sizeBytes: 42,
            filePath: '/Users/david/project/.nax/local-only.md',
          }],
        },
      }),
    },
  })

  const details = await transport.getRunDetails('runner-source')
  assert.equal(details.run.status, 'completed')
  assert.equal(details.details.finalMarkdown, '# Hosted result\n\nDone.')
  assert.equal(details.details.followupTargets[0].defaultMode, 'fresh-runner')
  assert.equal(details.details.followupTargets[0].absolutePath, '')
  assert.equal(details.details.followupArtifacts[0].id, 'summary')
  assert.equal(details.details.followupArtifacts[0].url, 'https://example.netlify.app/summary.md')
  assert.equal(Object.hasOwn(details.details.followupArtifacts[0], 'filePath'), false)

  await transport.submitFollowup('runner-source', {
    prompt: 'Continue',
    artifacts: [{ id: 'summary', kind: 'runner-summary' }],
  })
  assert.deepEqual(calls[0].source.sourceArtifactIds, ['summary'])
  assert.match(calls[0].promptText, /https:\/\/example\.netlify\.app\/summary\.md/)
})

test('hosted Hono details, graph, and local file routes reflect hosted runtime limits', async () => {
  const handler = createNetlifyDashboardFunction({
    token: 'dashboard-token',
    netlifyApiClient: {
      createAgentRunner: async () => remoteRun(),
      cancelAgentRunner: async () => remoteRun({ status: 'cancelled', state: 'cancelled' }),
      getAgentRunner: async (input) => remoteRun({
        runnerId: input.runnerId || '',
        sessionId: 'session-remote',
        status: 'running',
        state: 'running',
        raw: {
          id: input.runnerId || '',
          agent: 'codex',
          result: 'Hosted output',
          artifacts: [{ id: 'log', kind: 'runner-summary', url: 'https://example.netlify.app/log.md' }],
        },
      }),
    },
  })
  const headers = { 'x-nax-token': 'dashboard-token' }

  const details = await handler({ httpMethod: 'GET', path: '/api/runs/runner-source/details', headers })
  const detailsPayload = /** @type {{ details: { followupArtifacts: Array<{ absolutePath: string, url?: string }>, finalMarkdown: string } }} */ (JSON.parse(details.body))
  assert.equal(details.statusCode, 200)
  assert.equal(detailsPayload.details.finalMarkdown, 'Hosted output')
  assert.equal(detailsPayload.details.followupArtifacts[0].absolutePath, '')
  assert.equal(detailsPayload.details.followupArtifacts[0].url, 'https://example.netlify.app/log.md')

  const graph = await handler({ httpMethod: 'GET', path: '/api/runs/runner-source/graph', headers })
  const graphPayload = /** @type {{ graph: { nodes: Array<{ id: string }>, metadata: { source: string } } }} */ (JSON.parse(graph.body))
  assert.equal(graph.statusCode, 200)
  assert.equal(graphPayload.graph.nodes[0].id, 'hosted-runner')
  assert.equal(graphPayload.graph.metadata.source, 'hosted')

  const open = await handler({
    httpMethod: 'POST',
    path: '/api/files/open',
    headers,
    body: '{"path":"/tmp/nope"}',
  })
  const openPayload = /** @type {{ error: { code: string } }} */ (JSON.parse(open.body))
  assert.equal(open.statusCode, 501)
  assert.equal(openPayload.error.code, 'unsupported_capability')
})
