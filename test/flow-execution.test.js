const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { _private } = require('../bin/nax')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-execution-'))
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '')
}

function writeRunState(projectRoot, runId, overrides = {}) {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  const state = {
    schemaVersion: 1,
    runId,
    flowId: 'do-next',
    flowTitle: 'Do Next',
    transport: 'netlify-api',
    projectRoot,
    createdAt: '2026-05-20T20:00:00.000Z',
    updatedAt: '2026-05-20T20:00:00.000Z',
    status: 'completed',
    steps: [{
      id: 'synthesize',
      title: 'Synthesize Next Task',
      status: 'completed',
      runs: [{
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        resultText: 'Final result',
        usage: { totalCreditsCost: 1.5, stepsCount: 2, totalTokens: 3000 },
      }],
    }],
    dir,
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, 'workflow.json'), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

test('sourceIssueNumbersForStep dedupes issue numbers across prior steps', () => {
  const completed = new Map([
    ['review', { runs: [{ issueNumber: 83 }, { issueNumber: 84 }, { issueNumber: 85 }] }],
    ['cross-review', { runs: [{ issueNumber: 83 }, { issueNumber: 84 }, { issueNumber: 85 }] }],
  ])
  const step = {
    input: [
      { step: 'review', results: 'all' },
      { step: 'cross-review', results: 'all' },
    ],
  }

  assert.deepEqual(_private.sourceIssueNumbersForStep(step, completed), [83, 84, 85])
})

test('sourceRunsForStep keeps follow-up results per input step even when runner id is reused', () => {
  const completed = new Map([
    ['review', { runs: [{ agent: 'codex', runnerId: 'runner-1', resultText: 'done' }] }],
    ['cross-review', { runs: [{ agent: 'codex', runnerId: 'runner-1', resultText: 'done again' }] }],
  ])
  const step = {
    input: [
      { step: 'review', results: 'all' },
      { step: 'cross-review', results: 'all' },
    ],
  }

  assert.deepEqual(_private.sourceRunsForStep(step, completed), [
    { agent: 'codex', runnerId: 'runner-1', resultText: 'done', sourceStep: 'review' },
    { agent: 'codex', runnerId: 'runner-1', resultText: 'done again', sourceStep: 'cross-review' },
  ])
})

test('sourceRunsForStep dedupes within a single input step', () => {
  const completed = new Map([
    ['review', { runs: [
      { agent: 'codex', runnerId: 'runner-1', resultText: 'a' },
      { agent: 'codex', runnerId: 'runner-1', resultText: 'b' },
    ] }],
  ])
  const step = { input: [{ step: 'review', results: 'all' }] }

  assert.deepEqual(_private.sourceRunsForStep(step, completed), [
    { agent: 'codex', runnerId: 'runner-1', resultText: 'a', sourceStep: 'review' },
  ])
})

test('formatCompactLocalRunResults truncates prior local outputs for retry prompts', () => {
  const longResult = `${'A'.repeat(800)}\nimportant tail`
  const formatted = _private.formatCompactLocalRunResults([
    {
      agent: 'claude',
      sourceStep: 'ideate',
      resultText: longResult,
    },
  ], {
    perRunLimit: 300,
    totalLimit: 1000,
  })

  assert.match(formatted, /## Prior Agent Results/)
  assert.match(formatted, /Claude from ideate/)
  assert.match(formatted, /compacted from/)
  assert.match(formatted, /important tail/)
  assert.ok(formatted.length < longResult.length)
})

test('usageSummariesForRunState aggregates usage by step and total', () => {
  const summary = _private.usageSummariesForRunState({
    steps: [
      {
        id: 'review',
        title: 'Review',
        runs: [
          {
            agent: 'claude',
            usage: {
              totalTokens: 420,
              totalCreditsCost: 1.25,
              stepsCount: 10,
            },
          },
          {
            agent: 'codex',
            rawResult: {
              latestSession: {
                usage: {
                  total_tokens: 650,
                  total_credits_cost: 2.5,
                },
                steps_count: 46,
              },
            },
          },
        ],
      },
      {
        id: 'synthesize',
        title: 'Summarize Consensus',
        runs: [
          {
            agent: 'codex',
            usage: {
              totalTokens: 15,
              totalCreditsCost: 0.1,
              stepsCount: 1,
            },
          },
        ],
      },
    ],
  })

  assert.equal(summary.steps.length, 2)
  assert.equal(summary.steps[0].title, 'Review')
  assert.equal(summary.steps[0].usage.totalTokens, 1070)
  assert.equal(summary.steps[0].usage.stepsCount, 56)
  assert.equal(summary.total.totalTokens, 1085)
  assert.equal(summary.total.totalCreditsCost, 3.85)
  assert.equal(summary.total.stepsCount, 57)
  assert.match(summary.totalSummary, /1,085 tokens/)
  assert.match(summary.totalSummary, /57 steps/)
  assert.match(summary.totalSummary, /3.85 credits/)
})

test('TTY progress rows show a green complete status', () => {
  const line = _private.formatTtyProgressRow({
    agent: 'codex',
    status: 'completed',
    url: 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner-1?session=session-1',
  }, {
    nameWidth: 6,
    frame: 0,
  })

  assert.equal(line, '✓ Codex  · 🟢 complete - https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner-1?session=session-1')
})

test('TTY progress rows show compact current task details while running', () => {
  const line = _private.formatTtyProgressRow({
    agent: 'gemini',
    status: 'running',
    emoji: '🎨',
    phrase: 'is painting a masterpiece...',
    currentTask: 'reading file src/components/VeryLongComponentNameThatShouldBeTrimmedBecauseItIsTooVerbose.jsx and comparing it against docs/reference/current-task-display-guidelines.md before writing changes',
  }, {
    nameWidth: 6,
    frame: 0,
    orchestrator: 'Netlify Agent runner',
  })

  assert.match(line, /^◐ Gemini · 🎨 Netlify Agent runner is painting a masterpiece\.\.\. - "reading file /)
  assert.match(line, /…"$/)
  assert.ok(line.length < 180)
})

test('pickFlavor avoids active phrases already in use', () => {
  const first = _private.pickFlavor({ random: () => 0 })
  const second = _private.pickFlavor({ used: new Set([first[0]]), random: () => 0 })

  assert.notEqual(second[0], first[0])
})

test('Did you know progress tip formats a rotating Agent Runner use case', () => {
  const lines = _private.formatDidYouKnowLines([
    '👀 Code reviews',
    'Bring in a fresh reviewer that can inspect architecture, tests, and edge cases.',
    'Audit the code with fresh eyes and identify areas for improvement.',
  ], { width: 72, color: '#00ad9f' })
  const text = lines.join('\n')

  assert.match(lines[0], /While agent runners are doing their magic/)
  assert.match(text, /While agent runners are doing their magic/)
  assert.match(text, /for Netlify Agent runners/)
  assert.match(text, /👀 Use Agent Runs for Code reviews/)
  assert.match(text, /Bring in a fresh reviewer/)
  assert.match(text, /Prompt Examples:/)
  assert.match(text, /- "Audit the code with fresh eyes/)
  assert.match(text, /use\s+cases/)
  assert.match(text, /╭|┌/)
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 72, `line exceeded requested width: ${stripAnsi(line).length}`)
  }
})

test('Did you know progress tip reserves terminal edge space', () => {
  const lines = _private.formatDidYouKnowLines([
    '🚦 Error handling',
    'Improve user-facing failures, logging, empty states, and recovery paths.',
    'Add proper error boundaries, logging, and user-friendly error states throughout the app.',
  ], { width: 48, marginRight: 3 })

  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 45, `line exceeded terminal-safe width: ${stripAnsi(line).length}`)
  }
})

test('physicalRowCount counts wrapped rows for lines wider than the terminal', () => {
  // 200-char line in an 80-col terminal wraps to ceil(200/80) = 3 rows.
  assert.equal(_private.physicalRowCount(['x'.repeat(200)], 80), 3)
  // Empty line still occupies 1 row.
  assert.equal(_private.physicalRowCount(['short', '', 'short'], 80), 3)
  // Falls back to logical count when columns is unknown.
  assert.equal(_private.physicalRowCount(['x'.repeat(200)], 0), 1)
  // ANSI escapes don't count toward visible width.
  const ansi = `\x1b[31m${'x'.repeat(80)}\x1b[0m`
  assert.equal(_private.physicalRowCount([ansi], 80), 1)
})

test('Did you know progress tip wraps its header instead of overflowing one logical line', () => {
  const lines = _private.formatDidYouKnowLines([
    '♿ Accessibility',
    'Review keyboard flows, labels, contrast, landmarks, and WCAG gaps.',
    'Run an accessibility audit and fix all WCAG 2.1 AA violations.',
  ], { width: 70, marginRight: 2 })

  const headerLines = []
  for (const line of lines) {
    if (/^[╭┌╰└│├┤─]/.test(stripAnsi(line))) break
    headerLines.push(line)
  }
  // Header should wrap onto multiple lines, none exceeding the viewport width.
  assert.ok(headerLines.length >= 2, `expected wrapped header rows, got ${headerLines.length}`)
  for (const line of headerLines) {
    assert.ok(stripAnsi(line).length <= 70, `header row exceeded width: ${stripAnsi(line).length}`)
  }
})

test('Did you know progress tip does not force full terminal width by default', () => {
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 200 })
  try {
    const lines = _private.formatDidYouKnowLines([
      '👀 Code reviews',
      'Bring in a fresh reviewer that can inspect architecture, tests, and edge cases.',
      'Audit the code with fresh eyes and identify areas for improvement.',
    ])
    const boxLines = lines.slice(1).map(stripAnsi)
    assert.ok(Math.max(...boxLines.map((line) => line.length)) < 120)
  } finally {
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns)
    } else {
      delete process.stdout.columns
    }
  }
})

test('TTY progress reporter clears the Agent Runner use case tip after all runs complete', () => {
  const originalWrite = process.stdout.write
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const writes = []
  process.stdout.write = (chunk, ...args) => {
    writes.push(String(chunk))
    const callback = args.find((arg) => typeof arg === 'function')
    if (callback) callback()
    return true
  }
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  try {
    const reporter = _private.makeStepProgressReporter({
      stepTitle: 'Cross Review',
      total: 2,
      agents: ['claude', 'gemini'],
    })
    reporter.updateRun({
      run: {
        agent: 'claude',
        status: 'completed',
        links: { sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-1' },
      },
      state: 'completed',
      terminal: true,
      terminalSuccess: true,
    })
    reporter.updateRun({
      run: {
        agent: 'gemini',
        status: 'completed',
        links: { sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-2?session=session-2' },
      },
      state: 'completed',
      terminal: true,
      terminalSuccess: true,
    })
    reporter.done()
  } finally {
    process.stdout.write = originalWrite
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  const progressChunks = writes.filter((chunk) => chunk.includes('Waiting for Cross Review'))
  const finalProgress = progressChunks.at(-1) || ''
  assert.match(writes.join(''), /While agent runners are doing their magic/)
  assert.match(finalProgress, /Waiting for Cross Review: 2\/2 complete/)
  assert.match(finalProgress, /✓ Claude/)
  assert.match(finalProgress, /✓ Gemini/)
  assert.doesNotMatch(finalProgress, /While agent runners are doing their magic/)
  assert.doesNotMatch(finalProgress, /Use Agent Runs for/)
})

test('nextLocalStepMessage describes the immediate transition after a local step', () => {
  const steps = [
    { title: 'Propose Next Task' },
    { title: 'Synthesize Next Task' },
  ]

  assert.equal(_private.nextLocalStepMessage(steps, 0), 'Preparing next step: Synthesize Next Task...')
  assert.equal(_private.nextLocalStepMessage(steps, 1), 'Finalizing workflow outputs...')
})

test('handoff helpers default to the latest run summary', () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'older', { updatedAt: '2026-05-20T20:00:00.000Z' })
  writeRunState(projectRoot, 'newer', { updatedAt: '2026-05-20T21:00:00.000Z' })

  const latest = _private.findRunStateForHandoff(projectRoot)
  assert.equal(latest.runId, 'newer')

  const handoff = _private.readHandoffSummary({ projectRoot })
  assert.equal(handoff.id, 'newer')
  assert.equal(handoff.kind, 'workflow')
  assert.equal(handoff.displayPath, '.nax/workflows/newer/artifacts/summary.md')
  assert.match(handoff.summaryText, /# Do Next/)
  assert.match(handoff.summaryText, /Final result/)
})

test('buildHandoffPrompt inlines instructions and summary contents', () => {
  const prompt = _private.buildHandoffPrompt({
    instructions: 'Focus on the next smallest task.',
    summaryPath: '.nax/workflows/latest/artifacts/summary.md',
    summaryText: '# Summary\n\nDone.',
  })

  assert.match(prompt, /# Additional Instructions/)
  assert.match(prompt, /Focus on the next smallest task\./)
  assert.match(prompt, /Source: \.nax\/workflows\/latest\/artifacts\/summary\.md/)
  assert.match(prompt, /# Summary\n\nDone\./)
})

test('success handoff hint is TTY-only and points at the summary file', () => {
  const projectRoot = tmpRoot()
  const state = writeRunState(projectRoot, 'newer')
  _private.readHandoffSummary({ projectRoot, runId: 'newer' })
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line = '') => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  try {
    _private.printPostSuccessHandoffHint(state, projectRoot)
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.match(lines.join('\n'), /\.nax\/workflows\/newer\/artifacts\/summary\.md/)
  assert.match(lines.join('\n'), /nax handoff/)
})

test('copyToClipboard uses the platform clipboard command', () => {
  const calls = []
  const command = _private.copyToClipboard('summary', {
    platform: 'darwin',
    runCommand: (cmd, args, options) => {
      calls.push({ cmd, args, input: options.input })
      return { status: 0 }
    },
  })

  assert.equal(command, 'pbcopy')
  assert.deepEqual(calls, [{ cmd: 'pbcopy', args: [], input: 'summary' }])
})

test('handoff source flags map to explicit artifact queries', () => {
  assert.deepEqual(_private.handoffSourceQuery({ runId: 'workflow-1', options: {} }), {
    kind: 'workflow',
    id: 'workflow-1',
  })
  assert.deepEqual(_private.handoffSourceQuery({ options: { session: 'session-1' } }), {
    kind: 'agent-session',
    id: 'session-1',
  })
  assert.deepEqual(_private.handoffSourceQuery({ options: { runner: 'runner-1' } }), {
    kind: 'agent-runner',
    id: 'runner-1',
  })
  assert.deepEqual(_private.handoffSourceQuery({ options: { sourceType: 'sessions', source: 'session-2' } }), {
    kind: 'agent-session',
    id: 'session-2',
  })
})

test('handoff source labels render source kind and relative path', () => {
  const source = {
    kind: 'agent-session',
    title: 'Codex session session-1',
    updatedAt: '2026-05-21T01:01:12.173Z',
    displayPath: '.nax/agent-sessions/session-1/summary.md',
  }

  assert.match(_private.formatHandoffSourceLabel(source), /Codex session session-1/)
  assert.equal(_private.formatHandoffSourceHint(source, process.cwd()), 'agent session · .nax/agent-sessions/session-1/summary.md')
})

test('handoff source details summarize latest workflow content', () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'workflow-1', {
    updatedAt: '2026-05-21T01:01:12.173Z',
    steps: [{
      id: 'synthesize',
      title: 'Synthesize Next Task',
      status: 'completed',
      runs: [{
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        resultText: '**Recommended Next Task:** Add focused artifact tests before more persistence work. This preview should include enough text to explain why the latest result is useful before the user opens the full summary.',
        usage: { totalCreditsCost: 1.5, stepsCount: 2, totalTokens: 3000 },
      }],
    }],
  })
  const source = _private.readHandoffSummary({ projectRoot, runId: 'workflow-1' })

  const lines = _private.handoffSourceDetailLines(source, projectRoot)

  assert.match(lines[0], /^Date:\s+May/)
  assert.match(lines[1], /Summary:\s+\.nax\/workflows\/workflow-1\/artifacts\/summary\.md/)
  assert.equal(lines[2], 'Preview:')
  assert.match(lines[3], /^\*\*Recommended Next Task:\*\* Add focused artifact tests/)

  const box = _private.formatHandoffSourceDetailBox(source, projectRoot)
  assert.match(box, /Latest result from "Do Next" workflow "Synthesize Next Task" step using Codex/)
  assert.match(box, /Summary: \.nax\/workflows\/workflow-1\/artifacts\/summary\.md/)
  assert.match(box, /Preview:/)
  assert.match(box, /This preview should/)
})

test('handoff source menu exposes latest actions before previous-source pickers', () => {
  const latestSource = {
    kind: 'workflow',
    id: 'workflow-1',
    title: 'Do Next',
    displayPath: '.nax/workflows/workflow-1/artifacts/summary.md',
  }
  const options = _private.handoffSourceMenuOptions({
    latestSource,
    sources: [
      { kind: 'workflow' },
      { kind: 'agent-session' },
      { kind: 'agent-runner' },
    ],
    projectRoot: process.cwd(),
  })

  assert.deepEqual(options.map((option) => option.label), [
    'Copy latest results to clipboard',
    'Run another AI workflow with latest result: Do Next',
    'Pick previous workflow',
    'Pick previous agent session',
    'Pick previous agent runner',
    'Cancel',
  ])
  assert.match(options[0].hint, /Do Next/)
  assert.match(options[0].hint, /\.nax\/workflows\/workflow-1\/artifacts\/summary\.md/)
})

test('non-TTY progress reporter repeats unchanged run status after heartbeat interval', () => {
  const originalLog = console.log
  const originalNow = Date.now
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  let now = 1000
  console.log = (line) => lines.push(line)
  Date.now = () => now
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = _private.makeStepProgressReporter({
      stepTitle: 'Review',
      total: 1,
      agents: ['codex'],
      nonTtyHeartbeatMs: 1000,
    })
    const event = {
      run: { agent: 'codex', runnerId: 'runner-1' },
      state: 'running',
    }
    reporter.updateRun(event)
    now += 500
    reporter.updateRun(event)
    now += 500
    reporter.updateRun(event)
  } finally {
    console.log = originalLog
    Date.now = originalNow
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'codex runner-1: running (check #1)',
    'codex runner-1: running (check #3)',
  ])
})

test('formatSubmittedLocalRunBoxes renders submitted local run details', () => {
  const output = _private.formatSubmittedLocalRunBoxes({
    prompt: { title: 'Review' },
    runs: [
      {
        agent: 'claude',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        status: 'submitted',
        submittedAfterSeconds: 6,
      },
    ],
  })

  assert.match(output, /Claude Review/)
  assert.match(output, /Status: submitted/)
  assert.match(output, /Runner ID: runner-1/)
  assert.match(output, /Session ID: session-1/)
  assert.match(output, /Submitted after: 6s/)
})

test('non-TTY progress reporter aligns agent and state columns', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line) => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = _private.makeStepProgressReporter({
      stepTitle: 'Review',
      total: 3,
      agents: ['claude', 'gemini', 'codex'],
    })
    reporter.updateRun({
      run: { agent: 'claude', runnerId: '6a0e1befb595e97af9a2c165' },
      state: 'running',
      message: 'claude 6a0e1befb595e97af9a2c165: running',
    })
    reporter.updateRun({
      run: { agent: 'gemini', runnerId: '6a0e1bee848af0ba500f3c89' },
      state: 'running',
      message: 'gemini 6a0e1bee848af0ba500f3c89: running',
    })
    reporter.updateRun({
      run: { agent: 'codex', runnerId: '6a0e1bf1c1a717707743f5c5' },
      state: 'running',
      message: 'codex 6a0e1bf1c1a717707743f5c5: running',
    })
    reporter.updateRun({
      run: { agent: 'codex', runnerId: '6a0e1bf1c1a717707743f5c5' },
      state: 'done',
      message: 'codex 6a0e1bf1c1a717707743f5c5: done',
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'claude 6a0e1befb595e97af9a2c165: running (check #1)',
    'gemini 6a0e1bee848af0ba500f3c89: running (check #1)',
    'codex  6a0e1bf1c1a717707743f5c5: running (check #1)',
    'codex  6a0e1bf1c1a717707743f5c5: done    (check #2)',
  ])
})

test('non-TTY progress reporter prints usage when a local run completes', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line) => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = _private.makeStepProgressReporter({
      stepTitle: 'Review',
      total: 1,
      agents: ['codex'],
    })
    reporter.updateRun({
      run: {
        agent: 'codex',
        runnerId: 'runner-1',
        status: 'completed',
        usage: {
          totalTokens: 85131,
          stepsCount: 10,
          totalCreditsCost: 18.06858,
        },
      },
      state: 'completed',
      terminal: true,
      terminalSuccess: true,
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'codex runner-1: completed (check #1)\n**Usage:** 18.07 credits · 10 steps · 85,131 tokens',
  ])
})

test('agentStepCompletionSummary formats aligned duration and usage rows', () => {
  const summary = _private.agentStepCompletionSummary({
    stepTitle: 'Review',
    runs: [
      {
        agent: 'claude',
        status: 'completed',
        usage: { totalCreditsCost: 46.66, stepsCount: 14, totalTokens: 1014414 },
        rawResult: {
          latestSession: {
            created_at: '2026-05-20T20:00:00.000Z',
            updated_at: '2026-05-20T20:07:46.000Z',
          },
        },
      },
      {
        agent: 'gemini',
        status: 'completed',
        usage: { totalCreditsCost: 117.28, stepsCount: 40, totalTokens: 1363374 },
        rawResult: {
          latestSession: {
            created_at: '2026-05-20T20:00:13.000Z',
            updated_at: '2026-05-20T20:12:30.000Z',
          },
        },
      },
      {
        agent: 'codex',
        status: 'completed',
        usage: { totalCreditsCost: 120.52, stepsCount: 40, totalTokens: 501436 },
        rawResult: {
          latestSession: {
            created_at: '2026-05-20T20:00:10.000Z',
            updated_at: '2026-05-20T20:12:30.000Z',
          },
        },
      },
    ],
  })

  assert.equal(summary, [
    'Review: 3/3 complete - 12min 30s',
    'Claude:  complete  7min 46s    46.66 credits  14 steps  1,014,414 tokens',
    'Gemini:  complete  12min 17s  117.28 credits  40 steps  1,363,374 tokens',
    'Codex:   complete  12min 20s  120.52 credits  40 steps    501,436 tokens',
    'Total:   284.46 credits  94 steps  2,879,224 tokens',
  ].join('\n'))
})

test('isAdHocRunTarget recognizes one-off agent run aliases', () => {
  assert.equal(_private.isAdHocRunTarget('ad-hoc'), true)
  assert.equal(_private.isAdHocRunTarget('adhoc'), true)
  assert.equal(_private.isAdHocRunTarget('agent-run'), true)
  assert.equal(_private.isAdHocRunTarget('review'), false)
})

test('orderSingleRunTransports puts Netlify API first', () => {
  const ordered = _private.orderSingleRunTransports([
    { id: 'github', title: 'GitHub Actions' },
    { id: 'netlify-api', title: 'Netlify API' },
  ])
  assert.deepEqual(ordered.map((transport) => transport.id), ['netlify-api', 'github'])
})

test('chooseNetlifyFilterOption auto-selects a single nested filter in non-TTY mode', async () => {
  const projectRoot = tmpRoot()
  const appDir = path.join(projectRoot, 'clients', 'frontend')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '',
  ].join('\n'))
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'docs', 'netlify.toml'), [
    '[build]',
    '  command = "npm run build"',
    '',
  ].join('\n'))
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
  try {
    assert.deepEqual(await _private.chooseNetlifyFilterOption({ projectRoot, options: {} }), {
      filter: 'revenue-engine-frontend',
      netlifyConfig: path.join('clients', 'frontend', 'netlify.toml'),
    })
  } finally {
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
    } else {
      delete process.stdin.isTTY
    }
  }
})

test('chooseNetlifyFilterOption rejects ambiguous configs in non-TTY mode', async () => {
  const projectRoot = tmpRoot()
  for (const [dir, filter] of [['frontend', 'web'], ['docs', 'docs']]) {
    const appDir = path.join(projectRoot, 'clients', dir)
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
      '[build]',
      `  command = "pnpm --filter ${filter} build"`,
      '',
    ].join('\n'))
  }
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
  try {
    await assert.rejects(
      _private.chooseNetlifyFilterOption({ projectRoot, options: {} }),
      /Multiple netlify\.toml files were found/,
    )
  } finally {
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
    } else {
      delete process.stdin.isTTY
    }
  }
})

test('sortNetlifyConfigChoices puts configs with inferred filters first', () => {
  assert.deepEqual(_private.sortNetlifyConfigChoices([
    { source: '_misc/netlify.toml', filter: '' },
    { source: 'clients/frontend/netlify.toml', filter: 'revenue-engine-frontend' },
  ]), [
    { source: 'clients/frontend/netlify.toml', filter: 'revenue-engine-frontend' },
    { source: '_misc/netlify.toml', filter: '' },
  ])
})

test('success box keeps non-TTY links on one line', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  const lines = []
  const longUrl = 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a0e1ce1f8fc93c4132a27de?session=6a0e1ce1f8fc93c4132a27e0'
  console.log = (line = '') => lines.push(String(line))
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 })
  try {
    _private.printSuccessBox({
      flow: { title: 'Do Next' },
      transport: 'netlify-api',
      projectRoot: process.cwd(),
      runState: {
        steps: [
          {
            id: 'synthesize',
            title: 'Synthesize Next Task',
            status: 'completed',
            runs: [
              {
                agent: 'codex',
                status: 'completed',
                runnerId: '6a0e1ce1f8fc93c4132a27de',
                sessionId: '6a0e1ce1f8fc93c4132a27e0',
                links: { sessionUrl: longUrl },
              },
            ],
          },
        ],
      },
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns)
    } else {
      delete process.stdout.columns
    }
  }

  const output = lines.join('\n')
  assert.match(output, /Final agent run:/)
  assert.ok(output.includes(longUrl))
})

test('localRetryCandidates finds failed local runs by step and agent', () => {
  const runState = {
    steps: [
      {
        id: 'ideate',
        runs: [{ agent: 'claude', runnerId: 'runner-1', status: 'completed', resultText: 'done' }],
      },
      {
        id: 'react',
        runs: [
          { agent: 'claude', runnerId: 'runner-2', status: 'failed', resultText: 'argument list too long' },
          { agent: 'gemini', runnerId: 'runner-3', status: 'completed', resultText: 'done' },
        ],
      },
    ],
  }

  const candidates = _private.localRetryCandidates(runState, { stepId: 'react', agent: 'claude' })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].step.id, 'react')
  assert.equal(candidates[0].run.runnerId, 'runner-2')
  assert.equal(candidates[0].runIndex, 0)
})

test('firstRunnableStepIndex finds incomplete saved local step', () => {
  const flow = {
    steps: [
      { id: 'review' },
      { id: 'cross-review' },
      { id: 'synthesize' },
    ],
  }
  const runState = {
    steps: [
      { id: 'review', status: 'completed' },
      { id: 'cross-review', status: 'running' },
    ],
  }

  assert.equal(_private.firstRunnableStepIndex(flow, runState), 1)
})

test('findGithubRunnerFailures extracts failed Netlify status comments', () => {
  const failures = _private.findGithubRunnerFailures([
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      issueUrl: 'https://github.com/example/repo/issues/91',
      comments: [
        {
          url: 'https://github.com/example/repo/issues/91#issuecomment-1',
          body: [
            '### [Netlify Agent Run Status](https://app.netlify.com/projects/example/agent-runs/abc) ❌',
            '',
            'Netlify Agent Run failed.',
            '',
            '**Failure summary:** Agent timed out before completion',
            '',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
      ],
    },
    {
      issueNumber: 92,
      issueTitle: '2026-05-14 Gemini Generate Ideas',
      issueUrl: 'https://github.com/example/repo/issues/92',
      comments: [
        {
          url: 'https://github.com/example/repo/issues/92#issuecomment-1',
          body: [
            '### [Netlify Agent Run Status](https://app.netlify.com/projects/example/agent-runs/def) ✅',
            '',
            'Netlify Agent Run completed.',
            '',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
      ],
    },
  ])

  assert.deepEqual(failures, [
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      url: 'https://github.com/example/repo/issues/91#issuecomment-1',
      summary: 'Agent timed out before completion',
    },
  ])
})

test('resultsScopedToGithubRuns only counts result comments after the submitted prompt comment', () => {
  const scoped = _private.resultsScopedToGithubRuns([
    {
      issueNumber: 91,
      replies: [],
      comments: [
        { url: 'https://x/issues/91#old', body: 'old result\n<!-- netlify-agent-run-result:old:session -->' },
        { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score\n<!-- netlify-workflow-prompt:cross-score:claude:2026-05-14 -->' },
        { url: 'https://x/issues/91#status', body: '### status\n<!-- netlify-agent-run-status -->' },
        { url: 'https://x/issues/91#new', body: 'new result\n<!-- netlify-agent-run-result:new:session -->' },
      ],
    },
  ], [
    { issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' },
  ])

  assert.deepEqual(scoped[0].replies.map((comment) => comment.url), ['https://x/issues/91#new'])
})

test('GitHub result comments marked failed are failures, not completed replies', () => {
  const result = {
    issueNumber: 91,
    issueTitle: '2026-05-14 Claude Generate Ideas',
    comments: [
      { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score' },
      {
        url: 'https://x/issues/91#failed-result',
        body: [
          '### [Run #2 | claude | Agent Run failed](https://app.netlify.com/projects/site/agent-runs/runner) ❌',
          '',
          '**Error excerpt:**',
          '',
          '```text',
          'Encountered a temporary issue — the agent will attempt to continue.',
          '```',
          '',
          '<!-- netlify-agent-run-result:runner:session -->',
        ].join('\n'),
      },
    ],
  }
  const runs = [{ issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' }]

  assert.deepEqual(_private.resultsScopedToGithubRuns([result], runs)[0].replies, [])
  assert.deepEqual(_private.findGithubRunnerFailures([result], runs), [
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      url: 'https://x/issues/91#failed-result',
      summary: 'Agent run failed',
    },
  ])
})

test('findGithubRunnerFailures ignores old failures before the submitted prompt comment', () => {
  const failures = _private.findGithubRunnerFailures([
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      comments: [
        {
          url: 'https://x/issues/91#old-failure',
          body: [
            'Netlify Agent Run failed.',
            '**Failure summary:** old timeout',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
        { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score' },
      ],
    },
  ], [
    { issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' },
  ])

  assert.deepEqual(failures, [])
})

test('waitForGithubStep retries transient loader errors and still completes', async () => {
  const promptUrl = 'https://x/issues/97#prompt'
  const resultUrl = 'https://x/issues/97#result'
  const issue = {
    number: 97,
    title: '2026-05-17 Codex Review',
    url: 'https://x/issues/97',
    comments: [
      { url: promptUrl, body: '@netlify codex review\n<!-- netlify-workflow-prompt:review:codex:2026-05-17 -->' },
      { url: resultUrl, body: 'codex result body\n<!-- netlify-agent-run-result:runner-97:session-97 -->' },
    ],
  }
  let calls = 0
  const terminalResults = []
  const loader = () => {
    calls += 1
    if (calls === 1) {
      throw new Error('HTTP 401: Bad credentials (https://api.github.com/graphql)')
    }
    return issue
  }

  const results = await _private.waitForGithubStep({
    repo: 'example/repo',
    issueNumbers: [97],
    runs: [{ issueNumber: 97, commentUrl: promptUrl, agent: 'codex' }],
    step: { id: 'review', title: 'Review', agents: ['codex'] },
    timeoutMinutes: 1,
    pollMs: 5,
    loader,
    onRunResult(event) {
      terminalResults.push(event)
    },
  })

  assert.equal(calls, 2)
  assert.equal(terminalResults.length, 1)
  assert.equal(terminalResults[0].status, 'completed')
  assert.equal(terminalResults[0].reply.url, resultUrl)
  assert.equal(results.length, 1)
  assert.equal(results[0].issueNumber, 97)
  assert.equal(results[0].replies.length, 1)
  assert.equal(results[0].replies[0].url, resultUrl)
})

test('waitForGithubStep aborts after maxConsecutiveFailures poll errors', async () => {
  const loader = () => {
    throw new Error('HTTP 500: gateway')
  }
  await assert.rejects(
    _private.waitForGithubStep({
      repo: 'example/repo',
      issueNumbers: [42],
      runs: [{ issueNumber: 42, commentUrl: 'https://x/issues/42#prompt', agent: 'claude' }],
      step: { id: 'review', title: 'Review', agents: ['claude'] },
      timeoutMinutes: 1,
      pollMs: 1,
      loader,
      maxConsecutiveFailures: 3,
    }),
    /aborted after 3 consecutive poll failures/,
  )
})

test('withSelectedAgents filters each workflow step and runnableSteps drops empty steps', () => {
  const flow = {
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'synthesize', agents: ['codex'] },
    ],
  }

  assert.deepEqual(_private.flowAgents(flow), ['claude', 'gemini', 'codex'])

  const filtered = _private.withSelectedAgents(flow, ['claude', 'gemini'])
  assert.deepEqual(filtered.steps[0].agents, ['claude', 'gemini'])
  assert.deepEqual(filtered.steps[1].agents, [])
  assert.deepEqual(_private.runnableSteps(filtered, {}).map((step) => step.id), ['review'])
})
