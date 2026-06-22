const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const { _private, startDashboardServer } = require('../../src/dashboard/server')
const { buildRunDetails } = require('../../src/dashboard/shared/run-details')
const { appendFollowupRunsToWorkflow } = require('../../src/followup-persistence')
const { appendEventLog } = require('../../src/runner-event-log')

/** @param {string} url @param {{ token?: string, cookie?: string, headers?: Record<string, string> }} [options] */
function requestJson(url, { token, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, {
      headers: {
        ...headers,
        ...(token ? { 'x-nax-token': token } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        const payload = body ? JSON.parse(body) : null
        resolve({ statusCode: res.statusCode, headers: res.headers, payload })
      })
    }).on('error', reject)
  })
}

/** @param {string} url @param {{ token?: string, cookie?: string, headers?: Record<string, string> }} [options] */
function requestText(url, { token, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, {
      headers: {
        ...headers,
        ...(token ? { 'x-nax-token': token } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }))
    }).on('error', reject)
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function postJson(url, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {})
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(token ? { 'x-nax-token': token } : {}),
      },
    }, (res) => {
      let responseBody = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { responseBody += chunk })
      res.on('end', () => {
        const payload = responseBody ? JSON.parse(responseBody) : null
        resolve({ statusCode: res.statusCode, headers: res.headers, payload })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-server-'))
}

test('run details follow-up targets are labelled by step and sorted newest first', () => {
  const projectRoot = tmpRoot()
  const runDir = path.join(projectRoot, '.nax', 'workflows', 'run-1')
  const firstStepDir = path.join(runDir, 'artifacts', 'steps', '01-review')
  const secondStepDir = path.join(runDir, 'artifacts', 'steps', '02-cross-review')
  fs.mkdirSync(firstStepDir, { recursive: true })
  fs.mkdirSync(secondStepDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'artifacts', 'summary.md'), '# Workflow\n')
  fs.writeFileSync(path.join(firstStepDir, 'step.json'), JSON.stringify({ id: 'review', title: 'Review', status: 'completed' }))
  fs.writeFileSync(path.join(firstStepDir, 'summary.md'), '# Review\n')
  fs.writeFileSync(path.join(secondStepDir, 'step.json'), JSON.stringify({ id: 'cross-review', title: 'Cross Review', status: 'completed' }))
  fs.writeFileSync(path.join(secondStepDir, 'summary.md'), '# Cross Review\n')

  const details = buildRunDetails({ dir: runDir, status: 'completed' })

  assert.deepEqual(details.followupTargets.map((target) => target.label), [
    'Step 2: Cross Review step summary',
    'Step 1: Review step summary',
    'Workflow summary',
  ])
  assert.deepEqual(details.followupArtifacts.filter((artifact) => !artifact.advanced).map((artifact) => artifact.label), [
    'Workflow summary',
    'Step 2: Cross Review step summary',
    'Step 1: Review step summary',
  ])
  assert.equal(details.followupTargets[0].stepNumber, 2)
  assert.equal(details.followupArtifacts[0].stepNumber, 0)
  assert.equal(details.followupArtifacts[0].defaultSelected, true)
  assert.equal(details.followupTargets[0].isDefault, true)
})

function writeProjectFlow(projectRoot, id, { title = id } = {}) {
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    `title: ${title}`,
    'description: Project-local dashboard flow',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    title: One',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), '---\ntitle: One\n---\n\nPrompt\n')
}

function writeFollowupRunFixture(projectRoot, runId = 'fixture-followup-run') {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    transport: 'netlify-api',
    branch: 'main',
    target: {
      branch: 'main',
      sha: '0123456789abcdef0123456789abcdef01234567',
      sourceType: 'current-branch',
    },
    options: {
      branch: 'main',
      transport: 'netlify-api',
      stepModels: {
        review: ['codex'],
      },
    },
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:01:00.000Z',
    dir,
    flow: {
      id: 'review',
      title: 'Review',
      steps: [
        { id: 'review', title: 'Review', agents: ['codex'], submit: 'new-run' },
      ],
    },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
    }],
  }, null, 2))
  const artifactsDir = path.join(dir, 'artifacts')
  const stepDir = path.join(artifactsDir, 'steps', '01-review')
  const runnerDir = path.join(stepDir, 'agent-runners')
  fs.mkdirSync(runnerDir, { recursive: true })
  fs.writeFileSync(path.join(artifactsDir, 'summary.md'), '# Review summary\n\nFinal workflow summary.\n')
  fs.writeFileSync(path.join(stepDir, 'step.json'), JSON.stringify({
    id: 'review',
    title: 'Review',
    status: 'completed',
  }, null, 2))
  fs.writeFileSync(path.join(stepDir, 'summary.md'), '# Review\n\nStep summary.\n')
  fs.writeFileSync(path.join(runnerDir, 'codex.json'), JSON.stringify({
    stepId: 'review',
    agent: 'codex',
    status: 'completed',
    runnerId: 'runner-1',
    sessionId: 'session-1',
  }, null, 2))
  fs.writeFileSync(path.join(runnerDir, 'codex.md'), '# Codex result\n\nFinal result text.\n')
  return { runId, dir, artifactsDir, stepDir, runnerDir }
}

test('dashboard extracts durable workflow run id from runner output', () => {
  const output = [
    'Run 2026-06-19T04-40-05-602Z-do-next',
    'Flow: Do Next',
    'State: /repo/.nax/workflows/2026-06-19T04-40-05-602Z-do-next/workflow.json',
  ].join('\n')

  assert.equal(_private.extractDurableRunId(output), '2026-06-19T04-40-05-602Z-do-next')
})

test('dashboard builds compact step status snapshots from workflow state', () => {
  const snapshot = _private.stepStatusSnapshot({
    steps: [
      { id: 'review', title: 'Review', status: 'running', agents: ['claude', 'codex'], runs: [{}, {}] },
      { id: 'synthesize', title: 'Synthesize', status: 'completed', agents: ['codex'], runs: [{}] },
      { title: 'Missing id', status: 'running' },
    ],
  })

  assert.deepEqual(snapshot, [
    {
      stepId: 'review',
      title: 'Review',
      status: 'running',
      agents: ['claude', 'codex'],
      runCount: 2,
    },
    {
      stepId: 'synthesize',
      title: 'Synthesize',
      status: 'completed',
      agents: ['codex'],
      runCount: 1,
    },
  ])
})

test('dashboard parses runner event JSONL across chunks and reports malformed lines', () => {
  const events = []
  const errors = []
  const parser = _private.createRunnerEventParser({
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  })

  parser.push('{"type":"workflow_started","seq":1')
  parser.push(',"runId":"run-1"}\nnot-json\n{"type":"unknown_future_event","seq":2}\n')
  parser.push('{"seq":3}\n{"type":"tail","seq":4}')
  parser.end()

  assert.deepEqual(events.map((event) => event.type), ['workflow_started', 'unknown_future_event', 'tail'])
  assert.equal(errors.length, 2)
  assert.equal(errors[0].code, 'parse_runner_event')
  assert.equal(errors[1].code, 'missing_runner_event_type')
})

test('dashboard server exposes health, workflow list, and graph routes', async () => {
  const server = await startDashboardServer({ projectRoot: process.cwd(), initialWorkflow: 'review' })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const health = await requestJson(`${base}/api/health`)
    assert.equal(health.statusCode, 200)
    assert.equal(health.payload.ok, true)
    assert.equal(health.payload.projectRoot, process.cwd())
    assert.equal(health.payload.tokenRequiredForSensitiveReads, true)

    const workflows = await requestJson(`${base}/api/workflows`)
    assert.equal(workflows.statusCode, 200)
    assert.ok(workflows.payload.count >= 14)
    assert.ok(workflows.payload.items.some((workflow) => workflow.id === 'review'))

    const unauthenticatedGraph = await requestJson(`${base}/api/workflows/review/graph`)
    assert.equal(unauthenticatedGraph.statusCode, 401)

    const graph = await requestJson(`${base}/api/workflows/review/graph`, { token: server.token })
    assert.equal(graph.statusCode, 200)
    assert.equal(graph.payload.workflow.id, 'review')
    assert.equal(graph.payload.graph.nodes.length, 3)
    assert.equal(graph.payload.graph.edges.length, 2)
  } finally {
    await server.close()
  }
})

test('dashboard server requires auth for sensitive run reads and rejects untrusted Host headers', async () => {
  const projectRoot = tmpRoot()
  const { runId } = writeFollowupRunFixture(projectRoot, 'secure-run')
  const server = await startDashboardServer({ projectRoot })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const unauthenticatedRuns = await requestJson(`${base}/api/runs`)
    assert.equal(unauthenticatedRuns.statusCode, 401)

    const authenticatedRuns = await requestJson(`${base}/api/runs`, { token: server.token })
    assert.equal(authenticatedRuns.statusCode, 200)

    const unauthenticatedDetails = await requestJson(`${base}/api/runs/${runId}/details`)
    assert.equal(unauthenticatedDetails.statusCode, 401)

    const authenticatedDetails = await requestJson(`${base}/api/runs/${runId}/details`, { token: server.token })
    assert.equal(authenticatedDetails.statusCode, 200)

    const cookie = _private.sessionCookieHeader(server.token)
    const cookieDetails = await requestJson(`${base}/api/runs/${runId}/details`, { cookie })
    assert.equal(cookieDetails.statusCode, 200)

    const rejectedHost = await requestJson(`${base}/api/health`, { headers: { host: 'evil.example' } })
    assert.equal(rejectedHost.statusCode, 403)
    assert.equal(authenticatedDetails.headers['x-content-type-options'], 'nosniff')
    assert.equal(authenticatedDetails.headers['referrer-policy'], 'no-referrer')
  } finally {
    await server.close()
  }
})

test('dashboard server startup url does not include the session token', async () => {
  const server = await startDashboardServer({ projectRoot: process.cwd(), initialWorkflow: 'review' })
  try {
    assert.doesNotMatch(server.url, new RegExp(server.token))
    assert.doesNotMatch(server.url, /token=/)
    assert.match(server.url, /workflow=review/)
  } finally {
    await server.close()
  }
})

test('dashboard html bootstraps auth with an httpOnly session cookie', async () => {
  const server = await startDashboardServer({ projectRoot: process.cwd(), initialWorkflow: 'review', distDir: path.join(os.tmpdir(), 'missing-nax-dist') })
  try {
    const html = await requestText(`http://127.0.0.1:${server.port}/`)
    assert.equal(html.statusCode, 200)
    assert.doesNotMatch(html.body, new RegExp(server.token))
    assert.match(String(html.headers['set-cookie'] || ''), /nax_dashboard_token=/)
    assert.match(String(html.headers['set-cookie'] || ''), /HttpOnly/)
    assert.match(String(html.headers['set-cookie'] || ''), /SameSite=Strict/)
  } finally {
    await server.close()
  }
})

test('dashboard server discovers project workflows before bundled workflows', async () => {
  const projectRoot = tmpRoot()
  writeProjectFlow(projectRoot, 'conversion-audit', { title: 'Conversion Audit' })
  const server = await startDashboardServer({ projectRoot })
  try {
    const workflows = await requestJson(`http://127.0.0.1:${server.port}/api/workflows`)
    assert.equal(workflows.statusCode, 200)
    assert.equal(workflows.payload.items[0].id, 'conversion-audit')
    assert.equal(workflows.payload.items[0].source, 'project')
    assert.equal(workflows.payload.items[0].sourceLabel, 'project .github/nax-flows')
  } finally {
    await server.close()
  }
})

test('dashboard server returns structured 404 for unknown workflows', async () => {
  const server = await startDashboardServer({ projectRoot: process.cwd() })
  try {
    const response = await requestJson(`http://127.0.0.1:${server.port}/api/workflows/nope/graph`, { token: server.token })
    assert.equal(response.statusCode, 404)
    assert.equal(response.payload.error.code, 'not_found')
    assert.match(response.payload.error.message, /Unknown flow "nope"/)
  } finally {
    await server.close()
  }
})

test('dashboard server serves built static assets when dist exists', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-dist-'))
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(distDir, 'index.html'), '<script type="module" src="/assets/app.js"></script>')
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("ok")\n')

  const server = await startDashboardServer({ projectRoot: process.cwd(), distDir })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const html = await requestText(`${base}/`)
    assert.equal(html.statusCode, 200)
    assert.match(html.body, /assets\/app\.js/)

    const script = await requestText(`${base}/assets/app.js`)
    assert.equal(script.statusCode, 200)
    assert.match(String(script.headers['content-type']), /text\/javascript/)
    assert.equal(script.body, 'console.log("ok")\n')
  } finally {
    await server.close()
  }
})

test('dashboard dry-run requires token and validates options', async () => {
  const server = await startDashboardServer({ projectRoot: process.cwd() })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const missingToken = await postJson(`${base}/api/workflows/review/dry-run`, '', {})
    assert.equal(missingToken.statusCode, 401)
    assert.equal(missingToken.payload.error.code, 'unauthorized')

    const invalidStep = await postJson(`${base}/api/workflows/review/dry-run`, server.token, {
      step: 'missing-step',
    })
    assert.equal(invalidStep.statusCode, 400)
    assert.equal(invalidStep.payload.error.code, 'invalid_step')

    const invalidModel = await postJson(`${base}/api/workflows/review/dry-run`, server.token, {
      models: ['watson'],
    })
    assert.equal(invalidModel.statusCode, 400)
    assert.equal(invalidModel.payload.error.code, 'invalid_model')

    const invalidStepModel = await postJson(`${base}/api/workflows/review/dry-run`, server.token, {
      stepModels: {
        synthesize: ['claude'],
      },
    })
    assert.equal(invalidStepModel.statusCode, 400)
    assert.equal(invalidStepModel.payload.error.code, 'invalid_step_model')
  } finally {
    await server.close()
  }
})

test('dashboard dry-run returns preview output without writing artifacts', async () => {
  const projectRoot = tmpRoot()
  const server = await startDashboardServer({ projectRoot })
  try {
    const response = await postJson(`http://127.0.0.1:${server.port}/api/workflows/review/dry-run`, server.token, {
      transport: 'netlify-api',
      branch: 'master',
      stepModels: {
        review: ['claude', 'codex'],
        'cross-review': ['gemini'],
        synthesize: ['codex'],
      },
    })
    assert.equal(response.statusCode, 200, response.payload?.dryRun?.stderr || response.payload?.error?.message)
    assert.equal(response.payload.workflow.id, 'review')
    assert.equal(response.payload.dryRun.status, 'completed')
    assert.equal(response.payload.dryRun.exitCode, 0)
    assert.match(response.payload.dryRun.stdout, /Multi step agent workflow: "Review"/)
    assert.match(response.payload.dryRun.stdout, /Dry run only/)
    assert.deepEqual(response.payload.dryRun.command.slice(-6), [
      '--step-models',
      'review=claude,codex',
      '--step-models',
      'cross-review=gemini',
      '--step-models',
      'synthesize=codex',
    ])
    assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false)
  } finally {
    await server.close()
  }
})

test('dashboard tail streams dry-run output to the server console', async () => {
  const projectRoot = tmpRoot()
  const server = await startDashboardServer({ projectRoot, tail: true })
  const originalLog = console.log
  const lines = []
  console.log = (...args) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    const response = await postJson(`http://127.0.0.1:${server.port}/api/workflows/review/dry-run`, server.token, {
      transport: 'netlify-api',
      branch: 'master',
    })
    assert.equal(response.statusCode, 200, response.payload?.dryRun?.stderr || response.payload?.error?.message)
    assert.match(lines.join('\n'), /Multi step agent workflow: "Review"/)
    assert.match(response.payload.dryRun.stdout, /Multi step agent workflow: "Review"/)
  } finally {
    console.log = originalLog
    await server.close()
  }
})

test('dashboard real-run endpoint starts a tracked process and replays events', async () => {
  const projectRoot = tmpRoot()
  const server = await startDashboardServer({ projectRoot })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const unauthorized = await postJson(`${base}/api/workflows/review/runs`, '', {
      transport: 'auto',
    })
    assert.equal(unauthorized.statusCode, 401)

    const started = await postJson(`${base}/api/workflows/review/runs`, server.token, {
      transport: 'auto',
      branch: 'master',
      models: ['codex'],
    })
    assert.equal(started.statusCode, 202)
    assert.equal(started.payload.workflow.id, 'review')
    assert.equal(started.payload.run.status, 'running')
    assert.ok(started.payload.run.id)
    assert.equal(started.payload.run.command[0], 'nax')
    assert.notEqual(started.payload.run.command[0], process.execPath)

    await sleep(500)
    const detail = await requestJson(`${base}/api/runs/${encodeURIComponent(started.payload.run.id)}`, { token: server.token })
    assert.equal(detail.statusCode, 200)
    assert.ok(['running', 'failed', 'completed', 'cancelled'].includes(detail.payload.run.status))

    const events = await requestText(`${base}/api/runs/${encodeURIComponent(started.payload.run.id)}/events`, { token: server.token })
    assert.equal(events.statusCode, 200)
    assert.match(events.body, /event: started/)

    const cancel = await postJson(`${base}/api/runs/${encodeURIComponent(started.payload.run.id)}/cancel`, server.token, {})
    assert.equal(cancel.statusCode, 200)
    assert.equal(typeof cancel.payload.cancelled, 'boolean')
  } finally {
    await server.close()
  }
})

test('dashboard cancel endpoint stops durable workflow runners without a live run', async () => {
  const projectRoot = tmpRoot()
  const runId = 'fixture-durable-cancel'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    projectRoot,
    status: 'running',
    transport: 'netlify-api',
    branch: 'main',
    target: {
      branch: 'main',
      sha: '0123456789abcdef0123456789abcdef01234567',
      sourceType: 'explicit-branch',
      verified: true,
      caveats: [],
    },
    options: {
      branch: 'main',
      transport: 'netlify-api',
    },
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:01:00.000Z',
    dir,
    flow: {
      id: 'review',
      title: 'Review',
      steps: [
        { id: 'review', title: 'Review', agents: ['claude', 'gemini', 'codex'], submit: 'new-run' },
      ],
    },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'running',
      agents: ['claude', 'gemini', 'codex'],
      runs: [
        { agent: 'claude', status: 'pending' },
        { agent: 'gemini', status: 'submitted', runnerId: '' },
        { agent: 'codex', status: 'completed', runnerId: 'runner-codex' },
        { agent: 'claude-followup', status: 'submitted', runnerId: 'runner-source', existingRunnerId: 'runner-source' },
      ],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    JSON.stringify({
      schemaVersion: 1,
      seq: 1,
      eventId: `${runId}:1`,
      type: 'agent_status',
      at: '2026-06-21T00:00:30.000Z',
      runId,
      flowId: 'review',
      flowTitle: 'Review',
      projectRoot,
      transport: 'netlify-api',
      branch: 'main',
      stepId: 'review',
      stepTitle: 'Review',
      agent: 'gemini',
      status: 'submitted',
      runnerId: 'runner-gemini',
      sessionId: '',
      links: {
        agentRunUrl: 'https://app.netlify.com/projects/example/agent-runs/runner-gemini',
        sessionUrl: 'https://app.netlify.com/projects/example/agent-runs/runner-gemini',
      },
      submittedAfterSeconds: 11,
    }),
    '',
  ].join('\n'))

  const stopped = []
  const server = await startDashboardServer({
    projectRoot,
    cancelStopRun: async ({ runnerId }) => {
      stopped.push(runnerId)
      return { stopped: true, error: '' }
    },
  })
  try {
    const response = await postJson(`http://127.0.0.1:${server.port}/api/runs/${runId}/cancel`, server.token, {})
    assert.equal(response.statusCode, 200, response.payload?.error?.message)
    assert.equal(response.payload.cancelled, true)
    assert.equal(response.payload.remoteStopped, 1)
    assert.equal(response.payload.remoteStopAttempted, 1)
    assert.deepEqual(stopped, ['runner-gemini'])

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'))
    assert.equal(state.status, 'cancelled')
    assert.equal(state.steps[0].status, 'cancelled')
    assert.deepEqual(state.steps[0].runs.map((run) => run.status), ['cancelled', 'cancelled', 'completed', 'cancelled'])
    assert.equal(state.steps[0].runs[1].runnerId, 'runner-gemini')
    assert.equal(state.steps[0].runs[1].submittedAfterSeconds, 11)
    assert.deepEqual(state.remoteCancel.runnerIds, ['runner-gemini'])
    assert.deepEqual(state.remoteCancel.stopped, ['runner-gemini'])

    const eventTypes = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type)
    assert.deepEqual(eventTypes.slice(-2), ['remote_cancel_requested', 'workflow_cancelled'])
  } finally {
    await server.close()
  }
})

test('dashboard runs API reads durable workflow state from .nax', async () => {
  const projectRoot = tmpRoot()
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', 'review')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: review',
    'title: Review',
    'description: Project-local dashboard flow',
    'defaults:',
    '  agents: [claude, gemini, codex]',
    'steps:',
    '  - id: review',
    '    title: Review',
    '    prompt: prompts/review.md',
    '    agents: [claude, gemini, codex]',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'review.md'), '---\ntitle: Review\n---\n\nPrompt\n')
  const runId = 'fixture-run'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    transport: 'netlify-api',
    branch: 'main',
    target: {
      branch: 'main',
      ref: 'origin/main',
      sha: '0123456789abcdef0123456789abcdef01234567',
      sourceType: 'current-branch',
      verified: true,
      caveats: [],
    },
    options: {
      branch: 'main',
      transport: 'netlify-api',
      stepModels: {
        review: ['codex'],
      },
    },
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:01:00.000Z',
    dir,
    flow: {
      id: 'review',
      title: 'Review',
      steps: [
        { id: 'review', title: 'Review', agents: ['codex'], submit: 'new-run' },
      ],
    },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
    }],
  }, null, 2))
  const artifactsDir = path.join(dir, 'artifacts')
  const stepDir = path.join(artifactsDir, 'steps', '01-review')
  const runnerDir = path.join(stepDir, 'agent-runners')
  const externalRunnerDir = path.join(projectRoot, '.nax', 'agent-runners', 'runner-1')
  const externalSessionDir = path.join(projectRoot, '.nax', 'agent-sessions', 'session-1')
  fs.mkdirSync(runnerDir, { recursive: true })
  fs.mkdirSync(externalRunnerDir, { recursive: true })
  fs.mkdirSync(externalSessionDir, { recursive: true })
  fs.writeFileSync(path.join(artifactsDir, 'summary.md'), '# Review summary\n\nFinal workflow summary.\n')
  fs.writeFileSync(path.join(stepDir, 'step.json'), JSON.stringify({
    id: 'review',
    title: 'Review',
    status: 'completed',
  }, null, 2))
  fs.writeFileSync(path.join(stepDir, 'summary.md'), '# Review\n\nStep summary.\n')
  fs.writeFileSync(path.join(runnerDir, 'codex.json'), JSON.stringify({
    agent: 'codex',
    status: 'completed',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    links: {
      sessionUrl: 'https://example.test/session-1',
    },
  }, null, 2))
  fs.writeFileSync(path.join(runnerDir, 'codex.md'), '# Codex result\n\nFinal result text.\n')
  fs.writeFileSync(path.join(runnerDir, 'codex.attempt-1.md'), '# Codex attempt\n\nAttempt text.\n')
  fs.writeFileSync(path.join(externalRunnerDir, 'summary.md'), '# Runner summary\n\nRunner text.\n')
  fs.writeFileSync(path.join(externalSessionDir, 'summary.md'), '# Session summary\n\nSession text.\n')

  const server = await startDashboardServer({ projectRoot })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const runs = await requestJson(`${base}/api/runs`, { token: server.token })
    assert.equal(runs.statusCode, 200)
    assert.equal(runs.payload.durable.some((run) => run.runId === runId), true)
    assert.equal(runs.payload.durable.find((run) => run.runId === runId)?.target.branch, 'main')

    const detail = await requestJson(`${base}/api/runs/${runId}`, { token: server.token })
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.payload.run.runId, runId)
    assert.equal(detail.payload.run.status, 'completed')
    assert.equal(detail.payload.run.target.verified, true)

    const details = await requestJson(`${base}/api/runs/${runId}/details`, { token: server.token })
    assert.equal(details.statusCode, 200)
    assert.equal(details.payload.run.runId, runId)
    assert.match(details.payload.details.summaryMarkdown, /Review summary/)
    assert.equal(details.payload.details.summaryAbsolutePath, path.join(artifactsDir, 'summary.md'))
    assert.match(details.payload.details.finalMarkdown, /Final result text/)
    assert.equal(details.payload.details.sections.some((section) => section.kind === 'session' && section.agent === 'codex'), true)
    assert.equal(
      details.payload.details.sections.find((section) => section.kind === 'session' && section.agent === 'codex')?.absolutePath,
      path.join(runnerDir, 'codex.md'),
    )
    assert.equal(
      details.payload.details.sections.find((section) => section.kind === 'session' && section.agent === 'codex')?.promptMarkdown,
      'Prompt',
    )
    assert.equal(details.payload.details.followupTargets[0].kind, 'step-summary')
    assert.equal(details.payload.details.followupTargets[0].isDefault, true)
    assert.equal(details.payload.details.followupTargets[0].stepNumber, 1)
    assert.equal(details.payload.details.followupTargets[0].label, 'Step 1: Review step summary')
    assert.equal(details.payload.details.followupTargets[0].absolutePath, path.join(stepDir, 'summary.md'))
    assert.ok(details.payload.details.followupTargets.some((target) => (
      target.kind === 'agent-result' &&
      target.runnerId === 'runner-1' &&
      target.sessionId === 'session-1' &&
      target.defaultMode === 'follow-up-thread'
    )))
    assert.ok(details.payload.details.followupTargets.some((target) => target.kind === 'runner-summary'))
    assert.ok(details.payload.details.followupTargets.some((target) => target.kind === 'session-result'))
    const defaultArtifacts = details.payload.details.followupArtifacts.filter((artifact) => artifact.defaultSelected)
    assert.equal(defaultArtifacts.length, 1)
    assert.equal(defaultArtifacts[0].kind, 'workflow-summary')
    assert.equal(defaultArtifacts[0].label, 'Workflow summary')
    assert.equal(defaultArtifacts[0].stepNumber, 0)
    assert.equal(defaultArtifacts[0].absolutePath, path.join(artifactsDir, 'summary.md'))
    assert.ok(details.payload.details.followupArtifacts.some((artifact) => (
      artifact.kind === 'metadata-json' &&
      artifact.advanced === true &&
      artifact.absolutePath === path.join(runnerDir, 'codex.json')
    )))
    assert.ok(details.payload.details.followupArtifacts.some((artifact) => (
      artifact.kind === 'attempt-markdown' &&
      artifact.advanced === true &&
      artifact.absolutePath === path.join(runnerDir, 'codex.attempt-1.md')
    )))

    const graph = await requestJson(`${base}/api/runs/${runId}/graph`, { token: server.token })
    assert.equal(graph.statusCode, 200)
    assert.equal(graph.payload.run.runId, runId)
    assert.deepEqual(graph.payload.run.options.stepModels, { review: ['codex'] })
    assert.equal(graph.payload.run.options.target.branch, 'main')
    assert.equal(graph.payload.workflow.id, 'review')
    assert.equal(graph.payload.graph.metadata.hasRunState, true)
    assert.deepEqual(graph.payload.graph.nodes[0].data.agents, ['claude', 'gemini', 'codex'])
    assert.deepEqual(graph.payload.graph.nodes[0].data.selectedAgents, ['codex'])
  } finally {
    await server.close()
  }
})

test('dashboard follow-up endpoint validates auth, prompt, artifact IDs, and run ID', async () => {
  const projectRoot = tmpRoot()
  const { runId } = writeFollowupRunFixture(projectRoot)
  const server = await startDashboardServer({
    projectRoot,
    followupSubmitRun: async ({ run }) => ({ ...run, status: 'submitted', runnerId: run.existingRunnerId || 'runner-new', sessionId: 'session-new' }),
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const unauthorized = await postJson(`${base}/api/runs/${runId}/followups`, '', {
      prompt: 'Fix this.',
    })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(unauthorized.payload.error.code, 'unauthorized')

    const unknown = await postJson(`${base}/api/runs/missing-run/followups`, server.token, {
      prompt: 'Fix this.',
    })
    assert.equal(unknown.statusCode, 404)

    const emptyPrompt = await postJson(`${base}/api/runs/${runId}/followups`, server.token, {
      prompt: '   ',
    })
    assert.equal(emptyPrompt.statusCode, 400)
    assert.equal(emptyPrompt.payload.error.code, 'missing_prompt')

    const invalidArtifact = await postJson(`${base}/api/runs/${runId}/followups`, server.token, {
      prompt: 'Fix this.',
      artifacts: [{ id: 'missing-artifact', kind: 'step-summary' }],
    })
    assert.equal(invalidArtifact.statusCode, 400)
    assert.equal(invalidArtifact.payload.error.code, 'unknown_artifact')
  } finally {
    await server.close()
  }
})

test('dashboard follow-up endpoint submits matching runner and fresh additional models', async () => {
  const projectRoot = tmpRoot()
  const { runId } = writeFollowupRunFixture(projectRoot)
  const submissions = []
  const stopped = []
  const server = await startDashboardServer({
    projectRoot,
    siteName: 'netlify-agent-executor',
    followupSubmitRun: async ({ run }) => {
      submissions.push({ ...run })
      return {
        ...run,
        status: 'submitted',
        runnerId: run.existingRunnerId || `runner-${run.agent}`,
        sessionId: run.existingRunnerId ? `session-${run.agent}-followup` : `session-${run.agent}`,
      }
    },
    followupStopRun: async ({ runnerId }) => {
      stopped.push(runnerId)
      return { stopped: true, error: '', commandError: false }
    },
    followupSyncRunCommand: (_command, args) => {
      const data = JSON.parse(args[args.indexOf('--data') + 1] || '{}')
      const runnerId = data.agent_runner_id
      return {
        status: 0,
        stdout: JSON.stringify({
          sessions: [{
            id: runnerId === 'runner-gemini' ? 'session-gemini' : 'session-codex-followup',
            state: 'submitted',
            result: '',
          }],
        }),
        stderr: '',
      }
    },
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const response = await postJson(`${base}/api/runs/${runId}/followups`, server.token, {
      prompt: 'Verify the proposed fix and explain any risk.',
      mode: 'follow-up-thread',
      targetId: 'agent-result:review:runner-1:session-1:codex',
      models: ['codex', 'gemini'],
    })

    assert.equal(response.statusCode, 202, response.payload?.error?.message)
    assert.equal(response.payload.followup.status, 'submitted')
    assert.equal(response.payload.followup.sourceWorkflowRunId, runId)
    assert.equal(response.payload.followup.context.artifactCount, 1)
    assert.equal(response.payload.followup.context.delivery, 'inline')
    assert.deepEqual(response.payload.followup.plan.summary, [
      'Codex: follow-up session',
      'Gemini: fresh runner',
    ])
    assert.equal(response.payload.followup.submissions.length, 2)
    assert.equal(response.payload.followup.submissions[0].mode, 'continue-runner')
    assert.equal(response.payload.followup.submissions[0].runnerId, 'runner-1')
    assert.equal(response.payload.followup.submissions[0].sessionId, 'session-codex-followup')
    assert.match(response.payload.followup.submissions[0].links.agentRunUrl, /runner-1\?session=session-codex-followup/)
    assert.equal(response.payload.followup.submissions[1].mode, 'fresh-runner')
    assert.equal(response.payload.followup.submissions[1].runnerId, 'runner-gemini')
    assert.equal(response.payload.followup.sourceWorkflow.runId, runId)
    assert.equal(response.payload.followup.sourceWorkflow.status, 'submitted')
    assert.equal(response.payload.followup.persistedWorkflow.status, 'submitted')
    assert.equal(response.payload.followup.persistedWorkflow.flowTitle, 'Follow-up on Review (Gemini)')

    assert.equal(submissions.length, 2)
    assert.equal(submissions[0].existingRunnerId, 'runner-1')
    assert.equal(submissions[1].existingRunnerId, '')
    assert.match(submissions[0].promptText, /# Follow-up Instructions/)
    assert.match(submissions[0].promptText, /Verify the proposed fix/)
    assert.match(submissions[0].promptText, /# Prior Results Context/)

    const runs = await requestJson(`${base}/api/runs`, { token: server.token })
    assert.equal(runs.payload.durable.some((run) => run.flowTitle === 'Follow-up on Review (Gemini)'), true)
    const graph = await requestJson(`${base}/api/runs/${runId}/graph`, { token: server.token })
    const followupNode = graph.payload.graph.nodes.find((node) => node.id.startsWith('dashboard-followup-'))
    assert.ok(followupNode)
    assert.equal(followupNode.data.status, 'submitted')
    assert.deepEqual(followupNode.data.runs.map((run) => run.sessionId), ['session-codex-followup', 'session-gemini'])
    assert.ok(graph.payload.graph.edges.some((edge) => edge.source === 'review' && edge.target === followupNode.id))

    const cancel = await postJson(`${base}/api/runs/${runId}/followups/cancel`, server.token, {
      stepId: followupNode.id,
      agent: 'gemini',
      runnerId: 'runner-gemini',
      sessionId: 'session-gemini',
    })
    assert.equal(cancel.statusCode, 200, cancel.payload?.error?.message)
    assert.equal(cancel.payload.cancelled, true)
    assert.equal(cancel.payload.remoteStopped, true)
    assert.deepEqual(stopped, ['runner-gemini'])

    const cancelledGraph = await requestJson(`${base}/api/runs/${runId}/graph`, { token: server.token })
    const cancelledNode = cancelledGraph.payload.graph.nodes.find((node) => node.id === followupNode.id)
    assert.equal(cancelledNode.data.status, 'submitted')
    assert.deepEqual(cancelledNode.data.runs.map((run) => run.status), ['submitted', 'cancelled'])
  } finally {
    await server.close()
  }
})

test('dashboard run graph syncs completed remote follow-up sessions', async () => {
  const projectRoot = tmpRoot()
  const { runId, dir } = writeFollowupRunFixture(projectRoot)
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'))
  appendFollowupRunsToWorkflow({
    runState: state,
    now: new Date('2026-06-20T20:00:00.000Z'),
    target: { id: 'agent-result:review:codex', stepId: 'review', stepTitle: 'Review' },
    source: { id: 'followup-sync' },
    runs: [{
      agent: 'codex',
      status: 'submitted',
      runnerId: 'runner-1',
      sessionId: 'session-followup',
      links: { sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-followup' },
    }],
  })
  const server = await startDashboardServer({
    projectRoot,
    followupSyncRunCommand: (_command, args) => {
      const data = JSON.parse(args[args.indexOf('--data') + 1] || '{}')
      assert.equal(data.agent_runner_id, 'runner-1')
      return {
        status: 0,
        stdout: JSON.stringify({
          sessions: [{
            id: 'session-followup',
            state: 'completed',
            result: 'Remote follow-up result.',
            updated_at: '2026-06-20T20:05:00.000Z',
          }],
        }),
        stderr: '',
      }
    },
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const graph = await requestJson(`${base}/api/runs/${runId}/graph`, { token: server.token })
    assert.equal(graph.statusCode, 200, graph.payload?.error?.message)
    const followupNode = graph.payload.graph.nodes.find((node) => node.id.startsWith('dashboard-followup-sync'))
    assert.ok(followupNode)
    assert.equal(followupNode.data.status, 'completed')
    assert.equal(followupNode.data.runs[0].status, 'completed')
    assert.equal(followupNode.data.runs[0].resultText, 'Remote follow-up result.')
  } finally {
    await server.close()
  }
})

test('dashboard follow-up endpoint offloads oversized context using linked site state', async () => {
  const projectRoot = tmpRoot()
  fs.mkdirSync(path.join(projectRoot, '.netlify'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, '.netlify', 'state.json'), JSON.stringify({ siteId: 'linked-site-id' }))
  const { runId, dir } = writeFollowupRunFixture(projectRoot)
  fs.writeFileSync(path.join(dir, 'artifacts', 'summary.md'), `# Huge summary\n\n${'prior result detail '.repeat(5000)}\n`)
  const submissions = []
  const blobWrites = []
  const server = await startDashboardServer({
    projectRoot,
    siteName: 'netlify-agent-executor',
    env: {
      ...process.env,
      NETLIFY_SITE_ID: '',
      NAX_SAFE_PROMPT_BYTES: '1024',
    },
    followupSetBlob: async (input) => {
      blobWrites.push({ ...input })
      return { status: 'ok' }
    },
    followupSubmitRun: async ({ run }) => {
      submissions.push({ ...run })
      return {
        ...run,
        status: 'submitted',
        runnerId: run.existingRunnerId || `runner-${run.agent}`,
        sessionId: run.existingRunnerId ? `session-${run.agent}-followup` : `session-${run.agent}`,
      }
    },
  })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const response = await postJson(`${base}/api/runs/${runId}/followups`, server.token, {
      prompt: 'Fix the confirmed security issues.',
      mode: 'follow-up-thread',
      targetId: 'agent-result:review:runner-1:session-1:codex',
      models: ['codex'],
    })

    assert.equal(response.statusCode, 202, response.payload?.error?.message)
    assert.equal(response.payload.followup.context.delivery, 'blob')
    assert.equal(blobWrites.length, 1)
    assert.equal(blobWrites[0].siteId, 'linked-site-id')
    assert.match(blobWrites[0].value, /prior result detail/)
    assert.equal(submissions.length, 1)
    assert.match(submissions[0].promptText, /blobs:get/)
    assert.doesNotMatch(submissions[0].promptText, /prior result detail/)
  } finally {
    await server.close()
  }
})

test('dashboard events API replays durable event log with since filter', async () => {
  const projectRoot = tmpRoot()
  const runId = 'fixture-events-run'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    transport: 'netlify-api',
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:01:00.000Z',
    dir,
    flow: { id: 'review', title: 'Review', steps: [] },
    steps: [],
  }, null, 2))
  const logPath = path.join(dir, 'events.jsonl')
  appendEventLog(logPath, { schemaVersion: 1, seq: 1, type: 'workflow_started', runId, flowId: 'review' })
  fs.appendFileSync(logPath, 'not-json\n')
  appendEventLog(logPath, { schemaVersion: 1, seq: 2, type: 'step_started', runId, flowId: 'review', stepId: 'review' })
  appendEventLog(logPath, { schemaVersion: 1, seq: 3, type: 'workflow_completed', runId, flowId: 'review' })

  const server = await startDashboardServer({ projectRoot })
  try {
    const events = await requestText(`http://127.0.0.1:${server.port}/api/runs/${runId}/events?since=1`, { token: server.token })
    assert.equal(events.statusCode, 200)
    assert.doesNotMatch(events.body, /workflow_started/)
    assert.match(events.body, /event: step_started/)
    assert.match(events.body, /event: workflow_completed/)
    assert.match(events.body, /event: runner_event_error/)

    const json = await requestJson(`http://127.0.0.1:${server.port}/api/runs/${runId}/events.json?since=1`, { token: server.token })
    assert.equal(json.statusCode, 200)
    assert.deepEqual(json.payload.events.map((event) => event.seq), [2, 3])
    assert.equal(json.payload.errors.length, 1)
    assert.equal(json.payload.errors[0].code, 'parse_error')
  } finally {
    await server.close()
  }
})

function fakeReq() {
  return Object.assign(new EventEmitter(), { setEncoding() {}, pause() {} })
}

/** @param {unknown} err @returns {{ statusCode?: number, code?: string }} */
function asRequestError(err) {
  return /** @type {{ statusCode?: number, code?: string }} */ (err)
}

test('htmlEscape escapes html metacharacters', () => {
  assert.equal(_private.htmlEscape(`<a>&"'`), '&lt;a&gt;&amp;&quot;&#39;')
})

test('defaultIndexHtml escapes the initial workflow and does not embed the token', () => {
  const html = _private.defaultIndexHtml({ token: 'a&b<c', initialWorkflow: '<script>x</script>' })
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>x<\/script>/)
  assert.doesNotMatch(html, /a&b<c/)
  assert.doesNotMatch(html, /token=/)
})

test('timingSafeTokenEqual accepts only matching tokens', () => {
  assert.equal(_private.timingSafeTokenEqual('abc', 'abc'), true)
  assert.equal(_private.timingSafeTokenEqual('abc', 'abd'), false)
  assert.equal(_private.timingSafeTokenEqual('', 'abc'), false)
})

test('readJsonBody rejects oversized bodies with a 413 instead of resetting the socket', async () => {
  const req = fakeReq()
  const promise = _private.readJsonBody(req, { maxBytes: 10 })
  req.emit('data', 'x'.repeat(20))
  await assert.rejects(promise, (err) => asRequestError(err).statusCode === 413 && asRequestError(err).code === 'payload_too_large')
})

test('readJsonBody returns a 400 for invalid JSON', async () => {
  const req = fakeReq()
  const promise = _private.readJsonBody(req)
  req.emit('data', 'not json')
  req.emit('end')
  await assert.rejects(promise, (err) => asRequestError(err).statusCode === 400 && asRequestError(err).code === 'invalid_json')
})

test('readJsonBody parses valid JSON and treats an empty body as {}', async () => {
  const reqA = fakeReq()
  const parsed = _private.readJsonBody(reqA)
  reqA.emit('data', '{"a":1}')
  reqA.emit('end')
  assert.deepEqual(await parsed, { a: 1 })

  const reqB = fakeReq()
  const empty = _private.readJsonBody(reqB)
  reqB.emit('end')
  assert.deepEqual(await empty, {})
})

test('appendBounded keeps only the most recent characters and reports dropped count', () => {
  assert.deepEqual(_private.appendBounded('abc', 'de', 10), { text: 'abcde', dropped: 0 })
  assert.deepEqual(_private.appendBounded('abcd', 'efgh', 6), { text: 'cdefgh', dropped: 2 })
})

test('evictFinishedRuns drops the oldest finished runs but keeps running ones', () => {
  const runs = new Map()
  runs.set('r1', { id: 'r1', status: 'completed', exitedAt: '2026-01-01T00:00:01.000Z' })
  runs.set('r2', { id: 'r2', status: 'completed', exitedAt: '2026-01-01T00:00:02.000Z' })
  runs.set('r3', { id: 'r3', status: 'running', exitedAt: '' })
  _private.evictFinishedRuns(runs, 1)
  assert.equal(runs.has('r1'), false)
  assert.equal(runs.has('r2'), true)
  assert.equal(runs.has('r3'), true)
})

test('broadcastEvent drops a client whose write throws and keeps the rest', () => {
  const written = []
  const bad = { write() { throw new Error('EPIPE') }, end() {} }
  const good = { write(text) { written.push(text) }, end() {} }
  const clients = new Set([bad, good])
  _private.broadcastEvent(clients, 'hello')
  assert.equal(clients.has(bad), false)
  assert.equal(clients.has(good), true)
  assert.deepEqual(written, ['hello'])
})

test('registerSseClient de-registers the client on error and on close', () => {
  const run = { clients: new Set() }

  const resError = new EventEmitter()
  _private.registerSseClient(run, new EventEmitter(), resError)
  assert.equal(run.clients.has(resError), true)
  resError.emit('error', new Error('socket'))
  assert.equal(run.clients.has(resError), false)

  const reqClose = new EventEmitter()
  const resClose = new EventEmitter()
  _private.registerSseClient(run, reqClose, resClose)
  assert.equal(run.clients.has(resClose), true)
  reqClose.emit('close')
  assert.equal(run.clients.has(resClose), false)
})

test('shutdownRuns cancels children, clears timers, and ends clients', () => {
  const cancelled = []
  const ended = []
  const timer = setInterval(() => {}, 1000)
  const client = { end() { ended.push(true) } }
  const runs = new Map()
  runs.set('r1', {
    id: 'r1',
    status: 'running',
    stepStatusTimer: timer,
    cancel: () => cancelled.push('r1'),
    clients: new Set([client]),
  })

  _private.shutdownRuns(runs)

  const run = runs.get('r1')
  assert.deepEqual(cancelled, ['r1'])
  assert.equal(run.stepStatusTimer, null)
  assert.deepEqual(ended, [true])
  assert.equal(run.clients.size, 0)
})

test('cancellableWorkflowRunnerIds selects submitted fresh runners only', () => {
  assert.deepEqual(_private.cancellableWorkflowRunnerIds({
    steps: [{
      runs: [
        { runnerId: 'runner-1', status: 'submitted' },
        { runnerId: 'runner-1', status: 'running' },
        { runnerId: 'runner-2', status: 'completed' },
        { runnerId: 'runner-3', status: 'submitted', existingRunnerId: 'source-runner' },
        { runnerId: '', status: 'submitted' },
      ],
    }],
  }), ['runner-1'])
})

test('stopWorkflowRunners stops cancellable workflow runners and reports warnings', async () => {
  const calls = []
  const result = await _private.stopWorkflowRunners({
    projectRoot: '/tmp/project',
    env: { NETLIFY_AUTH_TOKEN: 'token' },
    runState: {
      steps: [{
        runs: [
          { runnerId: 'runner-ok', status: 'submitted' },
          { runnerId: 'runner-fail', status: 'running' },
        ],
      }],
    },
    stopRun: async ({ runnerId }) => {
      calls.push(runnerId)
      return runnerId === 'runner-ok'
        ? { stopped: true, accepted: true, error: '', commandError: false }
        : { stopped: false, accepted: false, error: 'nope', commandError: false }
    },
  })

  assert.deepEqual(calls, ['runner-ok', 'runner-fail'])
  assert.deepEqual(result.stopped, ['runner-ok'])
  assert.deepEqual(result.runnerIds, ['runner-ok', 'runner-fail'])
  assert.deepEqual(result.warnings, ['runner-fail: nope'])
})
