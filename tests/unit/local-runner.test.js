const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  archiveAgentRun,
  buildNetlifyEnv,
  compactPromptForArgumentLimitRetry,
  formatCommandForError,
  latestSessionFromList,
  listAgentSessions,
  resolveNetlifyProjectTarget,
  showAgentRun,
  stopAgentRun,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
} = require('../../src/integrations/netlify/local-runner')

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const FOLLOWUP_ID = '22222222-2222-4222-8222-222222222222'

/** @returns {import('agent-runner-sdk').RunHandle} */
function handle(overrides = {}) {
  return {
    v: 1,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'codex',
    input: {
      siteId: 'site-1',
      prompt: 'Review this repo',
      agent: 'codex',
      branch: 'feature/sdk',
      land: 'none',
      deadlineMs: 60_000,
      retryBudget: { capacity: 1 },
      requestId: REQUEST_ID,
    },
    policy: {
      landing: 'none',
      deadlineAt: Date.now() + 60_000,
      retryBudget: { capacity: 1 },
    },
    retries: { capacity: 0 },
    currentSessionId: 'session-1',
    ...overrides,
  }
}

function runner(overrides = {}) {
  return {
    runnerId: 'runner-1',
    state: 'running',
    siteId: 'site-1',
    branch: 'feature/sdk',
    currentTask: 'Reading files',
    ...overrides,
  }
}

function session(sessionId = 'session-1', overrides = {}) {
  return {
    sessionId,
    runnerId: 'runner-1',
    state: 'running',
    prompt: 'Review this repo',
    agent: 'codex',
    usage: null,
    ...overrides,
  }
}

function sdkHarness(overrides = {}) {
  const calls = []
  const transport = {
    getRunner: async (runnerId) => {
      calls.push(['getRunner', runnerId])
      return runner()
    },
    getSession: async (runnerId, sessionId) => {
      calls.push(['getSession', runnerId, sessionId])
      return session(sessionId)
    },
    listSessions: async (runnerId) => {
      calls.push(['listSessions', runnerId])
      return [session()]
    },
    cancelRunner: async (runnerId) => {
      calls.push(['cancelRunner', runnerId])
    },
    member: async (runnerId, action, input) => {
      calls.push(['member', runnerId, action, input])
    },
    ...overrides.transport,
  }
  const sdk = {
    transport,
    start: async (input) => {
      calls.push(['start', input])
      return handle()
    },
    followUp: async (base, input) => {
      calls.push(['followUp', base, input])
      return handle({
        ...base,
        kind: 'session',
        currentSessionId: 'session-2',
        sessionId: 'session-2',
        sessionInput: {
          prompt: input.prompt,
          agent: input.agent,
          requestId: FOLLOWUP_ID,
        },
      })
    },
    getSnapshot: async (value) => {
      calls.push(['getSnapshot', value])
      return {
        kind: 'terminal',
        result: {
          status: 'succeeded',
          runnerId: value.runnerId,
          sessionId: value.currentSessionId,
          resultText: 'Done',
          usage: { totalTokens: 42 },
          changes: 'changed',
          links: {},
        },
      }
    },
    stop: async (value) => {
      calls.push(['stop', value])
      return value
    },
    shouldRetry: () => false,
    ...overrides.sdk,
  }
  return { sdk, calls }
}

test('submission creates a fresh SDK run and persists its exact handle', async () => {
  const { sdk, calls } = sdkHarness({
    transport: {
      getRunner: async () => runner(),
      getSession: async () => session(),
    },
  })
  const submitted = await submitLocalAgentRun({
    run: {
      transport: 'netlify-api',
      agent: 'codex',
      status: 'pending',
      promptText: 'Review this repo',
      raw: {},
    },
    siteId: 'site-1',
    branch: 'feature/sdk',
    timeoutMinutes: 12,
    sdk,
  })

  const start = calls.find(([operation]) => operation === 'start')
  assert.equal(start[1].siteId, 'site-1')
  assert.equal(start[1].prompt, 'Review this repo')
  assert.equal(start[1].branch, 'feature/sdk')
  assert.equal(start[1].deadlineMs, 12 * 60 * 1000)
  assert.equal(start[1].retryBudget.capacity, 1)
  assert.equal(submitted.runnerId, 'runner-1')
  assert.equal(submitted.sessionId, 'session-1')
  assert.equal(submitted.sdkHandle.runnerId, 'runner-1')
  assert.equal(submitted.sdkHandle.currentSessionId, 'session-1')
  assert.deepEqual(submitted.raw.sdkHandle, submitted.sdkHandle)
})

test('follow-up submission resumes the persisted handle and records the new session', async () => {
  const base = handle()
  const { sdk, calls } = sdkHarness({
    transport: {
      getRunner: async () => runner(),
      getSession: async () => session('session-2'),
    },
  })
  const submitted = await submitLocalAgentRun({
    run: {
      agent: 'codex',
      promptText: 'Continue the review',
      existingRunnerId: 'runner-1',
      netlifySiteId: 'site-1',
      sdkHandle: base,
      raw: { sdkHandle: base },
    },
    siteId: 'site-1',
    sdk,
  })

  const followUp = calls.find(([operation]) => operation === 'followUp')
  assert.deepEqual(followUp[1], base)
  assert.deepEqual(followUp[2], {
    prompt: 'Continue the review',
    agent: 'codex',
  })
  assert.equal(submitted.runnerId, 'runner-1')
  assert.equal(submitted.sessionId, 'session-2')
  assert.equal(submitted.sdkHandle.kind, 'session')
  assert.equal(
    /** @type {{ id?: string }} */ (submitted.raw.session).id,
    'session-2',
  )
})

test('polling attributes completion to the handle current session', async () => {
  const persisted = handle({ currentSessionId: 'session-current' })
  const progress = []
  const terminal = []
  const { sdk } = sdkHarness({
    transport: {
      getRunner: async () => runner({ state: 'completed', hasResultDiff: true }),
      listSessions: async () => [
        session('session-old', { state: 'completed', resultText: 'Old' }),
        session('session-current', {
          state: 'completed',
          resultText: 'Current result',
          hasResultDiff: true,
          usage: { totalTokens: 42 },
        }),
      ],
    },
  })
  const [completed] = await waitForLocalAgentRuns({
    runs: [{
      agent: 'codex',
      status: 'submitted',
      promptText: 'Review this repo',
      runnerId: 'runner-1',
      sessionId: 'session-current',
      netlifySiteId: 'site-1',
      sdkHandle: persisted,
      raw: { sdkHandle: persisted },
    }],
    siteId: 'site-1',
    initialDelayMs: 0,
    pollIntervalMs: 1,
    sdk,
    onProgress: (event) => progress.push(event),
    onTerminalRun: (run) => terminal.push(run),
  })

  assert.equal(completed.status, 'completed')
  assert.equal(completed.sessionId, 'session-current')
  assert.equal(completed.resultText, 'Current result')
  assert.equal(completed.usage.totalTokens, 42)
  assert.equal(completed.fileChanges.hasChanges, true)
  assert.equal(completed.rawResult.latestSession.id, 'session-current')
  assert.equal(terminal.length, 1)
  assert.equal(progress.at(-1).terminalSuccess, true)
})

test('capacity retry stays on the runner and advances the SDK handle once', async () => {
  let currentSessionId = 'session-1'
  const initial = handle()
  const { sdk, calls } = sdkHarness({
    transport: {
      getRunner: async () => runner({
        state: currentSessionId === 'session-1' ? 'failed' : 'completed',
      }),
      getSession: async (_runnerId, requestedSessionId) => session(
        requestedSessionId,
        requestedSessionId === 'session-1'
          ? {
              state: 'failed',
              resultText: 'The Codex model is currently at capacity. Retrying automatically...',
            }
          : {
              state: 'completed',
              resultText: 'Recovered',
            },
      ),
      listSessions: async () => [
        session('session-1', {
          state: 'failed',
          resultText: 'The Codex model is currently at capacity. Retrying automatically...',
        }),
        ...(currentSessionId === 'session-2'
          ? [session('session-2', { state: 'completed', resultText: 'Recovered' })]
          : []),
      ],
    },
    sdk: {
      getSnapshot: async (value) => value.currentSessionId === 'session-1'
        ? {
            kind: 'terminal',
            result: {
              status: 'failed',
              runnerId: 'runner-1',
              sessionId: 'session-1',
              failure: {
                category: 'capacity',
                code: 'model-capacity',
                message: 'capacity',
                retryable: true,
              },
              usage: null,
            },
          }
        : {
            kind: 'terminal',
            result: {
              status: 'succeeded',
              runnerId: 'runner-1',
              sessionId: 'session-2',
              resultText: 'Recovered',
              usage: null,
              changes: 'unknown',
              links: {},
            },
          },
      shouldRetry: () => true,
      followUp: async (base, input) => {
        calls.push(['followUp', base, input])
        currentSessionId = 'session-2'
        return {
          ...base,
          kind: 'session',
          currentSessionId,
          sessionId: currentSessionId,
          sessionInput: {
            prompt: input.prompt,
            agent: input.agent,
            requestId: FOLLOWUP_ID,
          },
        }
      },
    },
  })
  const [completed] = await waitForLocalAgentRuns({
    runs: [{
      agent: 'codex',
      status: 'submitted',
      promptText: 'Review this repo',
      runnerId: 'runner-1',
      sessionId: 'session-1',
      netlifySiteId: 'site-1',
      sdkHandle: initial,
      raw: { sdkHandle: initial },
    }],
    siteId: 'site-1',
    initialDelayMs: 0,
    pollIntervalMs: 1,
    sdk,
  })

  assert.equal(calls.filter(([operation]) => operation === 'followUp').length, 1)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.resultText, 'Recovered')
  assert.equal(completed.autoRetryCount, 1)
  assert.equal(completed.sdkHandle.currentSessionId, 'session-2')
  assert.equal(completed.sdkHandle.retries.capacity, 1)
})

test('runner controls and reads use only the SDK transport boundary', async () => {
  const persisted = handle()
  const { sdk, calls } = sdkHarness()

  const shown = await showAgentRun({ runnerId: 'runner-1', sdk })
  const sessions = await listAgentSessions({ runnerId: 'runner-1', sdk })
  const stopped = await stopAgentRun({
    runnerId: 'runner-1',
    sdkHandle: persisted,
    sdk,
  })
  const archived = await archiveAgentRun({ runnerId: 'runner-1', sdk })

  assert.equal(shown.state, 'running')
  assert.equal(sessions.latest.id, 'session-1')
  assert.equal(stopped.stopped, true)
  assert.equal(archived.archived, true)
  assert.ok(calls.some(([operation]) => operation === 'stop'))
  assert.deepEqual(
    calls.find(([operation]) => operation === 'member').slice(0, 4),
    ['member', 'runner-1', 'archive', {}],
  )
  assert.equal(calls.some(([operation]) => operation === 'runCommand'), false)
})

test('legacy run handles are recovered from the exact persisted session before follow-up', async () => {
  const { sdk, calls } = sdkHarness({
    transport: {
      listSessions: async () => [
        session('session-old'),
        session('session-current'),
      ],
      getRunner: async () => runner(),
      getSession: async () => session('session-2'),
    },
  })
  await submitLocalAgentRun({
    run: {
      agent: 'codex',
      promptText: 'Continue',
      existingRunnerId: 'runner-1',
      sessionId: 'session-current',
      netlifySiteId: 'site-1',
      raw: {},
    },
    siteId: 'site-1',
    sdk,
  })

  const followUp = calls.find(([operation]) => operation === 'followUp')
  assert.equal(followUp[1].currentSessionId, 'session-current')
  assert.equal(followUp[1].siteId, 'site-1')
})

test('local runner utilities preserve redaction, prompt retry, and target selection', () => {
  assert.deepEqual(
    latestSessionFromList([{ id: 's1' }, { id: 's2' }]),
    { id: 's2' },
  )
  assert.equal(
    formatCommandForError(
      'netlify',
      ['agents:create', '--prompt', 'secret prompt', '--agent', 'codex'],
    ),
    'netlify agents:create --prompt <redacted> --agent codex',
  )
  assert.equal(compactPromptForArgumentLimitRetry({
    promptText: 'short blob wrapper',
    compactPromptText: 'compact fallback',
    blobRef: { store: 's', key: 'k' },
    promptDelivery: { mode: 'blob' },
  }), 'short blob wrapper')

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-sdk-target-'))
  fs.mkdirSync(path.join(projectRoot, '.netlify'), { recursive: true })
  fs.writeFileSync(
    path.join(projectRoot, '.netlify', 'state.json'),
    JSON.stringify({ siteId: 'site-1' }),
  )
  const built = buildNetlifyEnv({
    projectRoot,
    env: { NETLIFY_AUTH_TOKEN: 'token' },
  })
  assert.equal(built.siteId, 'site-1')
  assert.equal(built.env.NETLIFY_AUTH_TOKEN, 'token')
  assert.equal(
    resolveNetlifyProjectTarget({ projectRoot, env: built.env }).siteId,
    'site-1',
  )
})
