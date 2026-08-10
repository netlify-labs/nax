const assert = require('node:assert/strict')
const test = require('node:test')
const { z } = require('zod/v4')

const {
  MAX_CONTEXT_BYTES,
  MAX_PROMPT_BYTES,
  TOOL_INPUT_SCHEMAS,
  TOOL_SPECS,
  toolResultOutputSchema,
} = require('../../src/mcp/schemas')
const {
  MAX_STRUCTURED_BYTES,
  MAX_TEXT_BYTES,
  boundStructuredData,
  jsonBytes,
  successResult,
} = require('../../src/mcp/results')
const {
  closestCandidates,
  errorResult,
  normalizeMcpError,
  shellQuote,
} = require('../../src/mcp/errors')
const { redactSecretText } = require('../../src/mcp/security')

const VALID_INPUTS = Object.freeze({
  context_get: {},
  workflow_list: { source: 'project', limit: 20, cursor: 'cursor_abc' },
  workflow_get: { workflow_id: 'security-review', include_graph: true },
  workflow_plan: {
    workflow_id: 'security-review',
    branch: 'feature/mcp',
    instances: [{ agent: 'opencode', model: 'moonshotai/kimi-k3', effort: 'high', label: 'reviewer' }],
    step_instances: { analyze: [{ agent: 'claude', model: 'claude-opus-5', effort: 'high' }] },
    context: 'Focus on authorization.',
    only_step: 'analyze',
  },
  agent_run_plan: { prompt: 'Audit the authorization boundary.', instance: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }, branch: 'main' },
  run_start: { plan_id: 'plan_01JABCDEFG', request_id: 'request_01JABCDEFG' },
  run_list: { status: 'running', workflow_id: 'security-review', limit: 25, cursor: 'cursor_abc' },
  run_get: { run_id: 'run_01JABCDEFG', view: 'events', since: 12, limit: 100 },
  run_wait: { run_id: 'run_01JABCDEFG', since: '12', timeout_ms: 30000 },
  run_cancel: { run_id: 'run_01JABCDEFG', agent_run_id: 'agent_run_01JABCDEFG', reason: 'Superseded' },
  agent_run_retry: { run_id: 'run_01JABCDEFG', agent_run_id: 'agent_run_01JABCDEFG', request_id: 'request_retry_01J' },
  agent_run_followup: {
    run_id: 'run_01JABCDEFG',
    agent_run_id: 'agent_run_01JABCDEFG',
    request_id: 'request_followup_01J',
    prompt: 'Verify the proposed fix.',
    mode: 'follow-up-thread',
    artifact_ids: ['artifact_summary'],
    instances: [{ agent: 'claude', model: 'claude-opus-5', effort: 'high' }],
  },
  review_gate_resolve: { run_id: 'run_01JABCDEFG', review_gate_id: 'review_gate_01JABCDEFG', decision: 'approve', reason: 'Looks correct' },
})

test('all 13 entity-first tool schemas accept their precise valid contract', () => {
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS), [
    'context_get',
    'workflow_list',
    'workflow_get',
    'workflow_plan',
    'agent_run_plan',
    'run_start',
    'run_list',
    'run_get',
    'run_wait',
    'run_cancel',
    'agent_run_retry',
    'agent_run_followup',
    'review_gate_resolve',
  ])
  for (const [name, input] of Object.entries(VALID_INPUTS)) {
    const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(input)
    assert.equal(parsed.success, true, `${name}: ${parsed.success ? '' : z.prettifyError(parsed.error)}`)
  }
  assert.equal(TOOL_SPECS.run_get.inputSchema.parse(VALID_INPUTS.run_get).since, 12)
})

test('tool schemas reject placeholders, paths, URLs, and broadcast entity targets', () => {
  for (const invalidId of ['YOUR_RUN_ID', '$RUN_ID', '<run-id>', 'all', '*', '/tmp/run.json', 'https://example.test/run']) {
    assert.equal(TOOL_INPUT_SCHEMAS.run_get.safeParse({ run_id: invalidId, view: 'summary' }).success, false, invalidId)
  }
  assert.equal(TOOL_INPUT_SCHEMAS.workflow_get.safeParse({ workflow_id: '../security-review' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.run_cancel.safeParse({ run_id: 'run_01J', agent_run_id: 'broadcast' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.review_gate_resolve.safeParse({ run_id: 'run_01J', review_gate_id: 'approve-all', decision: 'approve' }).success, false)
})

test('strict schemas reject credentials, site switching, transports, and split configuration maps', () => {
  const forbidden = [
    { ...VALID_INPUTS.workflow_plan, token: 'secret' },
    { ...VALID_INPUTS.workflow_plan, site_id: 'site_other' },
    { ...VALID_INPUTS.workflow_plan, transport: 'github' },
    { ...VALID_INPUTS.workflow_plan, models: { claude: 'claude-opus-5' } },
    { ...VALID_INPUTS.workflow_plan, efforts: { claude: 'high' } },
  ]
  for (const input of forbidden) assert.equal(TOOL_INPUT_SCHEMAS.workflow_plan.safeParse(input).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.agent_run_plan.safeParse({ ...VALID_INPUTS.agent_run_plan, netlify_token: 'secret' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.context_get.safeParse({ project_root: '/tmp/repo' }).success, false)
})

test('project selection accepts one explicit reference and scopes every other tool', () => {
  assert.equal(TOOL_INPUT_SCHEMAS.context_get.safeParse({ project_ref: '/workspace/gtm-services' }).success, true)
  assert.equal(TOOL_INPUT_SCHEMAS.context_get.safeParse({ scope_id: 'scope_project_test' }).success, true)
  assert.equal(TOOL_INPUT_SCHEMAS.context_get.safeParse({ project_ref: '/workspace/gtm-services', scope_id: 'scope_project_test' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.context_get.safeParse({ project_ref: 'https://example.test/project' }).success, false)
  for (const [name, input] of Object.entries(VALID_INPUTS)) {
    if (name === 'context_get') continue
    assert.equal(TOOL_INPUT_SCHEMAS[name].safeParse({ ...input, scope_id: 'scope_project_test' }).success, true, name)
  }
})

test('instance contracts require objects and preserve repeated structured providers', () => {
  assert.equal(TOOL_INPUT_SCHEMAS.workflow_plan.safeParse({ workflow_id: 'security-review', instances: ['claude'] }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.agent_run_plan.safeParse({ prompt: 'Audit', instance: 'claude' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.workflow_plan.safeParse({
    workflow_id: 'security-review',
    instances: [{ agent: 'claude', model: 'claude-opus-5' }, { agent: 'claude', model: 'claude-sonnet-5', label: 'fast' }],
  }).success, true)
})

test('schema size, pagination, timeout, enum, and cross-field boundaries fail closed', () => {
  assert.equal(TOOL_INPUT_SCHEMAS.workflow_plan.safeParse({ workflow_id: 'security-review', context: 'x'.repeat(MAX_CONTEXT_BYTES) }).success, true)
  assert.equal(TOOL_INPUT_SCHEMAS.workflow_plan.safeParse({ workflow_id: 'security-review', context: 'x'.repeat(MAX_CONTEXT_BYTES + 1) }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.agent_run_plan.safeParse({ prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1), instance: { agent: 'claude' } }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.workflow_list.safeParse({ limit: 101 }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.run_wait.safeParse({ run_id: 'run_01J', timeout_ms: 30001 }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.run_list.safeParse({ status: 'pending' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.workflow_plan.safeParse({ workflow_id: 'security-review', only_step: 'analyze', from_step: 'collect' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.run_get.safeParse({ run_id: 'run_01J', view: 'summary', section_id: 'step:analyze' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.run_get.safeParse({ run_id: 'run_01J', view: 'details', since: '12' }).success, false)
})

test('paid-run mutations require stable caller request IDs', () => {
  assert.equal(TOOL_INPUT_SCHEMAS.run_start.safeParse({ plan_id: 'plan_01J' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.agent_run_retry.safeParse({ run_id: 'run_01J', agent_run_id: 'agent_run_01J' }).success, false)
  assert.equal(TOOL_INPUT_SCHEMAS.agent_run_followup.safeParse({ run_id: 'run_01J', agent_run_id: 'agent_run_01J', prompt: 'Continue' }).success, false)
})

test('every tool advertises complete educational documentation and safety annotations', () => {
  const requiredSections = ['Discovery:', 'When to use:', 'Do / do not:', 'Parameters:', 'Returns:', 'Example:', 'Idempotency:', 'Edge cases:', 'Common mistakes:']
  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    for (const section of requiredSections) assert.match(spec.description, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} omitted ${section}`)
    assert.doesNotThrow(() => z.toJSONSchema(spec.inputSchema))
    assert.doesNotThrow(() => z.toJSONSchema(spec.outputSchema))
  }
  assert.equal(TOOL_SPECS.workflow_get.annotations.readOnlyHint, true)
  assert.equal(TOOL_SPECS.workflow_plan.annotations.openWorldHint, true)
  assert.equal(TOOL_SPECS.run_start.annotations.idempotentHint, true)
  assert.equal(TOOL_SPECS.run_cancel.annotations.destructiveHint, true)
  assert.equal(TOOL_SPECS.review_gate_resolve.annotations.destructiveHint, true)
})

test('success results contain concise text and bounded structured content', () => {
  const result = successResult({
    summary: `Started runner with Bearer super-secret-token ${'x'.repeat(MAX_TEXT_BYTES)}`,
    data: { run_id: 'run_01J', authorization: 'secret', output: 'ready' },
    context: { runtime: 'local-dashboard', scope: { scopeId: 'scope_01J', projectId: 'project_01J' }, local: { projectRoot: '/repo', dashboardInstanceId: 'instance_01J' } },
    nextActions: [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: 'run_01J', token: 'secret' } }],
  })
  assert.equal(Buffer.byteLength(result.content[0].text) <= MAX_TEXT_BYTES + 16, true)
  assert.doesNotMatch(JSON.stringify(result), /super-secret-token|"authorization"|"token"/)
  assert.equal(result.structuredContent.next_actions[0]?.kind, 'tool')
  assert.equal(toolResultOutputSchema.safeParse(result.structuredContent).success, true)
})

test('shared MCP redaction covers common credential shapes without retaining values', () => {
  const input = [
    'Bearer bearer-secret-value',
    'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    'nfp_abcdefghijklmnop',
    'ghp_abcdefghijklmnop',
    'npm_abcdefghijklmnop',
    'sk_abcdefghijklmnop',
    'sk-abcdefghijklmnop',
    'xoxb-123456789012-secret',
    'AIza123456789012345678901234567890',
  ].join(' ')
  const redacted = redactSecretText(input)
  assert.equal(redacted.includes('[redacted]'), true)
  for (const secret of ['bearer-secret-value', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ', 'abcdefghijklmnop', '123456789012-secret', 'AIza123456']) {
    assert.equal(redacted.includes(secret), false)
  }
})

test('large structured results collapse to resource links instead of flooding context', () => {
  const data = {
    sections: Array.from({ length: 20 }, (_value, index) => ({
      markdown: 'x'.repeat(30000),
      resourceUri: `nax://scopes/scope/runs/run/artifacts/artifact_${index}`,
    })),
  }
  const bounded = boundStructuredData(data)
  assert.equal(/** @type {Record<string, unknown>} */ (bounded).truncated, true)
  assert.equal(/** @type {Record<string, unknown[]>} */ (bounded).resource_uris.length, 20)
  assert.equal(jsonBytes(bounded) < MAX_STRUCTURED_BYTES, true)
})

test('recoverable errors preserve codes, add fixes and exact fuzzy suggestions', () => {
  const error = Object.assign(new Error('Unknown workflow "security-reveiw".'), {
    code: 'workflow_not_found',
    statusCode: 404,
    details: {
      workflowId: 'security-reveiw',
      candidates: ['security-review', 'performance-review'],
      absolutePath: '/private/workflows/security.yml',
    },
  })
  const result = errorResult(error, { toolName: 'workflow_get' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.code, 'workflow_not_found')
  assert.deepEqual(result.structuredContent.error.details?.suggestions, ['security-review'])
  assert.equal(result.structuredContent.error.details?.absolutePath, undefined)
  assert.deepEqual(result.structuredContent.next_actions[0], { kind: 'tool', tool: 'workflow_list', arguments: { limit: 50 } })
  assert.equal(toolResultOutputSchema.safeParse(result.structuredContent).success, true)
})

test('errors provide runtime-specific recovery and never leak credentials', () => {
  const result = errorResult(Object.assign(new Error('No dashboard for Bearer should-not-leak'), {
    code: 'dashboard_not_running',
    recoverable: true,
    details: { projectRoot: '/repo', token: 'should-not-leak' },
  }), { toolName: 'context_get' })
  assert.doesNotMatch(JSON.stringify(result), /should-not-leak|"token"/)
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'command', command: "nax dashboard --project-root '/repo' --no-open" }])
  assert.equal(result.structuredContent.error.details?.projectRoot, '/repo')
})

test('dashboard recovery shell-quotes arbitrary legal project directory names', () => {
  assert.equal(shellQuote("/workspace/it's $(private)"), "'/workspace/it'\"'\"'s $(private)'")
})

test('Zod failures become educational invalid_arguments results and unexpected bugs throw', () => {
  const parse = TOOL_INPUT_SCHEMAS.run_get.safeParse({ run_id: 'YOUR_RUN_ID', view: 'summary' })
  assert.equal(parse.success, false)
  if (parse.success) return
  const normalized = normalizeMcpError(parse.error)
  assert.equal(normalized.code, 'invalid_arguments')
  assert.equal(normalized.details.issues[0].path, 'run_id')
  const result = errorResult(parse.error, { toolName: 'run_get' })
  assert.equal(result.structuredContent.error.details?.issues[0].path, 'run_id')
  assert.throws(() => errorResult(new Error('programmer bug')), /programmer bug/)
})

test('fuzzy suggestions are conservative and deterministic', () => {
  assert.deepEqual(closestCandidates('security-reveiw', ['performance-review', 'security-review', 'security-audit']), ['security-review'])
  assert.deepEqual(closestCandidates('totally-unrelated', ['security-review']), [])
})
