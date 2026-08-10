const { ResourceTemplate } = require('@modelcontextprotocol/server')
const { redactSecretText } = require('./security')
const { mcpClientResolver } = require('./routing')

const MAX_RESOURCE_TEXT_BYTES = 1024 * 1024
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,254}$/

/** @typedef {import('../contracts').ControlPlaneArtifact} ControlPlaneArtifact */
/** @typedef {import('../contracts').ControlPlaneContext} ControlPlaneContext */
/** @typedef {import('../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/** @param {string} value @param {string} field */
function resourceId(value, field) {
  let decoded
  try {
    decoded = decodeURIComponent(value)
  } catch (_error) {
    throw Object.assign(new Error(`${field} is not valid URI encoding.`), { code: 'invalid_resource_uri' })
  }
  if (!RESOURCE_ID_PATTERN.test(decoded) || decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) {
    throw Object.assign(new Error(`${field} must be one opaque control-plane ID.`), { code: 'invalid_resource_uri' })
  }
  return decoded
}

/**
 * @param {URL | string} input
 * @returns {{ kind: 'context' | 'workflow' | 'run' | 'details' | 'events' | 'artifact', scopeId: string, workflowId?: string, runId?: string, artifactId?: string, since?: string }}
 */
function parseNaxResourceUri(input) {
  const uri = input instanceof URL ? input : new URL(input)
  if (uri.protocol !== 'nax:' || uri.hostname !== 'scopes' || uri.username || uri.password || uri.port || uri.hash) {
    throw Object.assign(new Error('Resource URI must use the scoped nax://scopes namespace.'), { code: 'invalid_resource_uri' })
  }
  const parts = uri.pathname.split('/').filter(Boolean)
  const scopeId = resourceId(parts[0] || '', 'scope_id')
  const noQuery = () => {
    if ([...uri.searchParams.keys()].length > 0) throw Object.assign(new Error('This NAX resource does not accept query parameters.'), { code: 'invalid_resource_uri' })
  }
  if (parts.length === 2 && parts[1] === 'context') {
    noQuery()
    return { kind: 'context', scopeId }
  }
  if (parts.length === 3 && parts[1] === 'workflows') {
    noQuery()
    return { kind: 'workflow', scopeId, workflowId: resourceId(parts[2], 'workflow_id') }
  }
  if (parts.length >= 3 && parts[1] === 'runs') {
    const runId = resourceId(parts[2], 'run_id')
    if (parts.length === 3) {
      noQuery()
      return { kind: 'run', scopeId, runId }
    }
    if (parts.length === 4 && parts[3] === 'details') {
      noQuery()
      return { kind: 'details', scopeId, runId }
    }
    if (parts.length === 4 && parts[3] === 'events') {
      const keys = [...uri.searchParams.keys()]
      if (keys.some((key) => key !== 'since') || uri.searchParams.getAll('since').length > 1) {
        throw Object.assign(new Error('Run events accept only one opaque since cursor.'), { code: 'invalid_resource_uri' })
      }
      const sinceValue = uri.searchParams.get('since') || '0'
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(sinceValue)) throw Object.assign(new Error('since must be an opaque cursor returned by NAX.'), { code: 'invalid_resource_uri' })
      return { kind: 'events', scopeId, runId, since: sinceValue }
    }
    if (parts.length === 5 && parts[3] === 'artifacts') {
      noQuery()
      return { kind: 'artifact', scopeId, runId, artifactId: resourceId(parts[4], 'artifact_id') }
    }
  }
  throw Object.assign(new Error('Unknown NAX resource URI shape.'), { code: 'invalid_resource_uri' })
}

/** @param {unknown} value */
function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** @param {string} text @param {Record<string, unknown>} metadata */
function boundedResourceText(text, metadata) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_RESOURCE_TEXT_BYTES) return text
  return jsonText({
    truncated: true,
    reason: `Resource content exceeds the ${MAX_RESOURCE_TEXT_BYTES}-byte MCP resource limit.`,
    ...metadata,
  })
}

/** @param {URL} uri @param {string} text @param {string} [mimeType] */
function textResource(uri, text, mimeType = 'application/json') {
  return { contents: [{ uri: uri.href, mimeType, text }] }
}

/** @param {URL} uri @param {ControlPlaneArtifact} artifact */
function artifactResource(uri, artifact) {
  if (typeof artifact.content === 'string') {
    return textResource(uri, boundedResourceText(redactSecretText(artifact.content), {
      runId: artifact.runId,
      artifactId: artifact.artifactId,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
    }), artifact.contentType)
  }
  if (artifact.content.byteLength > MAX_RESOURCE_TEXT_BYTES) {
    return textResource(uri, jsonText({
      truncated: true,
      reason: `Binary resource exceeds the ${MAX_RESOURCE_TEXT_BYTES}-byte MCP resource limit.`,
      runId: artifact.runId,
      artifactId: artifact.artifactId,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
    }))
  }
  return { contents: [{ uri: uri.href, mimeType: artifact.contentType, blob: Buffer.from(artifact.content).toString('base64') }] }
}

/**
 * @param {NaxControlPlaneClient} client
 * @param {URL} uri
 */
async function readNaxResource(client, uri) {
  const target = parseNaxResourceUri(uri)
  const context = await client.getContext()
  if (target.scopeId !== context.scope.scopeId) {
    throw Object.assign(new Error('Resource scope does not match this MCP connection.'), {
      code: 'scope_forbidden',
      details: { requestedScopeId: target.scopeId },
    })
  }
  if (target.kind === 'context') return textResource(uri, boundedResourceText(jsonText(context), { kind: target.kind }))
  if (target.kind === 'workflow') {
    const result = await client.getWorkflow(target.workflowId || '', { includeGraph: true })
    return textResource(uri, boundedResourceText(jsonText(result), { kind: target.kind, workflowId: target.workflowId || '' }))
  }
  if (target.kind === 'run') {
    const result = await client.getRun(target.runId || '', { view: 'summary' })
    return textResource(uri, boundedResourceText(jsonText(result), { kind: target.kind, runId: target.runId || '' }))
  }
  if (target.kind === 'details') {
    const result = await client.getRun(target.runId || '', { view: 'details' })
    return textResource(uri, boundedResourceText(jsonText(result), { kind: target.kind, runId: target.runId || '' }))
  }
  if (target.kind === 'events') {
    const result = await client.getRun(target.runId || '', { view: 'events', since: target.since || '0', limit: 200 })
    return textResource(uri, boundedResourceText(jsonText(result), { kind: target.kind, runId: target.runId || '', since: target.since || '0' }))
  }
  try {
    return artifactResource(uri, await client.getArtifact(target.runId || '', target.artifactId || ''))
  } catch (error) {
    const record = error && typeof error === 'object' && !Array.isArray(error) ? /** @type {Record<string, unknown>} */ (error) : {}
    if (record.code !== 'artifact_too_large') throw error
    return textResource(uri, jsonText({ ok: false, error: { code: record.code, message: error instanceof Error ? error.message : String(error), details: record.details || {} } }))
  }
}

/** @param {ControlPlaneContext} context */
function contextUri(context) {
  return `nax://scopes/${encodeURIComponent(context.scope.scopeId)}/context`
}

/**
 * @param {{ server: import('@modelcontextprotocol/server').McpServer, client?: NaxControlPlaneClient, resolveClient?: import('./routing').McpClientResolver }} input
 */
function registerNaxResources({ server, client, resolveClient }) {
  const resolve = mcpClientResolver({ client, resolveClient })
  const template = (pattern, list) => new ResourceTemplate(pattern, { list })
  const read = async (uri) => {
    const target = parseNaxResourceUri(uri)
    const resolved = await resolve({ scopeId: target.scopeId })
    return readNaxResource(resolved.client, uri)
  }

  server.registerResource('nax-context', template('nax://scopes/{scope_id}/context', async () => {
    const { context } = await resolve()
    return { resources: [{ uri: contextUri(context), name: 'NAX control-plane context', mimeType: 'application/json' }] }
  }), { title: 'NAX context', description: 'Authenticated project scope, target, capabilities, and agent catalog.', mimeType: 'application/json' }, read)

  server.registerResource('nax-workflow', template('nax://scopes/{scope_id}/workflows/{workflow_id}', async () => {
    const { client: selectedClient, context } = await resolve()
    const result = await selectedClient.listWorkflows({ limit: 100 })
    return { resources: result.workflows.map((workflow) => ({
      uri: `nax://scopes/${encodeURIComponent(context.scope.scopeId)}/workflows/${encodeURIComponent(workflow.workflowId)}`,
      name: workflow.title,
      description: workflow.description,
      mimeType: 'application/json',
    })) }
  }), { title: 'NAX workflow', description: 'One workflow definition and dependency graph.', mimeType: 'application/json' }, read)

  const listRuns = async (suffix, name) => {
    const { client: selectedClient, context } = await resolve()
    const result = await selectedClient.listRuns({ limit: 100 })
    return { resources: result.runs.map((run) => ({
      uri: `nax://scopes/${encodeURIComponent(context.scope.scopeId)}/runs/${encodeURIComponent(run.runId)}${suffix}`,
      name: `${run.title || run.runId} ${name}`,
      description: `Run ${run.runId} is ${run.status}.`,
      mimeType: 'application/json',
    })) }
  }
  server.registerResource('nax-run', template('nax://scopes/{scope_id}/runs/{run_id}', () => listRuns('', 'summary')), { title: 'NAX run', description: 'One durable run summary.', mimeType: 'application/json' }, read)
  server.registerResource('nax-run-details', template('nax://scopes/{scope_id}/runs/{run_id}/details', () => listRuns('/details', 'details')), { title: 'NAX run details', description: 'Detailed sections and artifact index for one run.', mimeType: 'application/json' }, read)
  server.registerResource('nax-run-events', template('nax://scopes/{scope_id}/runs/{run_id}/events{?since}', () => listRuns('/events?since=0', 'events')), { title: 'NAX run events', description: 'A bounded event page beginning at an opaque cursor.', mimeType: 'application/json' }, read)
  server.registerResource('nax-run-artifact', template('nax://scopes/{scope_id}/runs/{run_id}/artifacts/{artifact_id}', undefined), { title: 'NAX run artifact', description: 'One exact artifact owned by one run.', mimeType: 'application/octet-stream' }, read)
}

module.exports = {
  MAX_RESOURCE_TEXT_BYTES,
  artifactResource,
  boundedResourceText,
  contextUri,
  parseNaxResourceUri,
  readNaxResource,
  registerNaxResources,
  resourceId,
  textResource,
}
