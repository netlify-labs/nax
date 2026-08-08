import assert from 'node:assert/strict'
import test from 'node:test'

import { agentInstanceId, configuredAgentInstance, instanceFromRun } from '../../src/dashboard/web/src/agent-instances'

test('dashboard instance helpers derive stable tuple identities', () => {
  assert.equal(agentInstanceId('codex'), 'codex:auto:auto')
  assert.equal(agentInstanceId('codex', 'gpt-5.6-sol', 'high'), 'codex:gpt-5.6-sol:high')
  assert.deepEqual(configuredAgentInstance(
    { agent: 'codex', id: 'codex:auto:auto', resolvedFrom: 'open' },
    'gpt-5.6-sol',
    'high',
  ), {
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    id: 'codex:gpt-5.6-sol:high',
    resolvedFrom: 'pinned',
  })
})

test('dashboard instance helpers preserve durable instance ids', () => {
  assert.deepEqual(instanceFromRun({
    agent: 'claude',
    instanceId: 'claude:claude-opus-5:high',
    model: 'claude-opus-5',
    effort: 'high',
    instanceLabel: 'Primary reviewer',
  }), {
    agent: 'claude',
    id: 'claude:claude-opus-5:high',
    model: 'claude-opus-5',
    effort: 'high',
    label: 'Primary reviewer',
    resolvedFrom: 'pinned',
  })
})
