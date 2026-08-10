const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  START_DASHBOARD_GUIDANCE,
  formatMcpDoctor,
  runMcpDoctor,
} = require('../../src/mcp/doctor')

/** @param {string} projectRoot */
function writeProjectIdentity(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, '.nax'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, '.nax', 'project.json'), JSON.stringify({ projectId: 'project_doctor_fixture' }))
}

/** @param {string} projectRoot */
function dashboardRecord(projectRoot) {
  return {
    v: 1,
    instanceId: 'instance_doctor_fixture',
    pid: 4242,
    projectId: 'project_doctor_fixture',
    projectRoot,
    origin: 'http://127.0.0.1:54321',
    token: 'private-token-value-that-is-long-enough',
    startedAt: '2026-08-08T12:00:00.000Z',
    version: '2.0.0',
  }
}

/** @returns {import('../../src/contracts').ControlPlaneContext} */
function contextFixture() {
  const capability = { available: true }
  return {
    runtime: 'local-dashboard',
    scope: { scopeId: 'scope_doctor_fixture', projectId: 'project_doctor_fixture', siteId: 'site_1' },
    actor: { actorId: 'actor_doctor_fixture', kind: 'local-session', authenticated: true },
    capabilities: {
      context_get: capability,
      workflow_list: capability,
      workflow_get: capability,
      workflow_plan: capability,
      agent_run_plan: capability,
      run_start: capability,
      run_list: capability,
      run_get: capability,
      run_wait: capability,
      run_cancel: capability,
      agent_run_retry: capability,
      agent_run_followup: capability,
      review_gate_resolve: capability,
      resource_read: capability,
    },
    agentCatalog: { provenance: { source: 'fixture', commit: 'fixture', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
    target: { siteId: 'site_1', siteName: 'demo-site', branch: 'main', verified: true, caveats: [] },
    currentBranch: 'main',
    branches: ['main'],
  }
}

test('doctor reports a fully healthy read-only local MCP path', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-doctor-ok-'))
  writeProjectIdentity(projectRoot)
  const before = fs.readdirSync(path.join(projectRoot, '.nax'))
  const calls = { context: 0, remote: 0 }
  const result = await runMcpDoctor({
    projectRoot,
    executableFinder: (name) => `/tools/${name}`,
    packageResolver: (specifier) => `/package/${specifier}`,
    claudeProbe: () => ({ ok: true, executable: '/tools/claude', message: 'Claude Code CLI supports stdio MCP configuration.' }),
    configInspector: () => [{ scope: 'project', configPath: path.join(projectRoot, '.mcp.json'), configured: true, current: true }],
    registryReader: () => dashboardRecord(projectRoot),
    processAlive: () => true,
    sessionDiscoverer: async () => ({
      record: dashboardRecord(projectRoot),
      health: { netlifyAccess: { ok: true, site: { name: 'demo-site' } } },
    }),
    clientFactory: () => /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
      async getContext() {
        calls.context += 1
        return contextFixture()
      },
      listWorkflows: async () => { calls.remote += 1; throw new Error('unexpected') },
      getWorkflow: async () => { calls.remote += 1; throw new Error('unexpected') },
      createWorkflowPlan: async () => { calls.remote += 1; throw new Error('unexpected') },
      createAgentRunPlan: async () => { calls.remote += 1; throw new Error('unexpected') },
      startPlan: async () => { calls.remote += 1; throw new Error('unexpected') },
      listRuns: async () => { calls.remote += 1; throw new Error('unexpected') },
      getRun: async () => { calls.remote += 1; throw new Error('unexpected') },
      waitForRun: async () => { calls.remote += 1; throw new Error('unexpected') },
      cancelRun: async () => { calls.remote += 1; throw new Error('unexpected') },
      retryAgentRun: async () => { calls.remote += 1; throw new Error('unexpected') },
      submitFollowup: async () => { calls.remote += 1; throw new Error('unexpected') },
      resolveReviewGate: async () => { calls.remote += 1; throw new Error('unexpected') },
      getArtifact: async () => { calls.remote += 1; throw new Error('unexpected') },
    }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.totals.fail, 0)
  assert.equal(calls.context, 1)
  assert.equal(calls.remote, 0)
  assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.nax')), before)
  assert.match(formatMcpDoctor(result), /\[PASS\] context_get smoke/)
  assert.match(formatMcpDoctor(result), /0 failed/)
})

test('doctor gives exact startup guidance for a missing dashboard without creating identity or registry state', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-doctor-missing-'))
  let sessionCalls = 0
  let clientCalls = 0
  const result = await runMcpDoctor({
    projectRoot,
    executableFinder: () => '',
    packageResolver: (specifier) => `/package/${specifier}`,
    claudeProbe: () => ({ ok: false, executable: '', message: 'Claude Code CLI was not found on PATH.' }),
    configInspector: () => [],
    registryReader: () => null,
    sessionDiscoverer: async () => { sessionCalls += 1; throw new Error('must not run') },
    clientFactory: () => { clientCalls += 1; throw new Error('must not run') },
  })

  assert.equal(result.ok, false)
  assert.equal(sessionCalls, 0)
  assert.equal(clientCalls, 0)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false)
  const output = formatMcpDoctor(result)
  assert.match(output, new RegExp(START_DASHBOARD_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('doctor redacts health failures and does not continue to context or remote operations', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-doctor-bad-health-'))
  writeProjectIdentity(projectRoot)
  let clientCalls = 0
  const result = await runMcpDoctor({
    projectRoot,
    executableFinder: (name) => `/tools/${name}`,
    packageResolver: (specifier) => `/package/${specifier}`,
    claudeProbe: () => ({ ok: true, executable: '/tools/claude', message: 'supported' }),
    configInspector: () => [{ scope: 'project', configPath: '.mcp.json', configured: true, current: true }],
    registryReader: () => dashboardRecord(projectRoot),
    processAlive: () => true,
    sessionDiscoverer: async () => {
      throw new Error('Authorization: Bearer secret-token-value-123456789 failed version check')
    },
    clientFactory: () => { clientCalls += 1; throw new Error('must not run') },
  })

  const output = formatMcpDoctor(result)
  assert.equal(result.ok, false)
  assert.equal(clientCalls, 0)
  assert.match(output, /Authorization: \[redacted\] failed version check/)
  assert.doesNotMatch(output, /secret-token-value/)
})

test('doctor reports inaccessible selected Netlify targets and unavailable capabilities', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-doctor-target-'))
  writeProjectIdentity(projectRoot)
  const context = contextFixture()
  context.capabilities.run_start = { available: false, reason: 'disabled' }
  const result = await runMcpDoctor({
    projectRoot,
    executableFinder: (name) => `/tools/${name}`,
    packageResolver: (specifier) => `/package/${specifier}`,
    claudeProbe: () => ({ ok: true, executable: '/tools/claude', message: 'supported' }),
    configInspector: () => [{ scope: 'project', configPath: '.mcp.json', configured: true, current: true }],
    registryReader: () => dashboardRecord(projectRoot),
    processAlive: () => true,
    sessionDiscoverer: async () => ({
      record: dashboardRecord(projectRoot),
      health: { netlifyAccess: { ok: false, message: 'The selected site is not accessible.' } },
    }),
    clientFactory: () => /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({ getContext: async () => context }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.checks.find((check) => check.id === 'netlify_target')?.status, 'fail')
  assert.equal(result.checks.find((check) => check.id === 'capabilities')?.status, 'warn')
})
