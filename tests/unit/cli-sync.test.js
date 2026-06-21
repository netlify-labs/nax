const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { persistAgentRunnerArtifact } = require('../../src/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../../src/agent-session-artifacts')
const { handleSync } = require('../../src/cli/sync')

/**
 * Recorded command invocation for sync adapter tests.
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   options?: import('child_process').SpawnSyncOptionsWithStringEncoding | import('../../src/types').JsonMap,
 * }} SyncCall
 */

/** @returns {string} */
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-cli-sync-'))
}

/**
 * Writes a JSON file with parent directories.
 * @param {string} filePath
 * @param {unknown} value
 * @returns {void}
 */
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Writes a minimal NAX artifact tree matching GitHub Actions download output.
 * @param {string} root
 * @returns {void}
 */
function writeActionsArtifactTree(root) {
  writeJson(path.join(root, 'workflows', 'run-1', 'workflow.json'), {
    schemaVersion: 1,
    runId: 'run-1',
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'netlify-api',
    projectRoot: '/remote/repo',
    dir: '/remote/repo/.nax/workflows/run-1',
    status: 'completed',
    createdAt: '2026-06-06T17:00:00.000Z',
    updatedAt: '2026-06-06T17:10:00.000Z',
    steps: [],
  })
}

/**
 * Creates a fake GitHub command runner that materializes a NAX artifact.
 * @param {SyncCall[]} calls
 * @returns {import('../../src/cli/sync').SyncRunCommand}
 */
function fakeGithubRunner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
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
      writeActionsArtifactTree(dir)
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` }
  }
}

test('handleSync syncs the latest Netlify Agent Runner artifact', () => {
  const projectRoot = tmpRoot()
  const logs = []
  const calls = []
  const first = persistAgentSessionArtifact({
    projectRoot,
    runnerId: 'runner-1',
    agent: 'codex',
    sessionId: 'session-1',
    status: 'completed',
    resultText: 'Initial result',
    createdAt: '2026-05-29T01:00:00.000Z',
    updatedAt: '2026-05-29T01:01:00.000Z',
  })
  persistAgentRunnerArtifact({
    projectRoot,
    runnerId: 'runner-1',
    agent: 'codex',
    status: 'completed',
    session: first.session,
    links: { agentRunUrl: 'https://app.netlify.com/projects/www/agent-runs/runner-1' },
    createdAt: '2026-05-29T01:00:00.000Z',
    updatedAt: '2026-05-29T01:01:00.000Z',
  })

  const result = handleSync('last', { projectRoot }, {
    env: {
      NETLIFY_SITE_ID: 'site-1',
      NETLIFY_AUTH_TOKEN: 'token-1',
    },
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return {
        status: 0,
        stdout: JSON.stringify({
          sessions: [{
            id: 'session-1',
            state: 'completed',
            result: 'Initial result',
            created_at: '2026-05-29T01:00:00.000Z',
            updated_at: '2026-05-29T01:01:00.000Z',
          }],
        }),
        stderr: '',
      }
    },
    log(message) {
      logs.push(message)
    },
  })

  assert.equal(result.runnerId, 'runner-1')
  assert.match(logs[0], /Synced Agent Runner runner-1/)
  assert.deepEqual(calls[0].args, [
    'api',
    'listAgentRunnerSessions',
    '--data',
    '{"agent_runner_id":"runner-1"}',
  ])
})

test('handleSync syncs numeric GitHub Actions run ids', () => {
  const projectRoot = tmpRoot()
  const calls = []
  const logs = []
  const result = handleSync('27068396571', {
    projectRoot,
    repo: 'netlify-labs/revenue-engine',
  }, {
    runCommand: fakeGithubRunner(calls),
    log(message) {
      logs.push(message)
    },
  })

  assert.equal(result.runId, '27068396571')
  assert.equal(result.artifactName, 'nax-review-27068396571')
  assert.match(logs[0], /Synced GitHub Actions run 27068396571/)
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'repos/netlify-labs/revenue-engine/actions/runs/27068396571/artifacts'])
})

test('handleSync syncs GitHub Actions run URLs and uses the URL repo', () => {
  const projectRoot = tmpRoot()
  const calls = []
  const result = handleSync('https://github.com/netlify-labs/revenue-engine/actions/runs/27068396571', {
    projectRoot,
  }, {
    runCommand: fakeGithubRunner(calls),
    log() {},
  })

  assert.equal(result.repo, 'netlify-labs/revenue-engine')
  assert.equal(calls[0].args[1], 'repos/netlify-labs/revenue-engine/actions/runs/27068396571/artifacts')
})

test('handleSync rejects unsupported targets', () => {
  assert.throws(
    () => handleSync('remote', { projectRoot: tmpRoot() }, { log() {} }),
    /Expected `nax sync last`/,
  )
})
