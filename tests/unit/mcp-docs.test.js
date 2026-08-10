const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { TOOL_SPECS } = require('../../src/mcp/schemas')

const ROOT = path.resolve(__dirname, '../..')
const GUIDE_PATH = path.join(ROOT, 'site', 'content', 'guides', 'use-nax-with-claude.mdx')
const REFERENCE_PATH = path.join(ROOT, 'site', 'content', 'reference', 'mcp.mdx')
const TROUBLESHOOTING_PATH = path.join(ROOT, 'site', 'content', 'troubleshooting.mdx')

/** @param {string} filePath */
function read(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

test('canonical MCP reference stays in lockstep with entity-first tools and resources', () => {
  const reference = read(REFERENCE_PATH)
  for (const name of Object.keys(TOOL_SPECS)) assert.equal(reference.includes(`\`${name}\``), true, `missing ${name}`)

  for (const template of [
    'nax://scopes/{scope_id}/context',
    'nax://scopes/{scope_id}/workflows/{workflow_id}',
    'nax://scopes/{scope_id}/runs/{run_id}',
    'nax://scopes/{scope_id}/runs/{run_id}/details',
    'nax://scopes/{scope_id}/runs/{run_id}/events{?since}',
    'nax://scopes/{scope_id}/runs/{run_id}/artifacts/{artifact_id}',
  ]) assert.match(reference, new RegExp(template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.match(reference, /`run_remote_workflow`/)
  assert.match(reference, /`follow_up_on_run`/)
})

test('MCP documentation examples are valid JSON and avoid machine-specific connections', () => {
  const documentation = [read(GUIDE_PATH), read(REFERENCE_PATH)].join('\n')
  const jsonBlocks = [...documentation.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1])
  assert.ok(jsonBlocks.length >= 8)
  for (const block of jsonBlocks) assert.doesNotThrow(() => JSON.parse(block))

  assert.doesNotMatch(documentation, /\/Users\/|[A-Za-z]:\\Users\\/)
  assert.doesNotMatch(documentation, /127\.0\.0\.1:\d+|localhost:\d+/)
  assert.doesNotMatch(documentation, /\$\{CLAUDE_PROJECT_DIR\}/)
  assert.match(documentation, /"args": \["mcp"\]/)
  assert.match(documentation, /"project_ref": "\/workspace\/gtm-services"/)
})

test('MCP docs use the public setup lifecycle and contain required recovery guidance', () => {
  const guide = read(GUIDE_PATH)
  const troubleshooting = read(TROUBLESHOOTING_PATH)
  assert.match(guide, /nax mcp setup claude --scope project --dry-run/)
  assert.match(guide, /nax dashboard --no-open/)
  assert.match(guide, /nax mcp doctor/)
  assert.match(guide, /not shipped yet/)

  for (const code of [
    'dashboard_not_running',
    'dashboard_unreachable',
    'dashboard_auth_failed',
    'dashboard_version_mismatch',
    'project_scope_mismatch',
    'run_plan_expired',
    'idempotency_conflict',
  ]) assert.match(troubleshooting, new RegExp(code))

  const removedNames = [
    'get_context', 'list_workflows', 'get_workflow', 'plan_workflow', 'plan_agent_run',
    'start_run', 'list_runs', 'get_run', 'wait_run', 'cancel_run', 'retry_agent_run',
    'followup_agent_run', 'resolve_review_gate',
  ]
  for (const name of removedNames) assert.doesNotMatch(`${guide}\n${read(REFERENCE_PATH)}`, new RegExp(`\\b${name}\\b`))
})
