const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  AUDIT_VERSION,
  createLocalControlPlaneAuditSink,
  localControlPlaneAuditPath,
} = require('../../src/runtime/local/control-plane-audit')

test('local control-plane audit appends private value-free JSONL records', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-control-plane-audit-'))
  const sink = createLocalControlPlaneAuditSink(projectRoot)
  sink.record({
    operation: 'startPlan',
    activity: 'run_start',
    at: '2026-08-08T12:00:00.000Z',
    durationMs: 12,
    ok: true,
    scopeId: 'scope_test',
    actorId: 'actor_test',
    runtime: 'local-dashboard',
    planId: 'plan_test',
    requestId: 'request_test',
    expectedAgentRuns: 2,
    createdAgentRuns: 2,
  })
  const filePath = localControlPlaneAuditPath(projectRoot)
  const records = fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(records.length, 1)
  assert.equal(records[0].version, AUDIT_VERSION)
  assert.equal(records[0].activity, 'run_start')
  assert.equal(records[0].planId, 'plan_test')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700)
  }
})
