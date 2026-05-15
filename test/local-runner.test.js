const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createAgentRun,
  createAgentRunAsync,
  createAgentSession,
  createAgentSessionAsync,
  formatCommandForError,
  latestSessionFromList,
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
