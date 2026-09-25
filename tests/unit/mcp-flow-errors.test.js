// Verifies MCP tool errors for broken flows carry diagnostics and specific recovery guidance.
// Exercises the real errorResult normalization used by every MCP tool.
const test = require('node:test')
const assert = require('node:assert/strict')

const { errorResult } = require('../../src/mcp/errors')

const diagnostics = [{ stepId: 'one', code: 'missing_prompt_file', message: 'Prompt file is missing.', hint: 'Create prompts/one.md.' }]

test('invalid_flow errors return diagnostics, recoverable, and nax lint guidance', () => {
  const error = Object.assign(new Error('Flow "broken-flow" is invalid'), {
    code: 'invalid_flow',
    statusCode: 422,
    details: { flowId: 'broken-flow', diagnostics },
  })
  const result = errorResult(error, { toolName: 'workflow_plan' })
  const payload = result.structuredContent.error
  assert.equal(payload.code, 'invalid_flow')
  assert.equal(payload.recoverable, true)
  assert.deepEqual(payload.details?.diagnostics, diagnostics)
  assert.match(String(payload.details?.fix), /Fix the listed diagnostics/)
  assert.match(String(payload.details?.fix), /nax lint broken-flow --json/)
  assert.match(String(payload.details?.fix), /workflow_plan/)
})

test('flow_load_failed errors explain the flow file could not be parsed', () => {
  const error = Object.assign(new Error('Flow "broken-flow" could not be loaded'), {
    code: 'flow_load_failed',
    statusCode: 422,
    details: { flowId: 'broken-flow', message: 'bad indentation' },
  })
  const result = errorResult(error, { toolName: 'workflow_plan' })
  assert.equal(result.structuredContent.error.recoverable, true)
  assert.match(String(result.structuredContent.error.details?.fix), /could not be parsed/)
})
