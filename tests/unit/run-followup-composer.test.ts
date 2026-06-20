import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRunFollowupRequest,
  defaultFollowupMode,
  defaultFollowupArtifactIds,
  defaultFollowupModels,
  defaultFollowupTarget,
  defaultFollowupThreadTarget,
  followupThreadTargets,
  followupPlanLine,
  formatArtifactBytes,
  selectedFollowupArtifacts,
} from '../../web/src/run-followup-composer'
import type { RunDetails } from '../../web/src/types'

function detailsFixture(): RunDetails {
  return {
    summaryPath: 'artifacts/summary.md',
    summaryAbsolutePath: '/repo/.nax/workflows/run/artifacts/summary.md',
    summaryMarkdown: '# Summary',
    finalMarkdown: '# Codex result',
    finalTitle: 'Codex result',
    sections: [],
    followupTargets: [
      {
        id: 'step-summary:review',
        kind: 'step-summary',
        label: 'Review step summary',
        agent: '',
        stepId: 'review',
        stepNumber: 1,
        stepTitle: 'Review',
        runnerId: '',
        sessionId: '',
        status: 'completed',
        path: 'artifacts/steps/01-review/summary.md',
        absolutePath: '/repo/.nax/workflows/run/artifacts/steps/01-review/summary.md',
        links: {},
        defaultMode: 'fresh-runner',
        isDefault: false,
      },
      {
        id: 'agent-result:review:runner-1:session-1:codex',
        kind: 'agent-result',
        label: 'Review · codex result',
        agent: 'codex',
        stepId: 'review',
        stepNumber: 1,
        stepTitle: 'Review',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        status: 'completed',
        path: 'artifacts/steps/01-review/agent-runners/codex.md',
        absolutePath: '/repo/.nax/workflows/run/artifacts/steps/01-review/agent-runners/codex.md',
        links: {},
        defaultMode: 'follow-up-thread',
        isDefault: true,
      },
      {
        id: 'runner-summary:review:runner-1:session-1:codex',
        kind: 'runner-summary',
        label: 'Step 1: codex runner summary',
        agent: 'codex',
        stepId: 'review',
        stepNumber: 1,
        stepTitle: 'Review',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        status: 'completed',
        path: '../../agent-runners/runner-1/summary.md',
        absolutePath: '/repo/.nax/agent-runners/runner-1/summary.md',
        links: {},
        defaultMode: 'follow-up-thread',
        isDefault: false,
      },
      {
        id: 'session-result:review:runner-1:session-1:codex',
        kind: 'session-result',
        label: 'Step 1: codex session summary',
        agent: 'codex',
        stepId: 'review',
        stepNumber: 1,
        stepTitle: 'Review',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        status: 'completed',
        path: '../../agent-sessions/session-1/summary.md',
        absolutePath: '/repo/.nax/agent-sessions/session-1/summary.md',
        links: {},
        defaultMode: 'follow-up-thread',
        isDefault: false,
      },
    ],
    followupArtifacts: [
      {
        id: 'workflow-summary:summary.md',
        kind: 'workflow-summary',
        label: 'Workflow summary',
        path: 'artifacts/summary.md',
        absolutePath: '/repo/.nax/workflows/run/artifacts/summary.md',
        sizeBytes: 4096,
        defaultSelected: true,
        advanced: false,
        stepNumber: 0,
        source: { stepId: '', stepNumber: 0, runnerId: '', sessionId: '' },
      },
      {
        id: 'step-summary:review:summary.md',
        kind: 'step-summary',
        label: 'Review step summary',
        path: 'artifacts/steps/01-review/summary.md',
        absolutePath: '/repo/.nax/workflows/run/artifacts/steps/01-review/summary.md',
        sizeBytes: 2048,
        defaultSelected: false,
        advanced: false,
        stepNumber: 1,
        source: { stepId: 'review', stepNumber: 1, runnerId: '', sessionId: '' },
      },
      {
        id: 'metadata-json:review:codex.json',
        kind: 'metadata-json',
        label: 'Codex metadata JSON',
        path: 'artifacts/steps/01-review/agent-runners/codex.json',
        absolutePath: '/repo/.nax/workflows/run/artifacts/steps/01-review/agent-runners/codex.json',
        sizeBytes: 128,
        defaultSelected: false,
        advanced: true,
        stepNumber: 1,
        source: { stepId: 'review', stepNumber: 1, runnerId: 'runner-1', sessionId: 'session-1' },
      },
    ],
  }
}

test('follow-up composer defaults to server-selected target, artifacts, and prior model', () => {
  const details = detailsFixture()
  const target = defaultFollowupTarget(details)
  assert.equal(target?.id, 'agent-result:review:runner-1:session-1:codex')
  assert.deepEqual(defaultFollowupArtifactIds(details), ['workflow-summary:summary.md'])
  assert.deepEqual(defaultFollowupModels(target), ['codex'])
})

test('follow-up composer defaults mode to existing thread when a runner target exists', () => {
  const details = detailsFixture()
  details.followupTargets[0].isDefault = true
  details.followupTargets[1].isDefault = false

  assert.equal(defaultFollowupTarget(details)?.id, 'step-summary:review')
  assert.equal(defaultFollowupThreadTarget(details)?.id, 'agent-result:review:runner-1:session-1:codex')
  assert.equal(defaultFollowupMode(details), 'follow-up-thread')
})

test('follow-up composer only offers actual agent results as previous agent runs', () => {
  const targets = followupThreadTargets(detailsFixture())
  assert.deepEqual(targets.map((target) => target.id), ['agent-result:review:runner-1:session-1:codex'])
})

test('follow-up composer shows mixed follow-up/fresh plan lines', () => {
  const target = defaultFollowupTarget(detailsFixture())
  assert.equal(followupPlanLine('codex', 'follow-up-thread', target), 'Codex: follow-up prompt on existing thread')
  assert.equal(followupPlanLine('gemini', 'follow-up-thread', target), 'Gemini: start fresh agent runner')
  assert.equal(followupPlanLine('codex', 'fresh-runner', target), 'Codex: start fresh agent runner')
})

test('follow-up composer builds request body from selected artifacts', () => {
  const details = detailsFixture()
  const target = defaultFollowupTarget(details)
  assert.ok(target)
  const artifacts = selectedFollowupArtifacts(details.followupArtifacts, ['metadata-json:review:codex.json'])
  const request = buildRunFollowupRequest({
    mode: 'follow-up-thread',
    prompt: 'Check the patch.',
    target,
    models: ['codex', 'gemini'],
    artifacts,
  })

  assert.deepEqual(request, {
    mode: 'follow-up-thread',
    prompt: 'Check the patch.',
    targetId: 'agent-result:review:runner-1:session-1:codex',
    models: ['codex', 'gemini'],
    artifacts: [{ id: 'metadata-json:review:codex.json', kind: 'metadata-json' }],
  })
})

test('follow-up composer can intentionally build a no-context request', () => {
  const target = defaultFollowupTarget(detailsFixture())
  assert.ok(target)
  const request = buildRunFollowupRequest({
    mode: 'fresh-runner',
    prompt: 'Start from the prompt only.',
    target,
    models: ['claude'],
    artifacts: [],
  })
  assert.deepEqual(request.artifacts, [])
  assert.equal(request.mode, 'fresh-runner')
})

test('follow-up composer formats artifact byte counts', () => {
  assert.equal(formatArtifactBytes(0), '0 B')
  assert.equal(formatArtifactBytes(512), '512 B')
  assert.equal(formatArtifactBytes(2048), '2.0 KB')
})
