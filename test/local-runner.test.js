const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
  createAgentRun,
  createAgentRunAsync,
  createAgentSession,
  createAgentSessionAsync,
  findNetlifyConfigPaths,
  formatCommandForError,
  inferNetlifyFilterFromCommand,
  latestSessionFromList,
  listNetlifyFilterCandidates,
  listAgentSessions,
  normalizeCompletedRun,
  readRootNetlifyBuildCommand,
  resolveNetlifyFilter,
  waitForLocalAgentRuns,
  showAgentRun,
  submitLocalAgentRun,
  runAsync,
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

test('runAsync redacts sensitive payloads from exec errors', async () => {
  const payload = '{"prompt":"secret prompt"}'
  await assert.rejects(
    runAsync(process.execPath, ['-e', 'process.exit(1)', '--data', payload]),
    (error) => {
      assert.match(error.message, /--data <redacted>/)
      assert.doesNotMatch(error.message, /secret prompt/)
      return true
    },
  )
})

test('inferNetlifyFilterFromCommand reads a single package-manager filter', () => {
  assert.equal(
    inferNetlifyFilterFromCommand('BUGSNAG=1 pnpm --filter revenue-engine-frontend build:netlify'),
    'revenue-engine-frontend',
  )
  assert.equal(inferNetlifyFilterFromCommand('pnpm --filter=revenue-engine-frontend build'), 'revenue-engine-frontend')
  assert.equal(inferNetlifyFilterFromCommand('pnpm -F "revenue-engine-frontend" build'), 'revenue-engine-frontend')
  assert.equal(inferNetlifyFilterFromCommand('pnpm --filter one --filter two build'), '')
})

test('resolveNetlifyFilter infers a root filter from netlify.toml build command', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-local-runner-filter-'))
  fs.writeFileSync(path.join(tmp, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '  publish = "clients/frontend/dist"',
    '',
  ].join('\n'))

  assert.equal(readRootNetlifyBuildCommand(tmp), 'pnpm --filter revenue-engine-frontend build:netlify')
  assert.deepEqual(resolveNetlifyFilter({ projectRoot: tmp }), {
    filter: 'revenue-engine-frontend',
    source: 'netlify.toml',
  })
  assert.deepEqual(resolveNetlifyFilter({ projectRoot: tmp, filter: 'explicit-app' }), {
    filter: 'explicit-app',
    source: 'option',
  })
})

test('resolveNetlifyFilter falls back to a nested netlify.toml build command', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-local-runner-nested-filter-'))
  const appDir = path.join(tmp, 'apps', 'workspace', 'packages', 'clients', 'frontend')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '  publish = "/clients/frontend/dist"',
    '',
  ].join('\n'))

  assert.deepEqual(resolveNetlifyFilter({ projectRoot: tmp }), {
    filter: 'revenue-engine-frontend',
    source: path.join('apps', 'workspace', 'packages', 'clients', 'frontend', 'netlify.toml'),
  })
  assert.deepEqual(listNetlifyFilterCandidates(tmp).map((candidate) => ({
    source: candidate.source,
    filter: candidate.filter,
  })), [{
    source: path.join('apps', 'workspace', 'packages', 'clients', 'frontend', 'netlify.toml'),
    filter: 'revenue-engine-frontend',
  }])
})

test('findNetlifyConfigPaths skips netlify.toml inside gitignored directories', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-local-runner-gitignore-'))
  spawnSync('git', ['init', '-q'], { cwd: tmp })
  fs.writeFileSync(path.join(tmp, '.gitignore'), 'projects/data/data-internal/\n')

  fs.writeFileSync(path.join(tmp, 'netlify.toml'), '[build]\n')

  const ignoredDir = path.join(tmp, 'projects', 'data', 'data-internal')
  fs.mkdirSync(ignoredDir, { recursive: true })
  fs.writeFileSync(path.join(ignoredDir, 'netlify.toml'), '[build]\n')

  const trackedDir = path.join(tmp, 'projects', 'data', 'snowflake_dbt')
  fs.mkdirSync(trackedDir, { recursive: true })
  fs.writeFileSync(path.join(trackedDir, 'netlify.toml'), '[build]\n')

  const results = findNetlifyConfigPaths(tmp).map((p) => path.relative(tmp, p))
  assert.deepEqual(results.sort(), [
    'netlify.toml',
    path.join('projects', 'data', 'snowflake_dbt', 'netlify.toml'),
  ].sort())
})

test('findNetlifyConfigPaths returns all paths when project is not a git repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-local-runner-nogit-'))
  fs.writeFileSync(path.join(tmp, 'netlify.toml'), '[build]\n')
  const nested = path.join(tmp, 'projects', 'app')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'netlify.toml'), '[build]\n')

  const results = findNetlifyConfigPaths(tmp).map((p) => path.relative(tmp, p))
  assert.deepEqual(results.sort(), [
    'netlify.toml',
    path.join('projects', 'app', 'netlify.toml'),
  ].sort())
})

test('resolveNetlifyFilter ignores ambiguous nested netlify.toml filters', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-local-runner-ambiguous-filter-'))
  for (const [dir, filter] of [['frontend', 'web'], ['docs', 'docs']]) {
    const appDir = path.join(tmp, 'clients', dir)
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
      '[build]',
      `  command = "pnpm --filter ${filter} build"`,
      '',
    ].join('\n'))
  }

  assert.deepEqual(resolveNetlifyFilter({ projectRoot: tmp }), {
    filter: '',
    source: '',
  })
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

test('createAgentRun passes Netlify monorepo filter when provided', () => {
  const calls = []
  createAgentRun({
    projectRoot: '/tmp/project',
    promptText: 'Review this repo',
    agent: 'codex',
    branch: 'master',
    siteId: 'site-123',
    netlifyFilter: 'revenue-engine-frontend',
    env: { NETLIFY_SITE_ID: 'site-123' },
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ id: 'runner-1', state: 'running' }), stderr: '' }
    },
  })

  assert.deepEqual(calls[0].args, [
    'agents:create',
    '--json',
    '--agent',
    'codex',
    '--project',
    'site-123',
    '--branch',
    'master',
    '--filter',
    'revenue-engine-frontend',
    '--prompt',
    'Review this repo',
  ])
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

test('createAgentRunAsync passes Netlify monorepo filter when provided', async () => {
  const calls = []
  await createAgentRunAsync({
    projectRoot: '/tmp/project',
    promptText: 'Review async',
    agent: 'gemini',
    branch: 'master',
    siteId: 'site-123',
    netlifyFilter: 'revenue-engine-frontend',
    env: {},
    async runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ id: 'runner-async', state: 'running' }), stderr: '' }
    },
  })

  assert.deepEqual(calls[0].args, [
    'agents:create',
    '--json',
    '--agent',
    'gemini',
    '--project',
    'site-123',
    '--branch',
    'master',
    '--filter',
    'revenue-engine-frontend',
    '--prompt',
    'Review async',
  ])
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

test('createAgentSessionAsync retries transient submission failures', async () => {
  const retryEvents = []
  let calls = 0
  const created = await createAgentSessionAsync({
    projectRoot: '/tmp/project',
    runnerId: 'runner-1',
    promptText: 'Cross review async',
    agent: 'gemini',
    env: {},
    retryDelayMs: 0,
    onRetry: (event) => retryEvents.push(event),
    async runCommand() {
      calls += 1
      if (calls === 1) {
        throw new Error('netlify api createAgentRunnerSession --data <redacted> failed: 502 Bad Gateway')
      }
      return { status: 0, stdout: JSON.stringify({ id: 'session-retry', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(calls, 2)
  assert.equal(retryEvents.length, 1)
  assert.equal(retryEvents[0].nextAttempt, 2)
  assert.equal(retryEvents[0].attempts, 5)
  assert.equal(retryEvents[0].delayMs, 0)
  assert.equal(created.runnerId, 'runner-1')
  assert.equal(created.raw.id, 'session-retry')
})

test('createAgentSessionAsync uses exponential backoff between retry attempts', async () => {
  const retryEvents = []
  const sleeps = []
  let calls = 0
  const created = await createAgentSessionAsync({
    projectRoot: '/tmp/project',
    runnerId: 'runner-1',
    promptText: 'Cross review async',
    agent: 'gemini',
    env: {},
    onRetry: (event) => retryEvents.push(event),
    sleepFn: async (ms) => sleeps.push(ms),
    async runCommand() {
      calls += 1
      if (calls < 4) {
        throw new Error('netlify api createAgentRunnerSession --data <redacted> failed: 503 Service Unavailable')
      }
      return { status: 0, stdout: JSON.stringify({ id: 'session-retry', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(calls, 4)
  assert.deepEqual(retryEvents.map((event) => event.nextAttempt), [2, 3, 4])
  assert.deepEqual(retryEvents.map((event) => event.delayMs), [5000, 10000, 20000])
  assert.deepEqual(sleeps, [5000, 10000, 20000])
  assert.equal(created.raw.id, 'session-retry')
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

test('submitLocalAgentRun preserves follow-up session id', async () => {
  const submitted = await submitLocalAgentRun({
    projectRoot: '/tmp/project',
    branch: 'master',
    siteId: 'site-123',
    env: {},
    run: {
      agent: 'codex',
      promptText: 'Cross review',
      status: 'pending',
      runnerId: 'runner-1',
      existingRunnerId: 'runner-1',
      raw: { stepId: 'cross-review' },
    },
    async runCommand() {
      return { status: 0, stdout: JSON.stringify({ id: 'session-1', state: 'running' }), stderr: '' }
    },
  })

  assert.equal(submitted.status, 'submitted')
  assert.equal(submitted.runnerId, 'runner-1')
  assert.equal(submitted.sessionId, 'session-1')
  assert.equal(submitted.raw.session.id, 'session-1')
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
        usage: {
          total_input_tokens: 100,
          total_output_tokens: 20,
          total_tokens: 120,
          total_credits_cost: 1.5,
        },
        steps_count: 8,
        credit_limit_exceeded: false,
      },
    },
  })

  assert.equal(normalized.status, 'completed')
  assert.equal(normalized.sessionId, 'session-1')
  assert.equal(normalized.resultText, 'session result')
  assert.equal(normalized.deployUrl, 'https://deploy.example')
  assert.equal(normalized.prUrl, 'https://github.com/o/r/pull/1')
  assert.deepEqual(normalized.usage, {
    totalTokens: 120,
    totalCreditsCost: 1.5,
    stepsCount: 8,
    creditLimitExceeded: false,
  })
  assert.deepEqual(normalized.links, {
    deployUrl: 'https://deploy.example',
    prUrl: 'https://github.com/o/r/pull/1',
  })
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

test('showAgentRun passes Netlify monorepo filter when provided', () => {
  const calls = []
  const shown = showAgentRun({
    projectRoot: '/tmp/project',
    runnerId: 'runner-1',
    siteId: 'site-123',
    netlifyFilter: 'revenue-engine-frontend',
    env: {},
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ id: 'runner-1', state: 'done' }), stderr: '' }
    },
  })

  assert.equal(shown.state, 'done')
  assert.deepEqual(calls[0].args, [
    'agents:show',
    'runner-1',
    '--json',
    '--project',
    'site-123',
    '--filter',
    'revenue-engine-frontend',
  ])
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
  const showArgs = []
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    netlifyFilter: 'revenue-engine-frontend',
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
        showArgs.push(args)
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
  assert.deepEqual(showArgs[0], [
    'agents:show',
    'runner-1',
    '--json',
    '--project',
    'site-123',
    '--filter',
    'revenue-engine-frontend',
  ])
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
  const terminalRuns = []
  const result = await waitForLocalAgentRuns({
    projectRoot: '/tmp/project',
    siteId: 'site-123',
    env: {},
    timeoutMinutes: 1,
    initialDelayMs: 0,
    pollIntervalMs: 1,
    runs: [{ agent: 'codex', runnerId: 'runner-1', status: 'submitted', resultText: '' }],
    onTerminalRun(run) {
      terminalRuns.push(run)
    },
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
  assert.equal(terminalRuns.length, 1)
  assert.equal(terminalRuns[0].status, 'completed')
  assert.equal(terminalRuns[0].resultText, 'done')
  assert.equal(terminalRuns[0].sessionId, 'session-1')
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
