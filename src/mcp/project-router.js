const fs = require('node:fs')
const path = require('node:path')

const { canonicalProjectRoot, listDashboardInstances } = require('../runtime/local/mcp-instance-registry')
const { opaqueIdentity } = require('../runtime/local/control-plane-identity')
const { createLocalDashboardClient } = require('./adapters/local-dashboard')

/** @typedef {import('../contracts').ControlPlaneContext} ControlPlaneContext */
/** @typedef {import('../contracts').NaxControlPlaneClient} NaxControlPlaneClient */
/** @typedef {import('../runtime/local/mcp-instance-registry').DashboardInstanceRecord} DashboardInstanceRecord */
/** @typedef {import('./routing').McpClientResolver} McpClientResolver */
/** @typedef {import('./routing').McpProjectSelection} McpProjectSelection */
/** @typedef {import('./routing').McpResolvedClient} McpResolvedClient */

/**
 * @typedef {{
 *   projectRoot: string,
 *   projectId: string,
 *   scopeId: string,
 *   aliases: string[],
 *   client: NaxControlPlaneClient,
 *   context?: ControlPlaneContext,
 * }} McpProjectCandidate
 */

class McpProjectRouterError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'McpProjectRouterError'
    this.code = code
    this.recoverable = true
    this.details = details
  }
}

/** @param {string} projectId */
function scopeIdForProject(projectId) {
  return opaqueIdentity('scope', [projectId])
}

/** @param {string[]} values */
function uniqueAliases(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/**
 * @param {DashboardInstanceRecord} record
 * @param {NaxControlPlaneClient} client
 * @param {ControlPlaneContext | undefined} context
 * @returns {McpProjectCandidate}
 */
function projectCandidate(record, client, context) {
  const target = context?.target
  return {
    projectRoot: record.projectRoot,
    projectId: record.projectId,
    scopeId: scopeIdForProject(record.projectId),
    client,
    ...(context ? { context } : {}),
    aliases: uniqueAliases([
      path.basename(record.projectRoot),
      record.projectId,
      scopeIdForProject(record.projectId),
      context?.scope.repositoryId || '',
      context?.scope.siteId || '',
      target?.siteId || '',
      target?.siteName || '',
      target?.accountSlug || '',
    ]),
  }
}

/** @param {string} value */
function normalizedAlias(value) {
  return value.trim().toLocaleLowerCase('en-US')
}

/**
 * Creates one stateless project router for a single MCP connection. Every
 * operation resolves its client independently from an explicit scope rather
 * than mutating cwd or shared project state.
 *
 * @param {{
 *   defaultProjectRoot: string,
 *   registry?: import('../runtime/local/mcp-instance-registry').RegistryPathOptions,
 *   clientFactory?: (options: { projectRoot: string }) => NaxControlPlaneClient,
 *   listInstances?: (options?: import('../runtime/local/mcp-instance-registry').RegistryPathOptions & { isProcessAlive?: (pid: number) => boolean }) => DashboardInstanceRecord[],
 *   canonicalize?: (projectRoot: string) => string,
 *   stat?: (projectRoot: string) => import('node:fs').Stats,
 *   ensureDashboard?: (projectRoot: string) => Promise<unknown> | void,
 * }} input
 */
function createMcpProjectRouter({
  defaultProjectRoot,
  registry = {},
  clientFactory = createLocalDashboardClient,
  listInstances = listDashboardInstances,
  canonicalize = canonicalProjectRoot,
  stat = fs.statSync,
  ensureDashboard = async () => {},
}) {
  const defaultRoot = canonicalize(defaultProjectRoot)
  /** @type {Map<string, NaxControlPlaneClient>} */
  const clients = new Map()
  /** @type {Map<string, string>} */
  const scopeRoots = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const ensuring = new Map()

  // Dedupe concurrent auto-start attempts for the same root; re-run after each
  // settles so a dashboard that later stops is brought back on the next call.
  /** @param {string} root */
  function ensureDashboardOnce(root) {
    let pending = ensuring.get(root)
    if (!pending) {
      pending = Promise.resolve().then(() => ensureDashboard(root)).finally(() => ensuring.delete(root))
      ensuring.set(root, pending)
    }
    return pending
  }

  /** @param {string} projectRoot */
  function clientForRoot(projectRoot) {
    const root = canonicalize(projectRoot)
    const existing = clients.get(root)
    if (existing) return existing
    const client = clientFactory({ projectRoot: root })
    clients.set(root, client)
    return client
  }

  /** @returns {Promise<McpProjectCandidate[]>} */
  async function catalog() {
    const records = listInstances(registry)
    for (const record of records) scopeRoots.set(scopeIdForProject(record.projectId), record.projectRoot)
    return Promise.all(records.map(async (record) => {
      const client = clientForRoot(record.projectRoot)
      try {
        return projectCandidate(record, client, await client.getContext())
      } catch (_error) {
        return projectCandidate(record, client, undefined)
      }
    }))
  }

  /** @param {string} projectRef */
  function explicitProjectRoot(projectRef) {
    const absolute = path.isAbsolute(projectRef)
    const candidate = absolute
      ? projectRef
      : projectRef.includes('/') || projectRef.includes('\\') || projectRef === '.' || projectRef === '..'
        ? path.resolve(defaultRoot, projectRef)
        : ''
    if (!candidate) return ''
    let root
    try {
      root = canonicalize(candidate)
      if (!stat(root).isDirectory()) throw new Error('not a directory')
    } catch (_error) {
      if (!absolute) return ''
      throw new McpProjectRouterError('project_not_found', `Project reference "${projectRef}" does not resolve to an existing directory.`, {
        projectRef,
      })
    }
    return root
  }

  /** @param {McpProjectCandidate[]} candidates */
  function publicCandidates(candidates) {
    return candidates.map((candidate) => ({
      name: path.basename(candidate.projectRoot),
      projectId: candidate.projectId,
      scopeId: candidate.scopeId,
      running: true,
    }))
  }

  /**
   * @param {McpProjectSelection} [selection]
   * @returns {Promise<McpResolvedClient>}
   */
  const resolveClient = async ({ scopeId = '', projectRef = '' } = {}) => {
    if (scopeId && projectRef) {
      throw new McpProjectRouterError('invalid_arguments', 'Choose either scope_id or project_ref, not both.')
    }

    if (!scopeId && !projectRef) {
      await ensureDashboardOnce(defaultRoot)
      const client = clientForRoot(defaultRoot)
      const context = await client.getContext()
      scopeRoots.set(context.scope.scopeId, defaultRoot)
      return { client, context, projectRoot: defaultRoot }
    }

    const root = projectRef ? explicitProjectRoot(projectRef) : ''
    if (root) {
      await ensureDashboardOnce(root)
      const advertised = listInstances(registry).some((record) => record.projectRoot === root)
      if (!advertised) {
        throw new McpProjectRouterError('dashboard_not_running', 'No running NAX dashboard is advertised for the selected project.', {
          projectRoot: root,
        })
      }
      const client = clientForRoot(root)
      const context = await client.getContext()
      scopeRoots.set(context.scope.scopeId, root)
      return { client, context, projectRoot: root }
    }

    const rememberedRoot = scopeId ? scopeRoots.get(scopeId) : ''
    if (rememberedRoot) {
      const client = clientForRoot(rememberedRoot)
      return { client, context: await client.getContext(), projectRoot: rememberedRoot }
    }

    const candidates = await catalog()
    const requested = normalizedAlias(scopeId || projectRef)
    const matches = candidates.filter((candidate) => {
      if (scopeId) return normalizedAlias(candidate.scopeId) === requested
      return candidate.aliases.some((alias) => normalizedAlias(alias) === requested)
    })
    if (matches.length === 0) {
      throw new McpProjectRouterError(scopeId ? 'scope_forbidden' : 'project_not_found', scopeId
        ? `Scope "${scopeId}" is not advertised by a running NAX dashboard.`
        : `Project "${projectRef}" is not an exact alias of a running NAX dashboard.`, {
        ...(scopeId ? { requestedScopeId: scopeId } : { projectRef }),
        candidates: publicCandidates(candidates),
      })
    }
    if (matches.length > 1) {
      throw new McpProjectRouterError('project_ambiguous', `Project reference "${projectRef}" matches more than one running NAX dashboard.`, {
        projectRef,
        candidates: publicCandidates(matches),
      })
    }
    const match = matches[0]
    const context = match.context || await match.client.getContext()
    if (context.scope.scopeId !== match.scopeId) {
      throw new McpProjectRouterError('project_scope_mismatch', 'The selected dashboard returned a different project scope.', {
        requestedScopeId: match.scopeId,
        actualScopeId: context.scope.scopeId,
      })
    }
    scopeRoots.set(context.scope.scopeId, match.projectRoot)
    return { client: match.client, context, projectRoot: match.projectRoot }
  }

  return Object.freeze({
    defaultProjectRoot: defaultRoot,
    defaultClient: clientForRoot(defaultRoot),
    resolveClient: /** @type {McpClientResolver} */ (resolveClient),
  })
}

module.exports = {
  McpProjectRouterError,
  createMcpProjectRouter,
  normalizedAlias,
  projectCandidate,
  scopeIdForProject,
  uniqueAliases,
}
