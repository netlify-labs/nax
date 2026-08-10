const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MAX_CANARY_CREDITS,
  assertCanaryContext,
  assertCanaryPlan,
  assertCanaryRepository,
  assertCanaryUsage,
  canaryDiagnostic,
  loadMcpCanaryConfig,
  repositoryFromRemote,
} = require('../../src/mcp/canary')

/** @returns {NodeJS.ProcessEnv} */
function validEnv() {
  return {
    NAX_MCP_CANARY: '1',
    NAX_MCP_CANARY_PROJECT_ROOT: '/canary/project',
    NAX_MCP_CANARY_REPOSITORY: 'netlify-labs/nax-canary',
    NAX_MCP_CANARY_SITE_ID: 'site_canary_01',
    NAX_MCP_CANARY_ACCOUNT_SLUG: 'team-canary',
    NAX_MCP_CANARY_BRANCH: 'canary/mcp',
    NAX_MCP_CANARY_AGENT: 'codex',
    NAX_MCP_CANARY_REQUEST_ID: 'request_canary_01',
    NAX_MCP_CANARY_MAX_RUNNERS: '1',
    NAX_MCP_CANARY_MAX_CREDITS: '25',
    NAX_MCP_CANARY_TIMEOUT_MS: '900000',
  }
}

test('real MCP canary guard requires every explicit mutation and budget input', () => {
  const env = validEnv()
  const config = loadMcpCanaryConfig(env, { canonicalize: (value) => `canonical:${value}` })
  assert.deepEqual(config, {
    projectRoot: 'canonical:/canary/project',
    repository: 'netlify-labs/nax-canary',
    siteId: 'site_canary_01',
    accountSlug: 'team-canary',
    branch: 'canary/mcp',
    agent: 'codex',
    requestId: 'request_canary_01',
    maxRunners: 1,
    maxCredits: 25,
    timeoutMs: 900000,
  })

  for (const name of Object.keys(env)) {
    const missing = { ...env }
    delete missing[name]
    assert.throws(() => loadMcpCanaryConfig(missing), new RegExp(name === 'NAX_MCP_CANARY' ? 'NAX_MCP_CANARY=1' : name))
  }
})

test('real MCP canary guard refuses multiple runners, broad credits, time, and unsafe targets', () => {
  const base = validEnv()
  for (const [name, value] of [
    ['NAX_MCP_CANARY_MAX_RUNNERS', '2'],
    ['NAX_MCP_CANARY_MAX_CREDITS', String(MAX_CANARY_CREDITS + 1)],
    ['NAX_MCP_CANARY_TIMEOUT_MS', '99999999'],
    ['NAX_MCP_CANARY_REPOSITORY', 'all'],
    ['NAX_MCP_CANARY_BRANCH', '../main'],
    ['NAX_MCP_CANARY_REQUEST_ID', '*'],
  ]) {
    assert.throws(() => loadMcpCanaryConfig({ ...base, [name]: value }), new RegExp(name))
  }
})

test('repository guard accepts common GitHub remotes and rejects a different repository', () => {
  const config = loadMcpCanaryConfig(validEnv())
  assert.equal(repositoryFromRemote('git@github.com:netlify-labs/nax-canary.git'), 'netlify-labs/nax-canary')
  assert.equal(repositoryFromRemote('https://github.com/netlify-labs/nax-canary.git'), 'netlify-labs/nax-canary')
  assert.equal(repositoryFromRemote('https://example.test/netlify-labs/nax-canary.git'), '')
  assert.doesNotThrow(() => assertCanaryRepository(config, 'git@github.com:netlify-labs/nax-canary.git'))
  assert.throws(() => assertCanaryRepository(config, 'git@github.com:other/project.git'), /does not match/)
})

test('context, plan, and terminal usage guards fail closed before or after the bounded run', () => {
  const config = loadMcpCanaryConfig(validEnv())
  const capability = { available: true }
  const context = {
    runtime: 'local-dashboard',
    target: { siteId: config.siteId, accountSlug: config.accountSlug },
    capabilities: {
      agent_run_plan: capability,
      run_start: capability,
      run_wait: capability,
      run_get: capability,
      resource_read: capability,
    },
  }
  assert.doesNotThrow(() => assertCanaryContext(config, context))
  assert.throws(() => assertCanaryContext(config, { ...context, target: { siteId: 'site_wrong' } }), /allowed site/)
  assert.throws(() => assertCanaryContext(config, { ...context, capabilities: { ...context.capabilities, run_start: { available: false } } }), /run_start/)

  const plan = {
    planId: 'plan_canary_01',
    kind: 'agent-run',
    expectedAgentRuns: 1,
    target: { siteId: config.siteId, accountSlug: config.accountSlug, branch: config.branch },
  }
  assert.doesNotThrow(() => assertCanaryPlan(config, plan))
  assert.throws(() => assertCanaryPlan(config, { ...plan, expectedAgentRuns: 2 }), /exactly 1/)
  assert.throws(() => assertCanaryPlan(config, { ...plan, target: { ...plan.target, branch: 'main' } }), /allowed branch/)

  assert.equal(assertCanaryUsage(config, { usageTotals: { totalCreditsCost: 12.5 } }), 12.5)
  assert.throws(() => assertCanaryUsage(config, { usageTotals: { totalCreditsCost: 26 } }), /above the asserted/)
  assert.throws(() => assertCanaryUsage(config, {}), /did not report/)
})

test('canary diagnostics allow only value-free fields and redact credentials', () => {
  const diagnostic = canaryDiagnostic('failed', {
    elapsedMs: 50,
    runId: 'run_canary_01',
    error: 'Authorization: Bearer secret-token-value-123456789 failed',
  })
  assert.match(String(diagnostic.error), /Authorization: \[redacted\] failed/)
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-token-value/)
  assert.throws(() => canaryDiagnostic('unsafe', { prompt: 'do something' }), /Unsupported canary diagnostic field prompt/)
  assert.throws(() => canaryDiagnostic('unsafe', { artifactContent: 'result' }), /Unsupported canary diagnostic field artifactContent/)
})

test('canary executable exits before creating state when explicit opt-in is absent', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-canary-guard-'))
  const result = spawnSync(process.execPath, ['scripts/run-mcp-agent-canary.mjs'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { PATH: process.env.PATH || '', NAX_MCP_CANARY_PROJECT_ROOT: projectRoot },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /NAX_MCP_CANARY=1/)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false)
})
