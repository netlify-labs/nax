const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  McpProjectRouterError,
  createMcpProjectRouter,
  scopeIdForProject,
} = require('../../src/mcp/project-router')

function tempRoot(name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-router-'))
  const root = path.join(parent, name)
  fs.mkdirSync(root)
  return fs.realpathSync(root)
}

/**
 * @param {string} projectRoot
 * @param {string} projectId
 * @param {Partial<{ siteId: string, siteName: string, repositoryId: string }>} [overrides]
 */
function contextFor(projectRoot, projectId, overrides = {}) {
  const siteId = overrides.siteId || `site_${projectId}`
  return {
    runtime: /** @type {const} */ ('local-dashboard'),
    scope: {
      scopeId: scopeIdForProject(projectId),
      projectId,
      siteId,
      ...(overrides.repositoryId ? { repositoryId: overrides.repositoryId } : {}),
    },
    actor: { actorId: `actor_${projectId}`, kind: /** @type {const} */ ('local-session'), authenticated: true },
    capabilities: {},
    agentCatalog: { provenance: { source: 'test', commit: 'test', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
    target: { siteId, siteName: overrides.siteName || path.basename(projectRoot), branch: 'main', verified: true, caveats: [] },
    currentBranch: 'main',
    branches: ['main'],
    local: { projectRoot },
  }
}

/** @param {string} projectRoot @param {string} projectId */
function recordFor(projectRoot, projectId) {
  return {
    v: 1,
    instanceId: `instance_${projectId}`,
    pid: process.pid,
    projectId,
    projectRoot,
    origin: 'http://127.0.0.1:12345',
    token: 'private-token-at-least-24-characters',
    startedAt: '2026-08-08T00:00:00.000Z',
    version: '3.0.0',
  }
}

test('one router resolves exact paths, names, site aliases, and opaque scopes without changing its default', async () => {
  const revenueRoot = tempRoot('revenue-engine')
  const gtmRoot = tempRoot('gtm-services')
  const contexts = new Map([
    [revenueRoot, contextFor(revenueRoot, 'project_revenue')],
    [gtmRoot, contextFor(gtmRoot, 'project_gtm', { siteId: 'site_gtm', siteName: 'GTM Services', repositoryId: 'owner/gtm-services' })],
  ])
  const router = createMcpProjectRouter({
    defaultProjectRoot: revenueRoot,
    listInstances: () => [recordFor(revenueRoot, 'project_revenue'), recordFor(gtmRoot, 'project_gtm')],
    clientFactory: ({ projectRoot }) => /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
      getContext: async () => /** @type {import('../../src/contracts').ControlPlaneContext} */ (contexts.get(projectRoot)),
    }),
  })

  const [byName, bySite, byRepository, byScope, byPath, defaultProject] = await Promise.all([
    router.resolveClient({ projectRef: 'gtm-services' }),
    router.resolveClient({ projectRef: 'GTM Services' }),
    router.resolveClient({ projectRef: 'owner/gtm-services' }),
    router.resolveClient({ scopeId: scopeIdForProject('project_gtm') }),
    router.resolveClient({ projectRef: gtmRoot }),
    router.resolveClient(),
  ])
  for (const resolved of [byName, bySite, byRepository, byScope, byPath]) {
    assert.equal(resolved.projectRoot, gtmRoot)
    assert.equal(resolved.context.scope.projectId, 'project_gtm')
  }
  assert.equal(defaultProject.projectRoot, revenueRoot)
  assert.equal(defaultProject.context.scope.projectId, 'project_revenue')
})

test('router fails closed for unknown and ambiguous aliases without exposing roots or dashboard tokens', async () => {
  const firstRoot = tempRoot('shared-name')
  const secondRoot = tempRoot('shared-name')
  const records = [recordFor(firstRoot, 'project_first'), recordFor(secondRoot, 'project_second')]
  const router = createMcpProjectRouter({
    defaultProjectRoot: firstRoot,
    listInstances: () => records,
    clientFactory: ({ projectRoot }) => /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
      getContext: async () => contextFor(projectRoot, projectRoot === firstRoot ? 'project_first' : 'project_second'),
    }),
  })

  await assert.rejects(router.resolveClient({ projectRef: 'shared-name' }), /** @param {unknown} error */ (error) => {
    assert.equal(error instanceof McpProjectRouterError && error.code === 'project_ambiguous', true)
    assert.doesNotMatch(JSON.stringify(error), new RegExp(firstRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(JSON.stringify(error), /private-token/)
    return true
  })
  await assert.rejects(router.resolveClient({ projectRef: 'missing-project' }), /** @param {unknown} error */ (error) => {
    assert.equal(error instanceof McpProjectRouterError && error.code === 'project_not_found', true)
    return true
  })
  await assert.rejects(router.resolveClient({ scopeId: scopeIdForProject('project_missing') }), /** @param {unknown} error */ (error) => {
    assert.equal(error instanceof McpProjectRouterError && error.code === 'scope_forbidden', true)
    return true
  })
})

test('router rejects nonexistent explicit directories and conflicting selectors', async () => {
  const defaultRoot = tempRoot('default-project')
  const router = createMcpProjectRouter({
    defaultProjectRoot: defaultRoot,
    listInstances: () => [],
    clientFactory: () => /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
      getContext: async () => contextFor(defaultRoot, 'project_default'),
    }),
  })
  await assert.rejects(router.resolveClient({ projectRef: path.join(defaultRoot, 'missing') }), { code: 'project_not_found' })
  await assert.rejects(router.resolveClient({ projectRef: defaultRoot }), { code: 'dashboard_not_running' })
  await assert.rejects(router.resolveClient({ projectRef: defaultRoot, scopeId: scopeIdForProject('project_default') }), { code: 'invalid_arguments' })
})
