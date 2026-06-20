import test from 'node:test'
import assert from 'node:assert/strict'

import { selectRunDetailsSection } from '../../web/src/run-details-selection'
import type { RunDetailsSection } from '../../web/src/types'

function section(overrides: Partial<RunDetailsSection>): RunDetailsSection {
  return {
    id: overrides.id || 'session:runner:session:codex:0',
    kind: overrides.kind || 'session',
    title: overrides.title || 'Review · codex',
    stepId: overrides.stepId || 'review',
    stepTitle: overrides.stepTitle || 'Review',
    agent: overrides.agent || 'codex',
    status: overrides.status || 'completed',
    runnerId: overrides.runnerId || 'runner-1',
    sessionId: overrides.sessionId || 'session-1',
    path: overrides.path || 'artifacts/steps/review/agent-runners/codex.md',
    absolutePath: overrides.absolutePath || '/tmp/codex.md',
    links: overrides.links || {},
    usage: overrides.usage || null,
    markdown: overrides.markdown || '# Result',
  }
}

test('run details selector prefers exact runner id', () => {
  const sections = [
    section({ id: 'older', runnerId: 'runner-old', sessionId: 'session-old' }),
    section({ id: 'target', runnerId: 'runner-target', sessionId: 'session-target' }),
  ]

  const result = selectRunDetailsSection(sections, {
    stepId: 'review',
    agent: 'codex',
    runnerId: 'runner-target',
  })

  assert.equal(result.status, 'selected')
  if (result.status === 'selected') assert.equal(result.section.id, 'target')
})

test('run details selector prefers exact session id', () => {
  const sections = [
    section({ id: 'older', runnerId: 'runner-old', sessionId: 'session-old' }),
    section({ id: 'target', runnerId: 'runner-target', sessionId: 'session-target' }),
  ]

  const result = selectRunDetailsSection(sections, {
    stepId: 'review',
    agent: 'codex',
    sessionId: 'session-target',
  })

  assert.equal(result.status, 'selected')
  if (result.status === 'selected') assert.equal(result.section.id, 'target')
})

test('run details selector uses a single matching candidate without exact ids', () => {
  const result = selectRunDetailsSection([
    section({ id: 'target' }),
    section({ id: 'other-agent', agent: 'claude' }),
    section({ id: 'other-step', stepId: 'synthesize' }),
  ], {
    stepId: 'review',
    agent: 'codex',
  })

  assert.equal(result.status, 'selected')
  if (result.status === 'selected') assert.equal(result.section.id, 'target')
})

test('run details selector refuses ambiguous multiple candidates without exact ids', () => {
  const result = selectRunDetailsSection([
    section({ id: 'older', runnerId: 'runner-old', sessionId: 'session-old' }),
    section({ id: 'newer', runnerId: 'runner-new', sessionId: 'session-new' }),
  ], {
    stepId: 'review',
    agent: 'codex',
  })

  assert.equal(result.status, 'unresolved')
  assert.equal(result.candidates.length, 2)
})

test('run details selector reports no match', () => {
  const result = selectRunDetailsSection([
    section({ id: 'other-agent', agent: 'claude' }),
  ], {
    stepId: 'review',
    agent: 'codex',
  })

  assert.equal(result.status, 'none')
  assert.equal(result.candidates.length, 0)
})
