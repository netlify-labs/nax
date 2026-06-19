const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { readHandoffSource } = require('../../src/handoff-sources')
const {
  materializeNaxArtifactTree,
  parseGithubActionsRunTarget,
  selectNaxArtifact,
  syncGithubActionsRun,
} = require('../../src/github-actions-sync')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-github-actions-sync-'))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeArtifactTree(root, remoteRoot = '/home/runner/work/repo/repo') {
  writeJson(path.join(root, 'workflows', 'run-1', 'workflow.json'), {
    schemaVersion: 1,
    runId: 'run-1',
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'netlify-api',
    projectRoot: remoteRoot,
    dir: path.join(remoteRoot, '.nax', 'workflows', 'run-1'),
    createdAt: '2026-06-06T17:00:00.000Z',
    updatedAt: '2026-06-06T17:10:00.000Z',
    status: 'completed',
    steps: [{
      id: 'synthesize',
      title: 'Summarize Consensus',
      status: 'completed',
      runs: [{
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        resultText: 'Final consensus',
        usage: { totalCreditsCost: 1, stepsCount: 2, totalTokens: 300 },
      }],
    }],
  })
  writeJson(path.join(root, 'workflows', 'latest', 'workflow.json'), {
    runId: 'remote-latest-copy',
    status: 'completed',
  })
  writeJson(path.join(root, 'agent-sessions', 'session-1', 'agent-session.json'), {
    schemaVersion: 1,
    sessionId: 'session-1',
    runnerId: 'runner-1',
    agent: 'codex',
    status: 'completed',
    createdAt: '2026-06-06T17:00:00.000Z',
    updatedAt: '2026-06-06T17:10:00.000Z',
    usage: { totalCreditsCost: 1, stepsCount: 2, totalTokens: 300 },
    links: { agentRunUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1' },
    resultText: 'Final consensus',
  })
  writeJson(path.join(root, 'agent-runners', 'runner-1', 'agent-runner.json'), {
    schemaVersion: 1,
    runnerId: 'runner-1',
    agent: 'codex',
    status: 'completed',
    createdAt: '2026-06-06T17:00:00.000Z',
    updatedAt: '2026-06-06T17:10:00.000Z',
    latestSessionId: 'session-1',
    sessionIds: ['session-1'],
    usage: { totalCreditsCost: 1, stepsCount: 2, totalTokens: 300 },
    links: { agentRunUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1' },
  })
}

test('parseGithubActionsRunTarget supports URLs and numeric run IDs', () => {
  assert.deepEqual(
    parseGithubActionsRunTarget('https://github.com/netlify-labs/revenue-engine/actions/runs/27068396571/job/79893154784'),
    { repo: 'netlify-labs/revenue-engine', runId: '27068396571' },
  )
  assert.deepEqual(parseGithubActionsRunTarget('27068396571'), { repo: '', runId: '27068396571' })
  assert.equal(parseGithubActionsRunTarget('last'), null)
})

test('selectNaxArtifact chooses the run-specific artifact', () => {
  const artifact = selectNaxArtifact([
    { name: 'nax-review-111', created_at: '2026-06-06T17:00:00Z' },
    { name: 'nax-review-222', created_at: '2026-06-06T18:00:00Z' },
    { name: 'logs', created_at: '2026-06-06T19:00:00Z' },
  ], { runId: '111' })

  assert.equal(artifact.name, 'nax-review-111')
})

test('materializeNaxArtifactTree merges remote Actions artifact into local .nax', () => {
  const projectRoot = tmpRoot()
  const artifactRoot = tmpRoot()
  writeArtifactTree(artifactRoot)

  const result = materializeNaxArtifactTree({ projectRoot, artifactDir: artifactRoot })

  assert.equal(result.workflowCount, 1)
  assert.equal(result.runnerCount, 1)
  assert.equal(result.sessionCount, 1)
  assert.equal(result.latestWorkflowId, 'run-1')

  const workflow = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nax', 'workflows', 'run-1', 'workflow.json'), 'utf8'))
  assert.equal(workflow.projectRoot, projectRoot)
  assert.equal(workflow.dir, path.join(projectRoot, '.nax', 'workflows', 'run-1'))
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax', 'workflows', 'remote-latest-copy')), false)

  const handoff = readHandoffSource(projectRoot, { kind: 'workflow', id: 'run-1' })
  assert.equal(handoff.displayPath, '.nax/workflows/run-1/artifacts/summary.md')
  assert.match(handoff.summaryText, /Final consensus/)
})

test('syncGithubActionsRun downloads selected artifact and materializes it', () => {
  const projectRoot = tmpRoot()
  const calls = []
  const result = syncGithubActionsRun({
    projectRoot,
    repo: 'netlify-labs/revenue-engine',
    runId: '27068396571',
    runCommand(command, args) {
      calls.push([command, ...args])
      if (args[0] === 'api') {
        return {
          status: 0,
          stdout: JSON.stringify({
            artifacts: [{
              name: 'nax-review-27068396571',
              expired: false,
              size_in_bytes: 1234,
              created_at: '2026-06-06T17:00:00Z',
            }],
          }),
          stderr: '',
        }
      }
      if (args[0] === 'run' && args[1] === 'download') {
        const dir = args[args.indexOf('--dir') + 1]
        writeArtifactTree(dir)
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' }
    },
  })

  assert.equal(result.artifactName, 'nax-review-27068396571')
  assert.equal(result.workflowCount, 1)
  assert.deepEqual(calls[0].slice(0, 3), ['gh', 'api', 'repos/netlify-labs/revenue-engine/actions/runs/27068396571/artifacts'])
  assert.deepEqual(calls[1].slice(0, 5), ['gh', 'run', 'download', '27068396571', '--repo'])
})
