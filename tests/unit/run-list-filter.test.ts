// Tests for the runs sidebar filter helper: free-text and status-bucket
// matching over the loaded run list.
import test from 'node:test'
import assert from 'node:assert/strict'

import { filterRuns } from '../../src/dashboard/web/src/run-format'

const runs = [
  { id: 'run-1', runId: 'run-1', flowId: 'security-audit', flowTitle: 'Security Audit', status: 'failed', branch: 'main' },
  { id: 'run-2', runId: 'run-2', flowId: 'review', flowTitle: 'Review', status: 'completed', branch: 'feat/login' },
  { id: 'run-3', runId: 'run-3', flowId: 'review', flowTitle: 'Review', status: 'running', branch: 'main' },
  { id: 'run-4', runId: 'run-4', flowId: 'review', flowTitle: 'Review', status: 'timeout', branch: 'main' },
] as never[]

test('filterRuns passes everything through with no filter', () => {
  assert.equal(filterRuns(runs, { text: '', status: 'all' }).length, 4)
})

test('filterRuns matches text against flow title, flow id, run id, and branch', () => {
  assert.deepEqual(filterRuns(runs, { text: 'sec', status: 'all' }).map((run) => run.runId), ['run-1'])
  assert.deepEqual(filterRuns(runs, { text: 'RUN-2', status: 'all' }).map((run) => run.runId), ['run-2'])
  assert.deepEqual(filterRuns(runs, { text: 'feat/login', status: 'all' }).map((run) => run.runId), ['run-2'])
})

test('filterRuns status buckets use the visual status vocabulary', () => {
  assert.deepEqual(filterRuns(runs, { text: '', status: 'failed' }).map((run) => run.runId), ['run-1', 'run-4'])
  assert.deepEqual(filterRuns(runs, { text: '', status: 'running' }).map((run) => run.runId), ['run-3'])
})

test('filterRuns combines text and status', () => {
  assert.deepEqual(filterRuns(runs, { text: 'review', status: 'completed' }).map((run) => run.runId), ['run-2'])
  assert.equal(filterRuns(runs, { text: 'security', status: 'completed' }).length, 0)
})
