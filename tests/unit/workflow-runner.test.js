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
      branch: 'main',
      models: ['codex'],
      stepModels: {
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
    '--branch',
    'main',
    '--models',
    'codex',
    '--step-models',
    'review=claude,codex',
    '--step-models',
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
      models: ['codex'],
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
    path.join(__dirname, '..', '..', 'bin', 'nax.js'),
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
    '--models',
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
      models: ['codex'],
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
