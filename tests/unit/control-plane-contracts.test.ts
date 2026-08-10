import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ControlPlaneActor,
  ControlPlaneScope,
  NaxControlPlane,
} from '../../src/contracts/control-plane'

const scope = {
  scopeId: 'scope_contract',
  projectId: 'project_contract',
  siteId: 'site_contract',
} satisfies ControlPlaneScope

const actor = {
  actorId: 'actor_contract',
  kind: 'service',
  authenticated: true,
} satisfies ControlPlaneActor

const contract = {
  async getContext(requestScope, requestActor) {
    return {
      runtime: 'hosted' as const,
      scope: requestScope,
      actor: requestActor,
      capabilities: {} as never,
      agentCatalog: { provenance: { source: 'fixture', commit: 'fixture', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
      target: null,
      currentBranch: 'main',
      branches: ['main'],
    }
  },
  async listWorkflows() { return { workflows: [], nextCursor: null } },
  async getWorkflow(_scope, _actor, workflowId) {
    return { workflow: { workflowId, title: workflowId, description: '', source: 'fixture', sourceLabel: 'Fixture', stepCount: 0, agents: [], defaults: {}, options: {}, steps: [] } }
  },
  async createWorkflowPlan() { throw new Error('not implemented by fixture') },
  async createAgentRunPlan() { throw new Error('not implemented by fixture') },
  async startPlan() { throw new Error('not implemented by fixture') },
  async listRuns() { return { runs: [], nextCursor: null } },
  async getRun(_scope, _actor, runId, options) { return { run: { runId, status: 'queued' }, view: options.view } },
  async waitForRun(_scope, _actor, runId) { return { run: { runId, status: 'queued' }, reason: 'timeout' as const, events: [], nextCursor: '0' } },
  async cancelRun() { throw new Error('not implemented by fixture') },
  async retryAgentRun() { throw new Error('not implemented by fixture') },
  async submitFollowup() { throw new Error('not implemented by fixture') },
  async resolveReviewGate() { throw new Error('not implemented by fixture') },
  async getArtifact(_scope, _actor, runId, artifactId) { return { runId, artifactId, contentType: 'text/plain', sizeBytes: 2, content: 'ok' } },
} satisfies NaxControlPlane

test('runtime-neutral contract accepts a hosted-shaped implementation', async () => {
  const context = await contract.getContext(scope, actor)
  assert.equal(context.runtime, 'hosted')
  assert.equal(context.scope.projectId, 'project_contract')
  assert.equal('projectRoot' in context.scope, false)
})
