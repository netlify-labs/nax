const assert = require('node:assert/strict')
const test = require('node:test')

const { ResourceTemplate } = require('@modelcontextprotocol/server')

const {
  MAX_RESOURCE_TEXT_BYTES,
  parseNaxResourceUri,
  readNaxResource,
  registerNaxResources,
} = require('../../src/mcp/resources')
const {
  followUpOnRunPrompt,
  registerNaxPrompts,
  runRemoteWorkflowPrompt,
} = require('../../src/mcp/prompts')

/**
 * @param {Partial<import('../../src/contracts').NaxControlPlaneClient>} [overrides]
 * @returns {import('../../src/contracts').NaxControlPlaneClient}
 */
function fakeClient(overrides = {}) {
  return /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
    getContext: async () => ({
      runtime: 'local-dashboard',
      scope: { scopeId: 'scope_test', projectId: 'project_test' },
      actor: { actorId: 'actor_test', kind: 'local-session', authenticated: true },
      capabilities: {},
      agentCatalog: { provenance: { source: 'fixture', commit: 'test', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
      target: null,
      currentBranch: 'main',
      branches: ['main'],
    }),
    listWorkflows: async () => ({
      workflows: [{ workflowId: 'workflow_test', title: 'Test workflow', description: 'Fixture', source: 'project', sourceLabel: 'Project', stepCount: 1, agents: ['codex'] }],
      nextCursor: null,
    }),
    getWorkflow: async (workflowId) => ({ workflow: { workflowId, title: 'Test workflow' } }),
    listRuns: async () => ({
      runs: [{ runId: 'run_test', workflowId: 'workflow_test', title: 'Test run', status: 'completed', branch: 'main', createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:01.000Z', agentRuns: [], reviewGates: [], warnings: [] }],
      nextCursor: null,
    }),
    getRun: async (runId, options) => ({ run: { runId, status: 'completed' }, view: options.view }),
    getArtifact: async (runId, artifactId) => ({ runId, artifactId, contentType: 'text/plain', sizeBytes: 3, content: 'ok\n' }),
    ...overrides,
  })
}

test('NAX resource URI parser accepts only scoped opaque entity shapes', () => {
  assert.deepEqual(parseNaxResourceUri('nax://scopes/scope_test/context'), { kind: 'context', scopeId: 'scope_test' })
  assert.deepEqual(parseNaxResourceUri('nax://scopes/scope_test/workflows/workflow%3Aone'), { kind: 'workflow', scopeId: 'scope_test', workflowId: 'workflow:one' })
  assert.deepEqual(parseNaxResourceUri('nax://scopes/scope_test/runs/run_test/events?since=cursor_2'), { kind: 'events', scopeId: 'scope_test', runId: 'run_test', since: 'cursor_2' })
  assert.deepEqual(parseNaxResourceUri('nax://scopes/scope_test/runs/run_test/artifacts/workflow-summary%3Asummary.md'), {
    kind: 'artifact', scopeId: 'scope_test', runId: 'run_test', artifactId: 'workflow-summary:summary.md',
  })

  for (const uri of [
    'file:///tmp/secret',
    'nax://scopes/scope_test/context?extra=1',
    'nax://scopes/scope_test/runs/run_test/events?since=one&since=two',
    'nax://scopes/scope_test/runs/run_test/events?limit=20',
    'nax://scopes/scope_test/runs/run_test/artifacts/%2E%2E%2Fsecret',
    'nax://scopes/scope_test/runs/run_test#fragment',
  ]) assert.throws(() => parseNaxResourceUri(uri))
})

test('NAX resource reads bind scope and map every resource through the control-plane client', async () => {
  /** @type {Array<{ operation: string, value: unknown }>} */
  const calls = []
  const client = fakeClient({
    getWorkflow: async (workflowId, options) => {
      calls.push({ operation: 'workflow', value: { workflowId, options } })
      return /** @type {never} */ ({ workflow: { workflowId } })
    },
    getRun: async (runId, options) => {
      calls.push({ operation: 'run', value: { runId, options } })
      return /** @type {never} */ ({ run: { runId }, view: options.view })
    },
    getArtifact: async (runId, artifactId) => {
      calls.push({ operation: 'artifact', value: { runId, artifactId } })
      return { runId, artifactId, contentType: 'image/png', sizeBytes: 3, content: Uint8Array.from([1, 2, 3]) }
    },
  })

  const context = await readNaxResource(client, new URL('nax://scopes/scope_test/context'))
  assert.match(context.contents[0].text || '', /"scopeId": "scope_test"/)
  await readNaxResource(client, new URL('nax://scopes/scope_test/workflows/workflow_test'))
  await readNaxResource(client, new URL('nax://scopes/scope_test/runs/run_test'))
  await readNaxResource(client, new URL('nax://scopes/scope_test/runs/run_test/details'))
  await readNaxResource(client, new URL('nax://scopes/scope_test/runs/run_test/events?since=cursor_2'))
  const artifact = await readNaxResource(client, new URL('nax://scopes/scope_test/runs/run_test/artifacts/artifact_test'))
  assert.equal(artifact.contents[0].blob, 'AQID')
  assert.deepEqual(calls, [
    { operation: 'workflow', value: { workflowId: 'workflow_test', options: { includeGraph: true } } },
    { operation: 'run', value: { runId: 'run_test', options: { view: 'summary' } } },
    { operation: 'run', value: { runId: 'run_test', options: { view: 'details' } } },
    { operation: 'run', value: { runId: 'run_test', options: { view: 'events', since: 'cursor_2', limit: 200 } } },
    { operation: 'artifact', value: { runId: 'run_test', artifactId: 'artifact_test' } },
  ])
  await assert.rejects(readNaxResource(client, new URL('nax://scopes/scope_other/context')), { code: 'scope_forbidden' })
})

test('NAX resource reads bound oversized text, binary, and storage rejection metadata', async () => {
  const huge = 'x'.repeat(MAX_RESOURCE_TEXT_BYTES + 1)
  const text = await readNaxResource(fakeClient({
    getArtifact: async (runId, artifactId) => ({ runId, artifactId, contentType: 'text/plain', sizeBytes: huge.length, content: huge }),
  }), new URL('nax://scopes/scope_test/runs/run_test/artifacts/artifact_text'))
  assert.equal(JSON.parse(text.contents[0].text || '{}').truncated, true)

  const binary = await readNaxResource(fakeClient({
    getArtifact: async (runId, artifactId) => ({ runId, artifactId, contentType: 'application/octet-stream', sizeBytes: huge.length, content: new Uint8Array(MAX_RESOURCE_TEXT_BYTES + 1) }),
  }), new URL('nax://scopes/scope_test/runs/run_test/artifacts/artifact_binary'))
  assert.equal(JSON.parse(binary.contents[0].text || '{}').truncated, true)

  const rejected = await readNaxResource(fakeClient({
    getArtifact: async () => { throw Object.assign(new Error('Too large.'), { code: 'artifact_too_large', details: { maxBytes: 10 } }) },
  }), new URL('nax://scopes/scope_test/runs/run_test/artifacts/artifact_large'))
  assert.equal(JSON.parse(rejected.contents[0].text || '{}').error.code, 'artifact_too_large')
})

test('NAX textual resources and prompts redact credential-shaped values', async () => {
  const resource = await readNaxResource(fakeClient({
    getArtifact: async (runId, artifactId) => ({ runId, artifactId, contentType: 'text/plain', sizeBytes: 30, content: 'Bearer resource-secret-value' }),
  }), new URL('nax://scopes/scope_test/runs/run_test/artifacts/artifact_secret'))
  assert.equal(resource.contents[0].text, '[redacted]')
  const prompt = runRemoteWorkflowPrompt({ objective: 'Inspect Bearer prompt-secret-value' })
  assert.doesNotMatch(prompt.messages[0].content.text, /prompt-secret-value/)
})

test('NAX resource templates enumerate stable scoped workflows and runs', async () => {
  /** @type {Array<{ name: string, template: ResourceTemplate, read: (uri: URL) => Promise<unknown> }>} */
  const resources = []
  const server = /** @type {import('@modelcontextprotocol/server').McpServer} */ ({
    registerResource(name, template, _config, read) {
      resources.push({ name, template, read })
      return {}
    },
  })
  registerNaxResources({ server, client: fakeClient() })
  assert.deepEqual(resources.map((resource) => resource.name), [
    'nax-context', 'nax-workflow', 'nax-run', 'nax-run-details', 'nax-run-events', 'nax-run-artifact',
  ])
  assert.equal(resources.every((resource) => resource.template instanceof ResourceTemplate), true)
  assert.equal(resources[5].template.listCallback, undefined)
  const workflows = await resources[1].template.listCallback?.(/** @type {never} */ ({}))
  assert.equal(workflows?.resources[0].uri, 'nax://scopes/scope_test/workflows/workflow_test')
  const runs = await resources[2].template.listCallback?.(/** @type {never} */ ({}))
  assert.equal(runs?.resources[0].uri, 'nax://scopes/scope_test/runs/run_test')
  assert.equal(resources[4].template.uriTemplate.toString(), 'nax://scopes/{scope_id}/runs/{run_id}/events{?since}')
})

test('resource reads route by URI scope through the shared multi-project resolver', async () => {
  /** @type {Array<{ read: (uri: URL) => Promise<{ contents: Array<{ text?: string }> }> }>} */
  const resources = []
  const server = /** @type {import('@modelcontextprotocol/server').McpServer} */ ({
    registerResource(_name, _template, _config, read) {
      resources.push({ read: /** @type {(uri: URL) => Promise<{ contents: Array<{ text?: string }> }>} */ (read) })
      return {}
    },
  })
  const selectedClient = fakeClient({
    getContext: async () => /** @type {import('../../src/contracts').ControlPlaneContext} */ ({
      runtime: 'local-dashboard',
      scope: { scopeId: 'scope_other', projectId: 'project_other' },
      actor: { actorId: 'actor_other', kind: 'local-session', authenticated: true },
      capabilities: {},
      agentCatalog: { provenance: { source: 'fixture', commit: 'test', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
      target: null,
      currentBranch: 'main',
      branches: ['main'],
    }),
  })
  /** @type {string[]} */
  const selections = []
  registerNaxResources({
    server,
    resolveClient: async ({ scopeId = '' } = {}) => {
      selections.push(scopeId)
      return { client: selectedClient, context: await selectedClient.getContext(), projectRoot: '/other' }
    },
  })

  const result = await resources[0].read(new URL('nax://scopes/scope_other/context'))
  assert.deepEqual(selections, ['scope_other'])
  assert.match(result.contents[0].text || '', /"projectId": "project_other"/)
})

test('NAX prompts register safe canonical entity-first workflows', async () => {
  /** @type {Array<{ name: string, config: Record<string, unknown>, callback: (args: Record<string, string>) => { messages: Array<{ content: { text: string } }> } }>} */
  const prompts = []
  const server = /** @type {import('@modelcontextprotocol/server').McpServer} */ ({
    registerPrompt(name, config, callback) {
      prompts.push({ name, config, callback })
      return {}
    },
  })
  registerNaxPrompts({ server })
  assert.deepEqual(prompts.map((prompt) => prompt.name), ['run_remote_workflow', 'follow_up_on_run'])

  const workflowText = runRemoteWorkflowPrompt({ project_ref: '/workspace/other', workflow_id: 'workflow_test', objective: 'Review auth.' }).messages[0].content.text
  assert.match(workflowText, /context_get/)
  assert.match(workflowText, /workflow_plan/)
  assert.match(workflowText, /run_start/)
  assert.match(workflowText, /run_wait/)
  assert.match(workflowText, /summary or successful submission is not proof/i)
  assert.match(workflowText, /bounded/)
  assert.match(workflowText, /scope_id/)
  assert.match(workflowText, /\/workspace\/other/)

  const followupText = followUpOnRunPrompt({ run_id: 'run_test', agent_run_id: 'agent_run_test' }).messages[0].content.text
  assert.match(followupText, /agent_run_followup/)
  assert.match(followupText, /exact (?:source result|run_id, agent_run_id)/)
  assert.match(followupText, /artifact_ids owned by this run/)

  const followupSchema = /** @type {{ argsSchema: import('zod').ZodType }} */ (prompts[1].config).argsSchema
  assert.equal(followupSchema.safeParse({ run_id: 'YOUR_RUN_ID' }).success, false)
})
