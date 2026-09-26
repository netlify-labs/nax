// Verifies resume reconciles submissions whose response was lost: a runner created by a saved
// submit checkpoint is adopted and polled instead of duplicated. Only globalThis.fetch is faked;
// nax, the SDK submit path and SDK reconciliation run unmodified.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { resumeLocalFlow } = require('../../src/workflows/engine/local-executor')
const { submitLocalAgentRun } = require('../../src/integrations/netlify/local-runner')

const RUN_SHA = 'a'.repeat(40)

/**
 * A minimal Agent Runner API. `createStatus` is the POST response status (the runner is created
 * server-side either way); `getRunnerStatus` fails the follow-up read; `listVisible` controls
 * whether listing shows created runners (reconciliation reads the list).
 */
function fakeApi() {
  /** @type {Array<{ runner: Record<string, unknown>, session: Record<string, unknown> }>} */
  const created = []
  const state = { posts: 0, createStatus: 201, getRunnerStatus: 200, listVisible: true, duplicateList: false }
  /** @param {string | URL | Request} input @param {RequestInit} [init] */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = String(init.method || 'GET').toUpperCase()
    const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status })
    if (method === 'POST' && url.pathname.endsWith('/agent_runners')) {
      state.posts += 1
      const body = JSON.parse(String(init.body || '{}'))
      const id = `runner-${state.posts}`
      const createdAt = new Date().toISOString()
      const runner = { id, state: 'running', site_id: 'site_test', branch: body.branch, created_at: createdAt }
      const session = { id: `session-${state.posts}`, agent_runner_id: id, state: 'running', prompt: body.prompt, agent_config: { agent: body.agent }, created_at: createdAt }
      created.push({ runner, session })
      if (state.createStatus !== 201) return json({ error: 'upstream failed' }, state.createStatus)
      return json(runner, 201)
    }
    if (method === 'GET' && url.pathname.endsWith('/agent_runners')) {
      if (!state.listVisible) return json([])
      const runners = created.map((entry) => entry.runner)
      return json(state.duplicateList ? [...runners, { ...runners[0], id: 'runner-copy' }] : runners)
    }
    const sessionsMatch = url.pathname.match(/\/agent_runners\/([^/]+)\/sessions$/)
    if (sessionsMatch) {
      const entry = created.find((item) => item.runner.id === sessionsMatch[1]) || created[0]
      return json([{ ...entry.session, agent_runner_id: sessionsMatch[1] }])
    }
    const sessionMatch = url.pathname.match(/\/agent_runners\/([^/]+)\/sessions\/([^/]+)$/)
    if (sessionMatch) {
      const entry = created.find((item) => item.runner.id === sessionMatch[1])
      return json(entry ? entry.session : {}, entry ? 200 : 404)
    }
    const runnerMatch = url.pathname.match(/\/agent_runners\/([^/]+)$/)
    if (runnerMatch) {
      if (state.getRunnerStatus !== 200) return json({ error: 'not found' }, state.getRunnerStatus)
      const entry = created.find((item) => item.runner.id === runnerMatch[1])
      return json(entry ? entry.runner : {}, entry ? 200 : 404)
    }
    return json({ error: `unexpected ${method} ${url.pathname}` }, 404)
  }
  return { fetch, state }
}

function fixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-resume-recovery-'))
  fs.writeFileSync(path.join(projectRoot, 'review.md'), '---\ntitle: Review\n---\n\nReview it.\n')
  const flow = { id: 'recovery-flow', title: 'Recovery flow', dir: projectRoot, defaults: {}, steps: [{ id: 'review', title: 'Review', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'review.md', agents: ['claude', 'codex'], lineup: ['claude', 'codex'] }] }
  const runState = {
    schemaVersion: 1,
    runId: 'run-recovery',
    flowId: flow.id,
    flow,
    transport: 'netlify-api',
    projectRoot,
    status: 'interrupted',
    dir: path.join(projectRoot, '.nax', 'workflows', 'run-recovery'),
    target: { branch: 'main', ref: 'origin/main', sha: RUN_SHA, sourceType: 'explicit-branch', verified: true, caveats: [] },
    branch: 'main',
    options: { branch: 'main', netlifySiteId: 'site_test', autoContext: false, timeoutMinutes: 1 },
    steps: [{ id: 'review', title: 'Review', status: 'running', runs: [
      { transport: 'netlify-api', agent: 'claude', instanceId: 'claude:auto:auto', attemptId: 'c1', status: 'completed', runnerId: 'r-claude', resultText: 'claude done', promptText: 'Claude prompt' },
      { transport: 'netlify-api', agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'x1', status: 'failed', runnerId: 'r-codex', promptText: 'Codex prompt', raw: { stepId: 'review', workflowRunId: 'run-recovery' } },
    ] }],
  }
  return { projectRoot, flow, runState }
}

/** @type {typeof import('../../src/integrations/netlify/local-runner').waitForLocalAgentRuns} */
const waitCompleted = async ({ runs = [], onTerminalRun = () => {} } = {}) => {
  const completed = { ...runs[0], status: 'completed', resultText: `result from ${runs[0].runnerId}` }
  onTerminalRun(completed)
  return [completed]
}

/** @type {typeof import('../../src/integrations/netlify/local-runner').submitLocalAgentRun} */
const submitOnce = (options) => submitLocalAgentRun({ ...options, retryAttempts: 1, sleepFn: async () => {} })

/**
 * @param {ReturnType<typeof fakeApi>} api
 * @param {() => Promise<void>} body
 */
async function withApi(api, body) {
  const saved = { fetch: globalThis.fetch, token: process.env.NETLIFY_AUTH_TOKEN, blob: process.env.NAX_PROMPT_BLOB_DISABLE }
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (api.fetch)
  process.env.NETLIFY_AUTH_TOKEN = 'test-token'
  process.env.NAX_PROMPT_BLOB_DISABLE = '1'
  try {
    await body()
  } finally {
    globalThis.fetch = saved.fetch
    if (saved.token === undefined) delete process.env.NETLIFY_AUTH_TOKEN
    else process.env.NETLIFY_AUTH_TOKEN = saved.token
    if (saved.blob === undefined) delete process.env.NAX_PROMPT_BLOB_DISABLE
    else process.env.NAX_PROMPT_BLOB_DISABLE = saved.blob
  }
}

/** @param {ReturnType<typeof fixture>['runState']} runState */
function codexRun(runState) {
  return /** @type {import('../../src/types').AgentRun & { raw: Record<string, unknown> }} */ (runState.steps[0].runs[1])
}

test('a runner created before the response was lost is adopted on the next resume, not duplicated', async () => {
  const api = fakeApi()
  const { projectRoot, flow, runState } = fixture()
  await withApi(api, async () => {
    api.state.getRunnerStatus = 500
    await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA }))
    assert.equal(api.state.posts, 1)
    assert.equal(codexRun(runState).runnerId, '')
    assert.ok(codexRun(runState).raw.submitCheckpoint, 'checkpoint saved before the send')

    api.state.getRunnerStatus = 200
    await resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA })
    assert.equal(api.state.posts, 1, 'no second create')
    assert.equal(codexRun(runState).runnerId, 'runner-1')
    assert.equal(codexRun(runState).status, 'completed')
    assert.equal(runState.status, 'completed')
  })
})

test('an ambiguous create whose runner appears later is adopted using the SDK request window', async () => {
  const api = fakeApi()
  const { projectRoot, flow, runState } = fixture()
  await withApi(api, async () => {
    api.state.createStatus = 503
    api.state.listVisible = false
    await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA }))
    assert.equal(codexRun(runState).raw.submissionErrorCode, 'create-ambiguous')
    assert.ok(codexRun(runState).raw.submitWindow, 'SDK request window saved')

    api.state.listVisible = true
    await resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA })
    assert.equal(api.state.posts, 1)
    assert.equal(codexRun(runState).runnerId, 'runner-1')
    assert.equal(runState.status, 'completed')
  })
})

test('an ambiguous create with no runner found still stops resume', async () => {
  const api = fakeApi()
  const { projectRoot, flow, runState } = fixture()
  await withApi(api, async () => {
    api.state.createStatus = 503
    api.state.listVisible = false
    await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA }))
    await assert.rejects(
      resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA }),
      (error) => /** @type {{ code?: string }} */ (error).code === 'resume_ambiguous_submission',
    )
    assert.equal(api.state.posts, 1)
  })
})

test('a submit failure with no runner found resubmits as before', async () => {
  const api = fakeApi()
  const { projectRoot, flow, runState } = fixture()
  await withApi(api, async () => {
    api.state.getRunnerStatus = 500
    await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA }))
    api.state.getRunnerStatus = 200
    api.state.listVisible = false
    await resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA })
    assert.equal(api.state.posts, 2)
    assert.equal(codexRun(runState).runnerId, 'runner-2')
  })
})

test('several candidate runners stop resume and name them', async () => {
  const api = fakeApi()
  const { projectRoot, flow, runState } = fixture()
  await withApi(api, async () => {
    api.state.getRunnerStatus = 500
    await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA }))
    api.state.getRunnerStatus = 200
    api.state.duplicateList = true
    await assert.rejects(
      resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun: submitOnce, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA }),
      (error) => /** @type {{ code?: string, message?: string }} */ (error).code === 'resume_ambiguous_submission' && /runner-1.*runner-copy/.test(String(/** @type {Error} */ (error).message)),
    )
    assert.equal(api.state.posts, 1)
  })
})

test('a follow-up submission is reconciled against the source runner handle, and previews show the adoption', async () => {
  const { prepareResume } = require('../../src/workflows/engine/resume-preparation')
  const { projectRoot, flow, runState } = fixture()
  const sourceHandle = { v: 1, kind: 'run', runnerId: 'r-codex-source' }
  flow.steps = [
    flow.steps[0],
    { id: 'cross', title: 'Cross', action: 'issue', submit: 'follow-up', waitFor: 'agent-results', prompt: 'review.md', agents: ['codex'], lineup: ['codex'], input: [{ step: 'review', results: 'all' }] },
  ]
  /** @type {Array<Record<string, unknown>>} */
  const steps = [
    { id: 'review', title: 'Review', status: 'completed', runs: [{ transport: 'netlify-api', agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', runnerId: 'r-codex-source', sdkHandle: sourceHandle, resultText: 'done', promptText: 'p' }] },
    { id: 'cross', title: 'Cross', status: 'running', runs: [{
      transport: 'netlify-api', agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'f1', status: 'pending', runnerId: '', sentAt: '2026-09-25T12:00:00.000Z', existingRunnerId: 'r-codex-source', promptText: 'p',
      raw: { submitCheckpoint: { v: 1, kind: 'session', runnerId: 'r-codex-source', effectiveInput: { requestId: 'req-1', prompt: 'p' }, sentAt: 1_000 } },
    }] },
  ]
  Object.assign(runState, { steps })
  /** @type {unknown[]} */
  const calls = []
  /** @type {import('../../src/workflows/engine/submission-recovery').ReconcileSubmission} */
  const reconcileSubmission = async (input) => {
    calls.push(input.sourceHandle)
    return { kind: 'matched', handle: /** @type {import('nax-agent-runner-sdk').Handle} */ (/** @type {unknown} */ ({ ...sourceHandle, kind: 'session', currentSessionId: 'session-found', sessionId: 'session-found' })) }
  }
  const prepared = await prepareResume({ runState: /** @type {import('../../src/types').WorkflowRunState} */ (runState), projectRoot, reconcileSubmission, resolveRemoteSha: () => RUN_SHA })
  assert.deepEqual(calls, [sourceHandle])
  assert.equal(prepared.blocked, null)
  assert.deepEqual(prepared.preview.actions.map((action) => action.action), ['poll'])
  assert.match(prepared.preview.notes.join('\n'), /found runner r-codex-source/)
  assert.equal(/** @type {{ runs: Array<{ status: string }> }} */ (steps[1]).runs[0].status, 'pending', 'preview does not change the saved run')
})

/** @param {Record<string, unknown>} codex */
function checkpointedFixture(codex) {
  const { projectRoot, flow, runState } = fixture()
  Object.assign(runState.steps[0].runs[1], codex)
  return { projectRoot, flow, runState }
}

const SAVED_CHECKPOINT = { v: 1, kind: 'create', effectiveInput: { siteId: 'site_test', requestId: 'req-1', prompt: 'Codex prompt' }, sentAt: 1_000 }

test('a reconcile error on a checkpointed submit failure stops resume with zero creates', async () => {
  const { projectRoot, flow, runState } = checkpointedFixture({
    runnerId: '', sentAt: '2026-09-25T12:00:00.000Z',
    raw: { stepId: 'review', failurePhase: 'submit', submissionError: 'socket hang up', submitCheckpoint: SAVED_CHECKPOINT },
  })
  let submits = 0
  /** @type {typeof submitLocalAgentRun} */
  const submitAgentRun = async ({ run }) => { submits += 1; return { ...run, status: 'submitted', runnerId: 'dup' } }
  await assert.rejects(
    resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA, reconcileSubmission: async () => { throw new Error('Agent Runner API request failed with status 503') } }),
    (error) => /** @type {{ code?: string }} */ (error).code === 'resume_ambiguous_submission',
  )
  await assert.rejects(
    resumeLocalFlow({ flow, runState, projectRoot, submitAgentRun, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA, reconcileSubmission: async () => { throw new Error('Agent Runner API request failed with status 401: token expired') } }),
    (error) => /** @type {{ code?: string }} */ (error).code === 'resume_auth_failure',
  )
  assert.equal(submits, 0)
})

test('an automatic retry that created a runner before the crash is adopted; an unresolved one stops', async () => {
  const retryCheckpoint = { v: 1, kind: 'create', effectiveInput: { siteId: 'site_test', requestId: 'req-retry', prompt: 'Codex prompt' }, sentAt: 2_000 }
  const saved = { status: 'running', runnerId: 'r-codex', raw: { stepId: 'review', retrySubmitCheckpoint: retryCheckpoint } }
  let submits = 0
  /** @type {typeof submitLocalAgentRun} */
  const submitAgentRun = async ({ run }) => { submits += 1; return { ...run, status: 'submitted', runnerId: 'dup' } }

  const unresolved = checkpointedFixture(structuredClone(saved))
  await assert.rejects(
    resumeLocalFlow({ ...unresolved, submitAgentRun, waitForAgentRuns: waitCompleted, resolveRemoteSha: () => RUN_SHA, reconcileSubmission: async () => ({ kind: 'none' }) }),
    (error) => /** @type {{ code?: string }} */ (error).code === 'resume_ambiguous_submission'
      && /automatic retry of runner r-codex sent 1970-01-01T00:00:02\.000Z/.test(String(/** @type {Error} */ (error).message))
      && !/undefined/.test(String(/** @type {Error} */ (error).message)),
  )

  const found = checkpointedFixture(structuredClone(saved))
  /** @type {string[]} */
  const polled = []
  /** @type {typeof waitCompleted} */
  const waitForAgentRuns = async (options = {}) => { polled.push(String(options.runs?.[0]?.runnerId)); return waitCompleted(options) }
  await resumeLocalFlow({
    ...found,
    submitAgentRun,
    waitForAgentRuns,
    resolveRemoteSha: () => RUN_SHA,
    reconcileSubmission: async ({ checkpoint }) => {
      assert.equal(checkpoint.effectiveInput.requestId, 'req-retry')
      return { kind: 'matched', handle: /** @type {import('nax-agent-runner-sdk').Handle} */ (/** @type {unknown} */ ({ v: 1, kind: 'run', runnerId: 'r-codex-retry', currentSessionId: 's-retry' })) }
    },
  })
  assert.deepEqual(polled, ['r-codex-retry'])
  assert.equal(codexRun(found.runState).runnerId, 'r-codex-retry')
  assert.equal(codexRun(found.runState).raw.retrySubmitCheckpoint, undefined)
  assert.equal(submits, 0)
})

test('an automatic capacity retry hands over its request before creating the replacement runner', async () => {
  const { waitForLocalAgentRuns } = require('../../src/integrations/netlify/local-runner')
  const api = fakeApi()
  /** @type {string[]} */
  const events = []
  const originalFetch = api.fetch
  /** @type {typeof api.fetch} */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (String(init.method || 'GET').toUpperCase() === 'POST') events.push(`create:${api.state.posts + 1}`)
    // The first runner fails with a capacity error; the replacement completes.
    if (/\/agent_runners\/runner-1$/.test(url.pathname)) return new Response(JSON.stringify({ id: 'runner-1', state: 'failed', site_id: 'site_test', branch: 'main' }))
    if (/\/agent_runners\/runner-1\/sessions\/session-1$/.test(url.pathname)) {
      return new Response(JSON.stringify({ id: 'session-1', agent_runner_id: 'runner-1', state: 'failed', result: 'The Codex model is currently at capacity. Retrying automatically...' }))
    }
    if (/\/agent_runners\/runner-2$/.test(url.pathname)) return new Response(JSON.stringify({ id: 'runner-2', state: 'completed', site_id: 'site_test', branch: 'main' }))
    if (/\/agent_runners\/runner-2\/sessions\/session-2$/.test(url.pathname)) {
      return new Response(JSON.stringify({ id: 'session-2', agent_runner_id: 'runner-2', state: 'completed', result: 'Done after retry' }))
    }
    return originalFetch(input, init)
  }
  await withApi({ ...api, fetch }, async () => {
    const env = { NETLIFY_AUTH_TOKEN: 'test-token', NAX_PROMPT_BLOB_DISABLE: '1' }
    const submitted = await submitLocalAgentRun({
      run: /** @type {import('../../src/types').AgentRun} */ ({ agent: 'codex', instanceId: 'codex:auto:auto', promptText: 'Codex prompt', raw: { stepId: 'review' } }),
      branch: 'main', siteId: 'site_test', env, retryAttempts: 1, sleepFn: async () => {},
    })
    events.length = 0
    /** @type {Array<{ runnerId: string, requestId: string }>} */
    const checkpoints = []
    /** @type {import('../../src/types').AgentRun[]} */
    const terminal = []
    await waitForLocalAgentRuns({
      runs: [submitted],
      siteId: 'site_test',
      env,
      initialDelayMs: 0,
      pollIntervalMs: 5,
      timeoutMinutes: 1,
      onTerminalRun: (run) => { terminal.push(run) },
      onSubmitCheckpoint: (run, checkpoint) => {
        events.push('checkpoint')
        checkpoints.push({ runnerId: String(run.runnerId), requestId: String(checkpoint.effectiveInput.requestId) })
      },
    })
    assert.deepEqual(events, ['checkpoint', 'create:2'])
    assert.equal(checkpoints[0]?.runnerId, 'runner-1')
    const last = terminal[terminal.length - 1]
    assert.deepEqual([last?.runnerId, last?.status], ['runner-2', 'completed'])
    assert.equal(/** @type {Record<string, unknown>} */ (last?.raw || {}).retrySubmitCheckpoint, undefined)
  })
})
