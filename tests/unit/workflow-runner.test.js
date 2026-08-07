const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { runWorkflow, workflowCommand } = require('../../src/workflows/engine/runner')

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '')
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-workflow-runner-'))
}

test('workflowCommand renders the direct runner command shape', () => {
  const command = workflowCommand({
    flowId: 'review',
    projectRoot: '/repo',
    dryRun: true,
    options: {
      transport: 'netlify-api',
      netlifySiteId: 'runner-site',
      filter: 'frontend-app',
      branch: 'main',
      agents: ['codex'],
      stepAgents: {
        review: ['claude', 'codex'],
        synthesize: ['codex'],
      },
    },
  })

  assert.deepEqual(command, [
    'nax',
    'run',
    'review',
    '--project-root',
    '/repo',
    '--force',
    '--transport',
    'netlify-api',
    '--dry',
    '--site-id',
    'runner-site',
    '--filter',
    'frontend-app',
    '--branch',
    'main',
    '--agents',
    'codex',
    '--step-agents',
    'review=claude,codex',
    '--step-agents',
    'synthesize=codex',
  ])
})

test('runWorkflow executes dry-run in-process with structured events and no artifacts', async () => {
  const projectRoot = tmpRoot()
  const events = []
  const result = await runWorkflow({
    flowId: 'review',
    projectRoot,
    dryRun: true,
    options: {
      transport: 'netlify-api',
      branch: 'dry-run-branch',
      agents: ['codex'],
    },
    eventSink: (event) => events.push(event),
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.exitCode, 0)
  assert.equal(result.command[0], 'nax')
  assert.match(result.stdout, /Multi step agent workflow: "Review"/)
  assert.match(result.stdout, /Dry run only/)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false)
  assert.equal(events.some((event) => event.type === 'started'), true)
  assert.equal(events.some((event) => event.type === 'stdout'), true)
  assert.equal(events.some((event) => event.type === 'exited' && event.status === 'completed'), true)
})

test('runWorkflow dry-run preserves the CLI dry-run contract', async () => {
  const cliRoot = tmpRoot()
  const directRoot = tmpRoot()
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js'),
    'run',
    'review',
    '--project-root',
    cliRoot,
    '--dry',
    '--force',
    '--transport',
    'netlify-api',
    '--branch',
    'parity-branch',
    '--agents',
    'codex',
  ], {
    cwd: cliRoot,
    encoding: 'utf8',
  })
  const direct = await runWorkflow({
    flowId: 'review',
    projectRoot: directRoot,
    dryRun: true,
    options: {
      transport: 'netlify-api',
      branch: 'parity-branch',
      agents: ['codex'],
    },
  })

  assert.equal(cli.status, 0, cli.stderr || cli.stdout)
  assert.equal(direct.status, 'completed')
  for (const output of [stripAnsi(cli.stdout), stripAnsi(direct.stdout)]) {
    assert.match(output, /Multi step agent workflow: "Review"/)
    assert.match(output, /Branch: parity-branch/)
    assert.match(output, /Dry run only/)
    assert.match(output, /Codex/)
  }
  assert.equal(fs.existsSync(path.join(cliRoot, '.nax')), false)
  assert.equal(fs.existsSync(path.join(directRoot, '.nax')), false)
})

test('CLI dry-run previews all four multi-instance lineup use cases', () => {
  const cli = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
  const cases = [
    {
      name: 'model bake-off',
      agents: [
        'claude:claude-fable-5:high',
        'claude:claude-opus-5:high',
        'claude:claude-opus-4-8:high',
      ],
      expected: [/Claude · Fable 5 · High/, /Claude · Opus 5 · High/, /4\.8 · High/],
    },
    {
      name: 'effort sweep',
      agents: [
        'claude:claude-opus-5:low',
        'claude:claude-opus-5:medium',
        'claude:claude-opus-5:max',
      ],
      expected: [
        /Claude · Opus 5 · Low/,
        /Claude · Opus 5 · Medium/,
        /5 · High/,
        /Warning: review: Effort "max" is unsupported by "claude-opus-5"/,
      ],
    },
    {
      name: 'flagship council with bare Auto intent',
      agents: ['claude,gemini,codex,opencode'],
      expected: [/Claude · Auto/, /Gemini · Auto/, /Codex · Auto/, /OpenCode · Auto/],
    },
    {
      name: 'combined lineup',
      agents: ['claude:claude-opus-5:high,codex:latest,gemini'],
      expected: [/Claude · Opus 5 · High/, /Codex · GPT 5\.6/, /Gemini ·/],
    },
  ]

  for (const useCase of cases) {
    const projectRoot = tmpRoot()
    const agentArgs = useCase.agents.flatMap((agents) => ['--agents', agents])
    const result = spawnSync(process.execPath, [
      cli,
      'run',
      'review',
      '--project-root',
      projectRoot,
      '--dry',
      '--force',
      '--transport',
      'netlify-api',
      '--branch',
      'arena-preview',
      ...agentArgs,
    ], { cwd: projectRoot, encoding: 'utf8' })
    const output = stripAnsi(result.stdout).replace(/\s+/g, ' ')
    assert.equal(result.status, 0, `${useCase.name}: ${result.stderr || output}`)
    for (const expected of useCase.expected) assert.match(output, expected, useCase.name)
    assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false, useCase.name)
  }
})

test('explicit GitHub transport rejects a pinned workflow instance before dispatch', () => {
  const projectRoot = tmpRoot()
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js'),
    'run',
    'review',
    '--project-root',
    projectRoot,
    '--dry',
    '--force',
    '--transport',
    'github',
    '--agents',
    'claude:claude-opus-5:high',
  ], { cwd: projectRoot, encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Pinned model\/effort or multiple instances per provider require the Netlify API transport/)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false)
})
