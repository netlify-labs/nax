import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_LIVE_RUN_OUTPUT_CHARS, appendBoundedOutput, initialLiveRunState, liveRunReducer, visualStatus } from '../../src/dashboard/web/src/liveRunReducer'

test('live run reducer maps ordered workflow, step, agent, and output events', () => {
  let state = initialLiveRunState({ id: 'tmp-run', flowId: 'review', status: 'running' })
  state = liveRunReducer(state, { type: 'event', event: { type: 'workflow_started', eventId: 'run-1:1', seq: 1, runId: 'run-1', flowId: 'review', status: 'running' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'step_status', eventId: 'run-1:2', seq: 2, runId: 'run-1', stepId: 'review', status: 'running' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'agent_status', eventId: 'run-1:3', seq: 3, runId: 'run-1', stepId: 'review', agent: 'codex', status: 'submitted' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'stdout', id: 1, text: 'hello\n' } })

  assert.equal(state.run?.runId, 'run-1')
  assert.equal(state.stepStatuses.review, 'running')
  assert.equal(state.agentStatuses.review['codex:auto:auto'], 'running')
  assert.equal(state.output, 'hello\n')
})

test('live run reducer dedupes replayed structured events by eventId', () => {
  let state = initialLiveRunState()
  const event = { type: 'agent_status', eventId: 'run-1:3', seq: 3, runId: 'run-1', stepId: 'review', agent: 'codex', status: 'completed' }
  state = liveRunReducer(state, { type: 'event', event })
  state = liveRunReducer(state, { type: 'event', event: { ...event, status: 'failed' } })
  assert.equal(state.agentStatuses.review['codex:auto:auto'], 'completed')
})

test('live run reducer bounds retained output', () => {
  const oversized = 'x'.repeat(MAX_LIVE_RUN_OUTPUT_CHARS + 10)
  let state = initialLiveRunState()
  state = liveRunReducer(state, { type: 'event', event: { type: 'stdout', id: 1, text: oversized } })

  assert.equal(state.output.length, MAX_LIVE_RUN_OUTPUT_CHARS)
  assert.equal(appendBoundedOutput('abc', 'def', 5), 'bcdef')
})

test('live run reducer ignores older durable replay statuses after newer live status', () => {
  let state = initialLiveRunState()
  state = liveRunReducer(state, { type: 'event', event: { type: 'step_status', eventId: 'run-1:9', seq: 9, runId: 'run-1', stepId: 'review', status: 'completed' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'step_status', eventId: 'run-1:4', seq: 4, runId: 'run-1', stepId: 'review', status: 'running' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'agent_status', eventId: 'run-1:10', seq: 10, runId: 'run-1', stepId: 'review', agent: 'claude', status: 'completed' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'agent_status', eventId: 'run-1:5', seq: 5, runId: 'run-1', stepId: 'review', agent: 'claude', status: 'submitted' } })

  assert.equal(state.stepStatuses.review, 'completed')
  assert.equal(state.agentStatuses.review['claude:auto:auto'], 'completed')
})

test('live run reducer bootstraps a temporary run from workflow_started on reconnect', () => {
  let state = initialLiveRunState({ id: 'dashboard-run', flowId: 'review', status: 'running' })
  state = liveRunReducer(state, { type: 'event', event: { type: 'workflow_started', eventId: 'real-run:1', seq: 1, runId: 'real-run', flowId: 'review', flowTitle: 'Review', status: 'running', command: ['nax', 'run', 'review'] } })

  assert.equal(state.run?.id, 'dashboard-run')
  assert.equal(state.run?.runId, 'real-run')
  assert.equal(state.run?.flowTitle, 'Review')
  assert.deepEqual(state.run?.command, ['nax', 'run', 'review'])
})

test('live run reducer records artifacts, parser errors, and terminal run metadata', () => {
  let state = initialLiveRunState({ id: 'dashboard-run', flowId: 'review', status: 'running' })
  state = liveRunReducer(state, { type: 'event', event: { type: 'artifact_written', eventId: 'run-1:11', seq: 11, runId: 'run-1', path: 'artifacts/summary.md' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'future_event', eventId: 'run-1:12', seq: 12, runId: 'run-1', payload: 'ignored' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'runner_event_error', id: 12, message: 'Malformed event' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'workflow_completed', eventId: 'run-1:13', seq: 13, runId: 'run-1', status: 'completed', durationMs: 1200, exitCode: 0, at: '2026-06-19T00:00:00.000Z' } })

  assert.equal(state.artifacts.length, 1)
  assert.equal(state.rawEvents.some((event) => event.type === 'future_event'), true)
  assert.equal(state.errors[0], 'Malformed event')
  assert.equal(state.run?.status, 'completed')
  assert.equal(state.run?.durationMs, 1200)
  assert.equal(state.run?.exitCode, 0)
  assert.equal(state.run?.exitedAt, '2026-06-19T00:00:00.000Z')
})

test('visual status maps raw runner statuses into UI vocabulary', () => {
  assert.equal(visualStatus('pending'), 'running')
  assert.equal(visualStatus('submitted'), 'running')
  assert.equal(visualStatus('submitting'), 'running')
  assert.equal(visualStatus('timeout'), 'failed')
  assert.equal(visualStatus('abandoned'), 'abandoned')
})

test('live run reducer surfaces workflow_failed message in errors', () => {
  let state = initialLiveRunState({ id: 'dashboard-run', flowId: 'review', status: 'running' })
  state = liveRunReducer(state, { type: 'event', event: { type: 'workflow_failed', eventId: 'run-1:20', seq: 20, runId: 'run-1', status: 'failed', exitCode: 1, message: 'Netlify API request failed (404): site not found' } })

  assert.equal(state.run?.status, 'failed')
  assert.deepEqual(state.errors, ['Netlify API request failed (404): site not found'])
})

test('live run reducer surfaces failed agent_status message in errors', () => {
  let state = initialLiveRunState({ id: 'dashboard-run', flowId: 'review', status: 'running' })
  state = liveRunReducer(state, { type: 'event', event: { type: 'agent_status', eventId: 'run-1:21', seq: 21, runId: 'run-1', stepId: 'review', agent: 'codex', status: 'failed', message: 'netlify agents:create failed: Not Found' } })

  assert.equal(state.agentStatuses.review['codex:auto:auto'], 'failed')
  assert.deepEqual(state.errors, ['review/codex: netlify agents:create failed: Not Found'])
})

test('live run reducer does not duplicate identical error messages across events', () => {
  let state = initialLiveRunState({ id: 'dashboard-run', flowId: 'review', status: 'running' })
  state = liveRunReducer(state, { type: 'event', event: { type: 'workflow_failed', eventId: 'run-1:22', seq: 22, runId: 'run-1', status: 'failed', message: 'Submission failed' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'workflow_failed', eventId: 'run-1:23', seq: 23, runId: 'run-1', status: 'failed', message: 'Submission failed' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'error', id: 30, message: 'Submission failed' } })

  assert.deepEqual(state.errors, ['Submission failed'])
})

test('live run reducer ignores terminal and failed-agent events without a message', () => {
  let state = initialLiveRunState({ id: 'dashboard-run', flowId: 'review', status: 'running' })
  state = liveRunReducer(state, { type: 'event', event: { type: 'agent_status', eventId: 'run-1:24', seq: 24, runId: 'run-1', stepId: 'review', agent: 'codex', status: 'failed' } })
  state = liveRunReducer(state, { type: 'event', event: { type: 'workflow_failed', eventId: 'run-1:25', seq: 25, runId: 'run-1', status: 'failed', exitCode: 1 } })

  assert.equal(state.run?.status, 'failed')
  assert.equal(state.agentStatuses.review['codex:auto:auto'], 'failed')
  assert.deepEqual(state.errors, [])
})

test('live run reducer tracks repeated providers by instance id', () => {
  let state = initialLiveRunState()
  state = liveRunReducer(state, { type: 'event', event: {
    type: 'agent_status', eventId: 'run-1:26', seq: 26, runId: 'run-1', stepId: 'review',
    agent: 'codex', instanceId: 'codex:gpt-5.6-sol:high', status: 'completed',
  } })
  state = liveRunReducer(state, { type: 'event', event: {
    type: 'agent_status', eventId: 'run-1:27', seq: 27, runId: 'run-1', stepId: 'review',
    agent: 'codex', instanceId: 'codex:gpt-5.6-sol:medium', status: 'failed',
  } })

  assert.deepEqual(state.agentStatuses.review, {
    'codex:gpt-5.6-sol:high': 'completed',
    'codex:gpt-5.6-sol:medium': 'failed',
  })
})
