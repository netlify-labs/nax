const crypto = require('crypto')

/**
 * @typedef {{
 *   createAgentRunner: (input: { siteId?: string, promptText?: string, agent?: string, branch?: string, source?: object }) => Promise<import('../../netlify/api-client').NormalizedAgentRunner>,
 *   cancelAgentRunner: (input: { runnerId?: string }) => Promise<import('../../netlify/api-client').NormalizedAgentRunner>,
 *   getAgentRunner: (input: { runnerId?: string }) => Promise<import('../../netlify/api-client').NormalizedAgentRunner>,
 * }} HostedNetlifyApiClient
 *
 * @typedef {{
 *   client: HostedNetlifyApiClient,
 *   siteId?: string,
 * }} HostedNetlifyApiTransportOptions
 */

/** @param {unknown} value */
function stringValue(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** @param {Record<string, unknown>} body */
function hostedPrompt(body) {
  return stringValue(body.prompt || body.promptText || body.instructions).trim()
}

/** @param {unknown} value */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
}

/** @param {unknown} value */
function stringList(value) {
  if (Array.isArray(value)) return value.map(stringValue).map((item) => item.trim()).filter(Boolean)
  const text = stringValue(value).trim()
  return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : []
}

/** @param {unknown} value */
function numberValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** @param {unknown} value */
function stringMap(value) {
  const object = objectValue(value)
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, item] of Object.entries(object)) {
    if (item !== undefined && item !== null) out[key] = String(item)
  }
  return out
}

/** @param {Record<string, unknown>} body */
function hostedAgents(body) {
  const models = stringList(body.models)
  if (models.length > 0) return models
  const agents = stringList(body.agents)
  if (agents.length > 0) return agents
  return [stringValue(body.agent || body.model || 'codex').trim() || 'codex']
}

/** @param {unknown} value */
function hostedArtifactRefs(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const artifact = objectValue(item)
    return {
      id: stringValue(artifact.id),
      kind: stringValue(artifact.kind),
      url: stringValue(artifact.url),
      blobKey: stringValue(artifact.blobKey || artifact.key),
      store: stringValue(artifact.store),
    }
  }).filter((artifact) => artifact.id || artifact.url || artifact.blobKey)
}

/**
 * @param {unknown} payload
 * @returns {Array<Record<string, unknown>>}
 */
function rawArtifactItems(payload) {
  const raw = objectValue(payload)
  const latest = objectValue(raw.latest_session)
  const candidates = [
    raw.artifacts,
    raw.files,
    raw.file_changes,
    raw.outputs,
    latest.artifacts,
    latest.files,
    latest.file_changes,
    latest.outputs,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(objectValue)
  }
  return []
}

/**
 * @param {Record<string, unknown>} artifact
 * @param {number} index
 * @param {ReturnType<typeof hostedRunDto>} run
 */
function hostedDetailArtifact(artifact, index, run) {
  const name = stringValue(artifact.name || artifact.label || artifact.filename || artifact.path || `artifact-${index + 1}`)
  const kind = stringValue(artifact.kind || artifact.type || 'runner-summary')
  const id = stringValue(artifact.id || artifact.key || artifact.url || `${run.runnerId}:artifact:${index + 1}`)
  return {
    id,
    kind,
    label: name,
    path: stringValue(artifact.path || artifact.name || ''),
    absolutePath: '',
    sizeBytes: numberValue(artifact.size || artifact.sizeBytes || artifact.bytes),
    defaultSelected: index === 0,
    advanced: Boolean(artifact.advanced),
    stepNumber: 1,
    source: {
      stepId: 'hosted-runner',
      stepNumber: 1,
      runnerId: run.runnerId,
      sessionId: run.sessionId,
    },
    url: stringValue(artifact.url || artifact.href),
    blobKey: stringValue(artifact.blobKey || artifact.key),
    store: stringValue(artifact.store),
  }
}

/** @param {import('../../netlify/api-client').NormalizedAgentRunner} remote */
function hostedRunMarkdown(remote) {
  const raw = objectValue(remote.raw)
  const latest = objectValue(raw.latest_session)
  return stringValue(
    raw.markdown ||
    raw.summaryMarkdown ||
    raw.summary_markdown ||
    raw.summary ||
    raw.result ||
    raw.output ||
    latest.markdown ||
    latest.summary ||
    latest.result ||
    ''
  )
}

/** @param {import('../../netlify/api-client').NormalizedAgentRunner} remote */
function hostedRunAgent(remote) {
  const raw = objectValue(remote.raw)
  const latest = objectValue(raw.latest_session)
  return stringValue(raw.agent || raw.model || latest.agent || latest.model || 'codex') || 'codex'
}

/** @param {import('../../netlify/api-client').NormalizedAgentRunner} remote */
function hostedRunDetails(remote) {
  const run = hostedRunDto(remote)
  const agent = hostedRunAgent(remote)
  const markdown = hostedRunMarkdown(remote)
  const artifacts = rawArtifactItems(remote.raw).map((artifact, index) => hostedDetailArtifact(artifact, index, run))
  const target = {
    id: `hosted-runner:${run.runnerId || run.id}`,
    kind: 'agent-result',
    label: `${agent} hosted runner`,
    agent,
    stepId: 'hosted-runner',
    stepNumber: 1,
    stepTitle: 'Hosted Agent Runner',
    runnerId: run.runnerId,
    sessionId: run.sessionId,
    status: run.status,
    path: '',
    absolutePath: '',
    links: stringMap(run.links),
    defaultMode: 'fresh-runner',
    isDefault: true,
  }
  const section = {
    id: `hosted:${run.runnerId || run.id}`,
    kind: 'session',
    title: `${agent} hosted runner`,
    stepId: 'hosted-runner',
    stepTitle: 'Hosted Agent Runner',
    agent,
    status: run.status,
    runnerId: run.runnerId,
    sessionId: run.sessionId,
    path: '',
    absolutePath: '',
    links: stringMap(run.links),
    usage: objectValue(remote.raw.usage || objectValue(remote.raw.latest_session).usage),
    markdown,
  }
  return {
    summaryPath: '',
    summaryAbsolutePath: '',
    summaryMarkdown: markdown,
    finalMarkdown: markdown,
    finalTitle: section.title,
    workflowSteps: [{
      id: 'hosted-runner',
      title: 'Hosted Agent Runner',
      status: run.status,
      sourceType: 'netlify-api',
      agents: [agent],
      promptMarkdown: '',
      promptPath: '',
      promptTitle: 'Hosted Agent Runner',
    }],
    sections: markdown ? [section] : [],
    followupTargets: [target],
    followupArtifacts: artifacts,
  }
}

/** @param {import('../../netlify/api-client').NormalizedAgentRunner} remote */
function hostedRunGraph(remote) {
  const run = hostedRunDto(remote)
  const agent = hostedRunAgent(remote)
  return {
    run,
    workflow: {
      id: 'hosted-netlify-api',
      title: 'Hosted Netlify Agent Runner',
      source: 'hosted',
      steps: [{
        id: 'hosted-runner',
        title: 'Hosted Agent Runner',
        agents: [agent],
      }],
    },
    graph: {
      nodes: [{
        id: 'hosted-runner',
        type: 'workflowStep',
        position: { x: 0, y: 0 },
        data: {
          kind: 'workflow-step',
          flowId: 'hosted-netlify-api',
          stepId: 'hosted-runner',
          index: 0,
          graphIndex: 0,
          number: 1,
          title: 'Hosted Agent Runner',
          description: 'Remote Netlify API run',
          action: 'agent-run',
          submit: 'new-run',
          submitLabel: 'new agent run',
          waitFor: '',
          agents: [agent],
          input: [],
          status: run.status,
          runs: [run],
          sourceLabel: 'hosted',
          selectedAgents: [agent],
          promptMarkdown: '',
          promptPath: '',
          promptTitle: 'Hosted Agent Runner',
        },
      }],
      edges: [],
      metadata: {
        flowId: 'hosted-netlify-api',
        title: 'Hosted Netlify Agent Runner',
        description: '',
        source: 'hosted',
        sourceLabel: 'hosted',
        stepCount: 1,
        renderedStepCount: 1,
        agents: [agent],
        selectedAgents: [],
        hasRunState: true,
      },
    },
  }
}

/**
 * @param {string} prompt
 * @param {Record<string, unknown>} body
 * @param {Array<Record<string, string>>} artifacts
 */
function hostedFollowupPrompt(prompt, body, artifacts) {
  const contextText = stringValue(body.contextText || body.context || '').trim()
  const metadata = {
    source: 'nax-dashboard-hosted-followup',
    artifacts,
  }
  const parts = [prompt]
  if (contextText) parts.push(`Context:\n${contextText}`)
  if (artifacts.length > 0) parts.push(`Remote artifact references:\n${JSON.stringify(metadata, null, 2)}`)
  return parts.join('\n\n')
}

/**
 * @param {string} workflowId
 * @param {Record<string, unknown>} body
 */
function idempotencyKey(workflowId, body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      workflowId,
      prompt: hostedPrompt(body),
      agent: stringValue(body.agent || body.model || 'codex'),
      branch: stringValue(body.branch || ''),
    }))
    .digest('hex')
}

/** @param {import('../../netlify/api-client').NormalizedAgentRunner} remote */
function hostedRunDto(remote) {
  const status = dashboardStatus(remote.status || remote.state || 'submitted')
  return {
    id: remote.runnerId,
    runId: remote.runnerId,
    flowId: 'hosted-netlify-api',
    status,
    command: ['netlify-api', 'agent-runners', remote.runnerId],
    startedAt: '',
    exitedAt: '',
    durationMs: 0,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutDropped: 0,
    stderrDropped: 0,
    truncated: false,
    eventCount: 0,
    cancellable: !['completed', 'failed', 'cancelled'].includes(status),
    runnerId: remote.runnerId,
    sessionId: remote.sessionId,
    links: remote.links,
    raw: remote.raw,
  }
}

/** @param {string} status */
function dashboardStatus(status) {
  const value = String(status || '').toLowerCase()
  if (['queued', 'pending', 'created'].includes(value)) return 'submitted'
  if (['running', 'processing', 'in_progress'].includes(value)) return 'running'
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(value)) return 'completed'
  if (['failed', 'failure', 'error', 'errored'].includes(value)) return 'failed'
  if (['cancelled', 'canceled'].includes(value)) return 'cancelled'
  if (['timeout', 'timed_out'].includes(value)) return 'failed'
  return value || 'submitted'
}

/** @param {string} code @param {string} message @param {number} [statusCode] */
function transportError(code, message, statusCode = 400) {
  const error = /** @type {Error & { code?: string, statusCode?: number }} */ (new Error(message))
  error.code = code
  error.statusCode = statusCode
  return error
}

/** @param {HostedNetlifyApiTransportOptions} options */
function createHostedNetlifyApiTransport({ client, siteId = '' }) {
  /** @type {Map<string, ReturnType<typeof hostedRunDto>>} */
  const submitted = new Map()
  /** @type {Map<string, ReturnType<typeof hostedRunDto>>} */
  const runsById = new Map()
  /** @type {Map<string, object>} */
  const followupsById = new Map()
  /** @type {Map<string, Map<string, Record<string, string>>>} */
  const artifactCatalogByRunId = new Map()

  /**
   * @param {string} key
   * @param {ReturnType<typeof hostedRunDto>} run
   */
  function rememberRun(key, run) {
    submitted.set(key, run)
    if (run.runnerId) runsById.set(run.runnerId, run)
    if (run.id) runsById.set(run.id, run)
    return run
  }

  /**
   * @param {string} runId
   * @param {Array<Record<string, unknown>>} artifacts
   */
  function rememberArtifacts(runId, artifacts) {
    const catalog = new Map()
    for (const artifact of artifacts) {
      const ref = hostedArtifactRefs([artifact])[0]
      if (ref?.id) catalog.set(ref.id, ref)
    }
    artifactCatalogByRunId.set(runId, catalog)
  }

  /**
   * @param {string} runId
   * @param {unknown} artifacts
   */
  function expandArtifacts(runId, artifacts) {
    const refs = hostedArtifactRefs(artifacts)
    const catalog = artifactCatalogByRunId.get(runId)
    if (!catalog) return refs
    return refs.map((ref) => ref.id && catalog.has(ref.id) ? { ...ref, ...catalog.get(ref.id) } : ref)
  }

  return {
    /**
     * @param {string} workflowId
     * @param {Record<string, unknown>} [body]
     */
    async startWorkflowRun(workflowId, body = {}) {
      const promptText = hostedPrompt(body)
      if (!promptText) throw transportError('runner_validation_failed', 'Hosted Netlify API starts require a prompt.', 400)
      const key = idempotencyKey(workflowId, body)
      const existing = submitted.get(key)
      if (existing) {
        return {
          statusCode: 202,
          body: {
            workflow: { id: workflowId, title: workflowId, source: 'hosted' },
            run: existing,
            duplicate: true,
            idempotencyKey: key,
          },
        }
      }
      const remote = await client.createAgentRunner({
        siteId,
        promptText,
        agent: stringValue(body.agent || body.model || 'codex'),
        branch: stringValue(body.branch || ''),
        source: {
          idempotencyKey: key,
          workflowId,
          source: 'nax-dashboard',
        },
      })
      const run = {
        ...hostedRunDto(remote),
        flowId: workflowId,
      }
      rememberRun(key, run)
      return {
        statusCode: 202,
        body: {
          workflow: { id: workflowId, title: workflowId, source: 'hosted' },
          run,
          duplicate: false,
          idempotencyKey: key,
        },
      }
    },
    /** @param {string} runnerId */
    async cancelRun(runnerId) {
      if (!runnerId) throw transportError('runner_validation_failed', 'Agent Runner ID is required to cancel a hosted run.', 400)
      const remote = await client.cancelAgentRunner({ runnerId })
      return {
        body: {
          run: hostedRunDto(remote),
          cancelled: true,
          remoteStopped: remote.runnerId ? 1 : 0,
          remoteStopAttempted: 1,
          warnings: [],
        },
      }
    },
    async listRunsPage() {
      return {
        durable: [...runsById.values()],
        pagination: {
          durableLimit: runsById.size,
          durableOffset: 0,
          durableTotal: runsById.size,
          nextCursor: null,
          hasMore: false,
        },
      }
    },
    /** @param {string} runnerId */
    async getRun(runnerId) {
      const remote = await client.getAgentRunner({ runnerId })
      const run = hostedRunDto(remote)
      rememberRun(idempotencyKey(run.flowId || 'hosted-netlify-api', { prompt: run.id, agent: 'unknown' }), run)
      return run
    },
    /** @param {string} runnerId */
    async getRunGraph(runnerId) {
      const remote = await client.getAgentRunner({ runnerId })
      const graph = hostedRunGraph(remote)
      rememberRun(idempotencyKey('hosted-netlify-api', { prompt: graph.run.id, agent: hostedRunAgent(remote) }), graph.run)
      return graph
    },
    /** @param {string} runnerId */
    async getRunDetails(runnerId) {
      const remote = await client.getAgentRunner({ runnerId })
      const run = hostedRunDto(remote)
      const details = hostedRunDetails(remote)
      rememberRun(idempotencyKey('hosted-netlify-api', { prompt: run.id, agent: hostedRunAgent(remote) }), run)
      rememberArtifacts(runnerId, details.followupArtifacts)
      return { run, details }
    },
    /**
     * @param {{ runId?: string, since?: number }} [input]
     */
    async listEvents({ runId = '', since = 0 } = {}) {
      const remote = await client.getAgentRunner({ runnerId: runId })
      const run = hostedRunDto(remote)
      const event = {
        id: 1,
        seq: 1,
        type: 'runner_status',
        at: new Date().toISOString(),
        runId: run.id,
        status: run.status,
        runnerId: run.runnerId,
        sessionId: run.sessionId,
        links: run.links,
      }
      return {
        run,
        events: event.seq > since ? [event] : [],
        errors: [],
        polling: true,
      }
    },
    /**
     * @param {string} sourceRunId
     * @param {Record<string, unknown>} [body]
     */
    async submitFollowup(sourceRunId, body = {}) {
      const prompt = hostedPrompt(body)
      if (!prompt) throw transportError('missing_prompt', 'Enter follow-up instructions before submitting.', 400)
      if (!sourceRunId) throw transportError('missing_followup_target', 'No hosted follow-up target was provided.', 400)
      const requestedMode = stringValue(body.mode || 'fresh-runner')
      if (!['fresh-runner', 'new-run', 'runner'].includes(requestedMode)) {
        throw transportError('unsupported_followup_mode', `Hosted follow-up mode "${requestedMode}" is not available through the Netlify API transport.`, 501)
      }
      const target = {
        id: stringValue(body.targetId || objectValue(body.target).id || sourceRunId),
        runnerId: sourceRunId,
        sessionId: stringValue(objectValue(body.target).sessionId || body.sessionId),
        defaultMode: 'fresh-runner',
      }
      const artifacts = expandArtifacts(sourceRunId, body.artifacts)
      const agents = hostedAgents(body)
      const id = `hosted-followup-${sourceRunId}-${Date.now().toString(36)}`
      const promptText = hostedFollowupPrompt(prompt, body, artifacts)
      const submissions = []
      const warnings = []

      for (const agent of agents) {
        const remote = await client.createAgentRunner({
          siteId,
          promptText,
          agent,
          branch: stringValue(body.branch || body.targetBranch || objectValue(body.target).branch),
          source: {
            id,
            sourceWorkflowRunId: sourceRunId,
            sourceTargetId: target.id,
            sourceArtifactIds: artifacts.map((artifact) => artifact.id).filter(Boolean),
            source: 'nax-dashboard-hosted-followup',
          },
        })
        const dto = hostedRunDto(remote)
        const run = rememberRun(idempotencyKey(`hosted-followup:${sourceRunId}`, { prompt: promptText, agent, branch: body.branch }), {
          ...dto,
          flowId: `hosted-followup:${sourceRunId}`,
          raw: {
            ...(dto.raw || {}),
            dashboardFollowup: {
              id,
              sourceWorkflowRunId: sourceRunId,
              targetId: target.id,
              artifacts,
              delivery: { type: 'hosted-api', remoteOnly: true },
            },
          },
        })
        submissions.push({
          id: run.runnerId,
          mode: 'fresh-runner',
          agent,
          runnerId: run.runnerId,
          sessionId: run.sessionId,
          status: run.status,
          links: run.links || {},
          issueUrl: stringValue(run.links?.agentRunUrl || run.links?.url),
          sessionArtifactPath: '',
          runnerArtifactPath: '',
          warnings: [],
        })
      }

      const response = {
        id,
        status: 'submitted',
        sourceWorkflowRunId: sourceRunId,
        target,
        context: {
          artifactCount: artifacts.length,
          artifacts,
          delivery: { type: 'hosted-api', remoteOnly: true },
          bytes: Buffer.byteLength(promptText),
          blobRef: null,
        },
        plan: {
          requestedMode,
          submissions: agents.map((agent) => ({ mode: 'fresh-runner', agent })),
        },
        submissions,
        sourceWorkflow: null,
        persistedWorkflow: null,
        warnings,
      }
      followupsById.set(id, response)
      return {
        statusCode: 202,
        body: response,
      }
    },
    /**
     * @param {string} sourceRunId
     * @param {Record<string, unknown>} [body]
     */
    async cancelFollowup(sourceRunId, body = {}) {
      const runnerId = stringValue(body.runnerId || body.id).trim()
      if (!sourceRunId || !runnerId) throw transportError('missing_followup_run', 'Select a hosted follow-up runner to cancel.', 400)
      const remote = await client.cancelAgentRunner({ runnerId })
      return {
        body: {
          run: hostedRunDto(remote),
          cancelled: true,
          remoteStopped: remote.runnerId ? 1 : 0,
          remoteStopAttempted: 1,
          warnings: [],
        },
      }
    },
  }
}

module.exports = {
  createHostedNetlifyApiTransport,
  dashboardStatus,
  hostedRunDto,
  idempotencyKey,
}
