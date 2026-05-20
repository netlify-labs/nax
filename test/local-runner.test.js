const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createAgentRun,
  createAgentRunAsync,
  createAgentSession,
  createAgentSessionAsync,
  formatCommandForError,
  latestSessionFromList,
  listAgentSessions,
  normalizeCompletedRun,
  waitForLocalAgentRuns,
  showAgentRun,
  submitLocalAgentRun,
} = require('../lib/local-runner')

test('latestSessionFromList accepts array and sessions wrapper responses', () => {
  assert.deepEqual(latestSessionFromList([{ id: 's1' }, { id: 's2' }]), { id: 's2' })
  assert.deepEqual(latestSessionFromList({ sessions: [{ id: 's3' }] }), { id: 's3' })
  assert.deepEqual(latestSessionFromList({}), {})
})

test('formatCommandForError redacts prompt and API payload values', () => {
  assert.equal(
    formatCommandForError('netlify', ['agents:create', '--prompt', 'secret prompt', '--agent', 'codex']),
    'netlify agents:create --prompt <redacted> --agent codex',
  )
  assert.equal(
    formatCommandForError('netlify', ['api', 'createAgentRunnerSession', '--data', '{"prompt":"secret"}']),
    'netlify api createAgentRunnerSession --data <redacted>',
  )
})

test('createAgentRun invokes netlify agents:create with prompt, agent, project, and branch', () => {
  const calls = []
  const created = createAgentRun({
    projectRoot: '/tmp/project',
    promptText: 'Review this repo',
    agent: 'codex',
    branch: 'master',
    siteId: 'site-123',
    env: { NETLIFY_SITE_ID: 'site-123' },
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ id: 'runner-1', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(created.runnerId, 'runner-1')
  assert.equal(calls[0].command, 'netlify')
  assert.deepEqual(calls[0].args, [
    'agents:create',
    '--json',
    '--agent',
    'codex',
    '--project',
    'site-123',
    '--branch',
    'master',
    '--prompt',
    'Review this repo',
  ])
  assert.equal(calls[0].options.timeout, 120000)
})

test('createAgentRunAsync invokes netlify agents:create with async runner', async () => {
  const calls = []
  const created = await createAgentRunAsync({
    projectRoot: '/tmp/project',
    promptText: 'Review async',
    agent: 'gemini',
    branch: 'master',
    siteId: 'site-123',
    env: {},
    async runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ id: 'runner-async', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(created.runnerId, 'runner-async')
  assert.equal(calls[0].command, 'netlify')
  assert.equal(calls[0].options.timeout, 120000)
})

test('createAgentSession invokes Netlify follow-up session API', () => {
  const calls = []
  const created = createAgentSession({
    projectRoot: '/tmp/project',
    runnerId: 'runner-1',
    promptText: 'Cross review these findings',
    agent: 'claude',
    env: {},
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ id: 'session-1', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(created.runnerId, 'runner-1')
  assert.equal(created.state, 'running')
  assert.equal(calls[0].command, 'netlify')
  assert.deepEqual(calls[0].args.slice(0, 3), ['api', 'createAgentRunnerSession', '--data'])
  assert.equal(calls[0].options.timeout, 120000)
  assert.deepEqual(JSON.parse(calls[0].args[3]), {
    agent_runner_id: 'runner-1',
    body: {
      prompt: 'Cross review these findings',
      agent: 'claude',
    },
  })
})

test('createAgentSessionAsync invokes Netlify follow-up session API with async runner', async () => {
  const calls = []
  const created = await createAgentSessionAsync({
    projectRoot: '/tmp/project',
    runnerId: 'runner-1',
    promptText: 'Cross review async',
    agent: 'claude',
    env: {},
    async runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ id: 'session-async', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(created.runnerId, 'runner-1')
  assert.equal(created.state, 'running')
  assert.equal(calls[0].options.timeout, 120000)
})

test('submitLocalAgentRun returns a submitted run with create metadata', async () => {
  const submitted = await submitLocalAgentRun({
    projectRoot: '/tmp/project',
    branch: 'master',
    siteId: 'site-123',
    env: {},
    run: {
      agent: 'codex',
      promptText: 'Review',
      status: 'pending',
      runnerId: '',
      raw: { stepId: 'review' },
    },
    async runCommand() {
      return { status: 0, stdout: JSON.stringify({ id: 'runner-1', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(submitted.status, 'submitted')
  assert.equal(submitted.runnerId, 'runner-1')
  assert.equal(submitted.raw.create.id, 'runner-1')
})

test('normalizeCompletedRun prefers latest session result and links', () => {
  const normalized = normalizeCompletedRun({
    run: { agent: 'codex', runnerId: 'runner-1', status: 'submitted' },
    shown: { raw: { id: 'runner-1', state: 'completed', result: 'runner result' } },
    sessions: {
      raw: { sessions: [] },
      latest: {
        id: 'session-1',
        result: 'session result',
        deploy_url: 'https://deploy.example',
        pull_request_url: 'https://github.com/o/r/pull/1',
      },
    },
  })

  assert.equal(normalized.status, 'completed')
  assert.equal(normalized.resultText, 'session result')
  assert.equal(normalized.deployUrl, 'https://deploy.example')
  assert.equal(normalized.prUrl, 'https://github.com/o/r/pull/1')
})

test('normalizeCompletedRun fails when latest session errored even if runner completed', () => {
  const normalized = normalizeCompletedRun({
    run: { agent: 'claude', runnerId: 'runner-1', status: 'submitted' },
    shown: { raw: { id: 'runner-1', state: 'done' } },
    sessions: {
      raw: { sessions: [] },
      latest: {
        id: 'session-1',
        state: 'error',
        result: 'Encountered a temporary issue — the agent will attempt to continue.',
      },
    },
  })

  assert.equal(normalized.status, 'failed')
  assert.equal(normalized.resultText, 'Encountered a temporary issue — the agent will attempt to continue.')
  assert.equal(normalized.rawResult.latestSession.state, 'error')
})

test('showAgentRun treats CLI failures as retryable poll errors', () => {
  const shown = showAgentRun({
    projectRoot: '/tmp/project',
    runnerId: 'runner-1',
    siteId: 'site-123',
    env: {},
    runCommand() {
      return { status: 1, stdout: '', stderr: 'temporary API failure' }
    },
  })

  assert.equal(shown.state, '')
  assert.equal(shown.commandError, true)
  assert.equal(shown.error, 'temporary API failure')
})

test('listAgentSessions treats malformed JSON as a retryable command error', () => {
  const sessions = listAgentSessions({
    projectRoot: '/tmp/project',
    runnerId: 'runner-1',
    env: {},
    runCommand() {
      return { status: 0, stdout: '{not json', stderr: '' }
    },
  })

  assert.equal(sessions.commandError, true)
  assert.equal(sessions.raw, null)
  assert.deepEqual(sessions.latest, {})
  assert.match(sessions.error, /Could not parse listAgentRunnerSessions JSON/)
})

test('waitForLocalAgentRuns retries transient poll errors', async () => {
  let showCount = 0
  const progress = []
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{ agent: 'claude', runnerId: 'runner-1', status: 'submitted', resultText: '' }],
    onProgress(event) {
      progress.push(event.message)
    },
    runCommand(command, args) {
      if (args[0] === 'agents:show') {
        showCount += 1
        if (showCount === 1) return { status: 1, stdout: '', stderr: 'temporary API failure' }
        return {
          status: 0,
          stdout: JSON.stringify({ id: 'runner-1', state: 'completed' }),
          stderr: '',
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify({ sessions: [{ id: 'session-1', result: 'done' }] }),
        stderr: '',
      }
    },
  })

  assert.equal(result[0].status, 'completed')
  assert.equal(result[0].resultText, 'done')
  assert.match(progress[0], /poll failed, retrying/)
})

test('waitForLocalAgentRuns retries malformed session-list JSON', async () => {
  let listCount = 0
  const progress = []
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{ agent: 'codex', runnerId: 'runner-1', status: 'submitted', resultText: '' }],
    onProgress(event) {
      progress.push(event)
    },
    runCommand(command, args) {
      if (args[0] === 'agents:show') {
        return {
          status: 0,
          stdout: JSON.stringify({ id: 'runner-1', state: 'completed' }),
          stderr: '',
        }
      }
      listCount += 1
      return {
        status: 0,
        stdout: listCount === 1
          ? '{not json'
          : JSON.stringify({ sessions: [{ id: 'session-1', result: 'done' }] }),
        stderr: '',
      }
    },
  })

  assert.equal(listCount, 2)
  assert.equal(result[0].status, 'completed')
  assert.equal(result[0].resultText, 'done')
  assert.equal(progress.some((event) => /session list failed, retrying/.test(event.message)), true)
})

test('waitForLocalAgentRuns keeps polling an error state until it resolves', async () => {
  let showCount = 0
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{ agent: 'claude', runnerId: 'runner-1', status: 'submitted', resultText: '' }],
    runCommand(command, args) {
      if (args[0] === 'agents:show') {
        showCount += 1
        return {
          status: 0,
          stdout: JSON.stringify({
            id: 'runner-1',
            state: showCount === 1 ? 'error' : 'done',
          }),
          stderr: '',
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify({ sessions: [{ id: 'session-1', result: 'done' }] }),
        stderr: '',
      }
    },
  })

  assert.equal(showCount, 2)
  assert.equal(result[0].status, 'completed')
  assert.equal(result[0].resultText, 'done')
})

test('waitForLocalAgentRuns fails terminal runner error states immediately', async () => {
  const progress = []
  const calls = []
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{ agent: 'claude', runnerId: 'runner-1', status: 'submitted', resultText: '' }],
    onProgress(event) {
      progress.push(event)
    },
    runCommand(command, args) {
      calls.push(args[0])
      if (args[0] === 'agents:show') {
        return {
          status: 0,
          stdout: JSON.stringify({
            id: 'runner-1',
            state: 'error',
            done_at: '2026-05-15T01:25:58.379Z',
            latest_session_state: 'error',
          }),
          stderr: '',
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify([{
          id: 'session-1',
          state: 'error',
          result: 'The agent failed permanently.',
        }]),
        stderr: '',
      }
    },
  })

  assert.deepEqual(calls, ['agents:show', 'api'])
  assert.equal(progress[0].terminal, true)
  assert.equal(progress[0].terminalSuccess, false)
  assert.equal(progress[0].terminalFailure, true)
  assert.equal(result[0].status, 'failed')
  assert.equal(result[0].resultText, 'The agent failed permanently.')
  assert.equal(result[0].rawResult.latestSession.state, 'error')
})

test('waitForLocalAgentRuns retries Claude capacity failures once on the same runner', async () => {
  const progress = []
  const calls = []
  let showCount = 0
  let listCount = 0
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{
      agent: 'claude',
      runnerId: 'runner-1',
      status: 'submitted',
      promptText: 'retry this prompt',
      resultText: '',
    }],
    onProgress(event) {
      progress.push(event)
    },
    runCommand(command, args) {
      calls.push(args.slice(0, 2))
      if (args[0] === 'agents:show') {
        showCount += 1
        return {
          status: 0,
          stdout: JSON.stringify(showCount === 1
            ? {
                id: 'runner-1',
                state: 'error',
                done_at: '2026-05-15T01:25:58.379Z',
                latest_session_state: 'error',
              }
            : { id: 'runner-1', state: 'done' }),
          stderr: '',
        }
      }
      if (args[1] === 'listAgentRunnerSessions') {
        listCount += 1
        return {
          status: 0,
          stdout: JSON.stringify(listCount === 1
            ? [{
                id: 'session-1',
                state: 'error',
                result: 'The Claude Code model is currently at capacity. Retrying automatically...',
              }]
            : [{ id: 'session-2', state: 'done', result: 'retried result' }]),
          stderr: '',
        }
      }
      assert.equal(args[1], 'createAgentRunnerSession')
      assert.deepEqual(JSON.parse(args[3]), {
        agent_runner_id: 'runner-1',
        body: {
          prompt: 'retry this prompt',
          agent: 'claude',
        },
      })
      return {
        status: 0,
        stdout: JSON.stringify({ id: 'session-2', state: 'running' }),
        stderr: '',
      }
    },
  })

  assert.deepEqual(calls, [
    ['agents:show', 'runner-1'],
    ['api', 'listAgentRunnerSessions'],
    ['api', 'createAgentRunnerSession'],
    ['agents:show', 'runner-1'],
    ['api', 'listAgentRunnerSessions'],
  ])
  assert.equal(progress.some((event) => event.retry === true), true)
  assert.equal(result[0].status, 'completed')
  assert.equal(result[0].resultText, 'retried result')
  assert.equal(result[0].autoRetryCount, 1)
  assert.equal(result[0].raw.autoRetries[0].id, 'session-2')
})

test('waitForLocalAgentRuns retries Gemini and Codex capacity failures', async () => {
  for (const agent of ['gemini', 'codex']) {
    let showCount = 0
    let listCount = 0
    let retryCount = 0
    const result = await waitForLocalAgentRuns({
      projectRoot: '/tmp/project',
      siteId: 'site-123',
      env: {},
      timeoutMinutes: 1,
      initialDelayMs: 0,
      pollIntervalMs: 1,
      runs: [{
        agent,
        runnerId: `runner-${agent}`,
        status: 'submitted',
        promptText: 'retry this prompt',
        resultText: '',
      }],
      runCommand(command, args) {
        if (args[0] === 'agents:show') {
          showCount += 1
          return {
            status: 0,
            stdout: JSON.stringify(showCount === 1
              ? {
                  id: `runner-${agent}`,
                  state: 'error',
                  done_at: '2026-05-15T01:25:58.379Z',
                  latest_session_state: 'error',
                }
              : { id: `runner-${agent}`, state: 'done' }),
            stderr: '',
          }
        }
        if (args[1] === 'listAgentRunnerSessions') {
          listCount += 1
          return {
            status: 0,
            stdout: JSON.stringify(listCount === 1
              ? [{
                  id: 'session-1',
                  state: 'error',
                  result: `The ${agent === 'gemini' ? 'Gemini' : 'Codex'} model is currently at capacity. Retrying automatically...`,
                }]
              : [{ id: 'session-2', state: 'done', result: `${agent} retried result` }]),
            stderr: '',
          }
        }
        retryCount += 1
        return {
          status: 0,
          stdout: JSON.stringify({ id: 'session-2', state: 'running' }),
          stderr: '',
        }
      },
    })

    assert.equal(retryCount, 1)
    assert.equal(result[0].status, 'completed')
    assert.equal(result[0].resultText, `${agent} retried result`)
  }
})

test('waitForLocalAgentRuns retries argument limit failures once with compact prompt', async () => {
  const calls = []
  let showCount = 0
  let listCount = 0
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{
      agent: 'claude',
      runnerId: 'runner-1',
      status: 'submitted',
      promptText: 'original prompt with too many prior results and a long embedded result payload',
      compactPromptText: 'compact prompt',
      resultText: '',
    }],
    runCommand(command, args) {
      calls.push(args.slice(0, 2))
      if (args[0] === 'agents:show') {
        showCount += 1
        return {
          status: 0,
          stdout: JSON.stringify(showCount === 1
            ? {
                id: 'runner-1',
                state: 'error',
                done_at: '2026-05-15T01:25:58.379Z',
                latest_session_state: 'error',
              }
            : { id: 'runner-1', state: 'done' }),
          stderr: '',
        }
      }
      if (args[1] === 'listAgentRunnerSessions') {
        listCount += 1
        return {
          status: 0,
          stdout: JSON.stringify(listCount === 1
            ? [{
                id: 'session-1',
                state: 'error',
                result: 'fork/exec /opt/build-bin/agent-runner: argument list too long',
              }]
            : [{ id: 'session-2', state: 'done', result: 'retried compact result' }]),
          stderr: '',
        }
      }

      assert.equal(args[1], 'createAgentRunnerSession')
      assert.deepEqual(JSON.parse(args[3]), {
        agent_runner_id: 'runner-1',
        body: {
          prompt: 'compact prompt',
          agent: 'claude',
        },
      })
      return {
        status: 0,
        stdout: JSON.stringify({ id: 'session-2', state: 'running' }),
        stderr: '',
      }
    },
  })

  assert.deepEqual(calls, [
    ['agents:show', 'runner-1'],
    ['api', 'listAgentRunnerSessions'],
    ['api', 'createAgentRunnerSession'],
    ['agents:show', 'runner-1'],
    ['api', 'listAgentRunnerSessions'],
  ])
  assert.equal(result[0].status, 'completed')
  assert.equal(result[0].resultText, 'retried compact result')
  assert.equal(result[0].promptText, 'compact prompt')
  assert.equal(result[0].promptShrinkRetryCount, 1)
  assert.equal(result[0].raw.autoRetries[0].retryReason, 'argument-list-too-long')
})

test('waitForLocalAgentRuns does not retry Claude capacity failures more than once', async () => {
  const calls = []
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{
      agent: 'claude',
      runnerId: 'runner-1',
      status: 'submitted',
      promptText: 'retry this prompt',
      resultText: '',
    }],
    runCommand(command, args) {
      calls.push(args.slice(0, 2))
      if (args[0] === 'agents:show') {
        return {
          status: 0,
          stdout: JSON.stringify({
            id: 'runner-1',
            state: 'error',
            done_at: '2026-05-15T01:25:58.379Z',
            latest_session_state: 'error',
          }),
          stderr: '',
        }
      }
      if (args[1] === 'createAgentRunnerSession') {
        return {
          status: 0,
          stdout: JSON.stringify({ id: 'session-2', state: 'running' }),
          stderr: '',
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify([{
          id: 'session-1',
          state: 'error',
          result: 'The Claude Code model is currently at capacity. Retrying automatically...',
        }]),
        stderr: '',
      }
    },
  })

  assert.equal(calls.filter((args) => args[1] === 'createAgentRunnerSession').length, 1)
  assert.equal(result[0].status, 'failed')
  assert.equal(result[0].autoRetryCount, 1)
  assert.equal(result[0].resultText, 'The Claude Code model is currently at capacity. Retrying automatically...')
})

test('waitForLocalAgentRuns returns completed runs after polling terminal state', async () => {
  const calls = []
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{ agent: 'codex', runnerId: 'runner-1', status: 'submitted', resultText: '' }],
    runCommand(command, args) {
      calls.push(args[0])
      if (args[0] === 'agents:show') {
        return {
          status: 0,
          stdout: JSON.stringify({ id: 'runner-1', state: 'completed' }),
          stderr: '',
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify({ sessions: [{ id: 'session-1', result: 'done' }] }),
        stderr: '',
      }
    },
  })

  assert.deepEqual(calls, ['agents:show', 'api'])
  assert.equal(result[0].status, 'completed')
  assert.equal(result[0].resultText, 'done')
})

test('waitForLocalAgentRuns fails completed parent runners with errored latest sessions', async () => {
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{ agent: 'claude', runnerId: 'runner-1', status: 'submitted', resultText: '' }],
    runCommand(command, args) {
      if (args[0] === 'agents:show') {
        return {
          status: 0,
          stdout: JSON.stringify({ id: 'runner-1', state: 'done' }),
          stderr: '',
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          sessions: [{
            id: 'session-1',
            state: 'error',
            result: 'Encountered a temporary issue — the agent will attempt to continue.',
          }],
        }),
        stderr: '',
      }
    },
  })

  assert.equal(result[0].status, 'failed')
  assert.equal(result[0].resultText, 'Encountered a temporary issue — the agent will attempt to continue.')
})
