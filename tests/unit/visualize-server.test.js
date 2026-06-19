const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const { _private, startVisualizeServer } = require('../../src/visualize-server')
const { appendEventLog } = require('../../src/runner-event-log')

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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

function requestText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-visualize-server-'))
}

function writeProjectFlow(projectRoot, id, { title = id } = {}) {
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    `title: ${title}`,
    'description: Project-local visualize flow',
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

test('visualize extracts durable workflow run id from runner output', () => {
  const output = [
    'Run 2026-06-19T04-40-05-602Z-do-next',
    'Flow: Do Next',
    'State: /repo/.nax/workflows/2026-06-19T04-40-05-602Z-do-next/workflow.json',
  ].join('\n')

  assert.equal(_private.extractDurableRunId(output), '2026-06-19T04-40-05-602Z-do-next')
})

test('visualize builds compact step status snapshots from workflow state', () => {
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

test('visualize parses runner event JSONL across chunks and reports malformed lines', () => {
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

test('visualize server exposes health, workflow list, and graph routes', async () => {
  const server = await startVisualizeServer({ projectRoot: process.cwd(), initialWorkflow: 'review' })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const health = await requestJson(`${base}/api/health`)
    assert.equal(health.statusCode, 200)
    assert.equal(health.payload.ok, true)
    assert.equal(health.payload.projectRoot, process.cwd())

    const workflows = await requestJson(`${base}/api/workflows`)
    assert.equal(workflows.statusCode, 200)
    assert.ok(workflows.payload.count >= 14)
    assert.ok(workflows.payload.items.some((workflow) => workflow.id === 'review'))

    const graph = await requestJson(`${base}/api/workflows/review/graph`)
    assert.equal(graph.statusCode, 200)
    assert.equal(graph.payload.workflow.id, 'review')
    assert.equal(graph.payload.graph.nodes.length, 3)
    assert.equal(graph.payload.graph.edges.length, 2)
  } finally {
    await server.close()
  }
})

test('visualize server discovers project workflows before bundled workflows', async () => {
  const projectRoot = tmpRoot()
  writeProjectFlow(projectRoot, 'conversion-audit', { title: 'Conversion Audit' })
  const server = await startVisualizeServer({ projectRoot })
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

test('visualize server returns structured 404 for unknown workflows', async () => {
  const server = await startVisualizeServer({ projectRoot: process.cwd() })
  try {
    const response = await requestJson(`http://127.0.0.1:${server.port}/api/workflows/nope/graph`)
    assert.equal(response.statusCode, 404)
    assert.equal(response.payload.error.code, 'not_found')
    assert.match(response.payload.error.message, /Unknown flow "nope"/)
  } finally {
    await server.close()
  }
})

test('visualize server serves built static assets when dist exists', async () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-visualize-dist-'))
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(distDir, 'index.html'), '<script type="module" src="/assets/app.js"></script>')
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("ok")\n')

  const server = await startVisualizeServer({ projectRoot: process.cwd(), distDir })
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

test('visualize dry-run requires token and validates options', async () => {
  const server = await startVisualizeServer({ projectRoot: process.cwd() })
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

test('visualize dry-run returns preview output without writing artifacts', async () => {
  const projectRoot = tmpRoot()
  const server = await startVisualizeServer({ projectRoot })
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

test('visualize real-run endpoint starts a tracked process and replays events', async () => {
  const projectRoot = tmpRoot()
  const server = await startVisualizeServer({ projectRoot })
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
    const detail = await requestJson(`${base}/api/runs/${encodeURIComponent(started.payload.run.id)}`)
    assert.equal(detail.statusCode, 200)
    assert.ok(['running', 'failed', 'completed', 'cancelled'].includes(detail.payload.run.status))

    const events = await requestText(`${base}/api/runs/${encodeURIComponent(started.payload.run.id)}/events`)
    assert.equal(events.statusCode, 200)
    assert.match(events.body, /event: started/)

    const cancel = await postJson(`${base}/api/runs/${encodeURIComponent(started.payload.run.id)}/cancel`, server.token, {})
    assert.equal(cancel.statusCode, 200)
    assert.equal(typeof cancel.payload.cancelled, 'boolean')
  } finally {
    await server.close()
  }
})

test('visualize runs API reads durable workflow state from .nax', async () => {
  const projectRoot = tmpRoot()
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
    agent: 'codex',
    status: 'completed',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    links: {
      sessionUrl: 'https://example.test/session-1',
    },
  }, null, 2))
  fs.writeFileSync(path.join(runnerDir, 'codex.md'), '# Codex result\n\nFinal result text.\n')

  const server = await startVisualizeServer({ projectRoot })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const runs = await requestJson(`${base}/api/runs`)
    assert.equal(runs.statusCode, 200)
    assert.equal(runs.payload.durable.some((run) => run.runId === runId), true)

    const detail = await requestJson(`${base}/api/runs/${runId}`)
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.payload.run.runId, runId)
    assert.equal(detail.payload.run.status, 'completed')

    const details = await requestJson(`${base}/api/runs/${runId}/details`)
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

    const graph = await requestJson(`${base}/api/runs/${runId}/graph`)
    assert.equal(graph.statusCode, 200)
    assert.equal(graph.payload.run.runId, runId)
    assert.deepEqual(graph.payload.run.options.stepModels, { review: ['codex'] })
    assert.equal(graph.payload.workflow.id, 'review')
    assert.equal(graph.payload.graph.metadata.hasRunState, true)
    assert.deepEqual(graph.payload.graph.nodes[0].data.agents, ['claude', 'gemini', 'codex'])
    assert.deepEqual(graph.payload.graph.nodes[0].data.selectedAgents, ['codex'])
  } finally {
    await server.close()
  }
})

test('visualize events API replays durable event log with since filter', async () => {
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

  const server = await startVisualizeServer({ projectRoot })
  try {
    const events = await requestText(`http://127.0.0.1:${server.port}/api/runs/${runId}/events?since=1`)
    assert.equal(events.statusCode, 200)
    assert.doesNotMatch(events.body, /workflow_started/)
    assert.match(events.body, /event: step_started/)
    assert.match(events.body, /event: workflow_completed/)
    assert.match(events.body, /event: runner_event_error/)

    const json = await requestJson(`http://127.0.0.1:${server.port}/api/runs/${runId}/events.json?since=1`)
    assert.equal(json.statusCode, 200)
    assert.deepEqual(json.payload.events.map((event) => event.seq), [2, 3])
    assert.equal(json.payload.errors.length, 1)
    assert.equal(json.payload.errors[0].code, 'parse_error')
  } finally {
    await server.close()
  }
})
