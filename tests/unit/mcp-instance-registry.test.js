const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { PACKAGE_VERSION } = require('../../src/core/artifact-metadata')
const {
  DashboardRegistryError,
  canonicalProjectRoot,
  dashboardInstancePath,
  discoverDashboardInstance,
  ensureStableProjectIdentity,
  isLoopbackOrigin,
  listDashboardInstances,
  readDashboardInstance,
  removeDashboardInstance,
  runtimeUserId,
  writeDashboardInstance,
} = require('../../src/runtime/local/mcp-instance-registry')

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-registry-'))
}

/**
 * @param {string} projectRoot
 * @param {Partial<{
 *   v: number,
 *   instanceId: string,
 *   pid: number,
 *   projectId: string,
 *   projectRoot: string,
 *   origin: string,
 *   token: string,
 *   startedAt: string,
 *   version: string,
 * }>} [overrides]
 */
function recordFor(projectRoot, overrides = {}) {
  const identity = ensureStableProjectIdentity(projectRoot, { projectId: 'project_registry_test' })
  return {
    v: 1,
    instanceId: 'instance_registry_test',
    pid: process.pid,
    projectId: identity.projectId,
    projectRoot: identity.projectRoot,
    origin: 'http://127.0.0.1:53734',
    token: 'registry-token-at-least-24-characters',
    startedAt: '2026-08-08T00:00:00.000Z',
    version: PACKAGE_VERSION,
    ...overrides,
  }
}

test('stable project identity survives repeated reads and a directory move', () => {
  const parent = tempRoot()
  const original = path.join(parent, 'Original')
  const moved = path.join(parent, 'Moved')
  fs.mkdirSync(original)

  const first = ensureStableProjectIdentity(original, { projectId: 'project_move_test' })
  const second = ensureStableProjectIdentity(original, { projectId: 'project_other_value' })
  fs.renameSync(original, moved)
  const afterMove = ensureStableProjectIdentity(moved, { projectId: 'project_third_value' })

  assert.equal(first.projectId, 'project_move_test')
  assert.equal(second.projectId, first.projectId)
  assert.equal(afterMove.projectId, first.projectId)
  assert.equal(fs.readFileSync(path.join(moved, '.gitignore'), 'utf8'), '.nax/\n')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(moved, '.nax', 'project.json')).mode & 0o777, 0o600)
  }
})

test('canonical roots normalize case for the Windows identity seam', () => {
  const root = tempRoot()
  assert.equal(canonicalProjectRoot(root, { platform: 'win32', realpath: (value) => value.toUpperCase() }), path.resolve(root).toLowerCase())
})

test('runtime user fallback is opaque and stable', () => {
  const first = runtimeUserId({ getuid: null, username: 'Test User', homedir: '/private/home' })
  const second = runtimeUserId({ getuid: null, username: 'Test User', homedir: '/private/home' })
  assert.equal(first, second)
  assert.match(first, /^[a-f0-9]{16}$/)
  assert.doesNotMatch(first, /Test User/)
})

test('registry writes one private record and removes it only for the owning instance', () => {
  const projectRoot = tempRoot()
  const runtimeRoot = tempRoot()
  const registry = { tempDir: runtimeRoot, userId: 'test-user', env: {} }
  const record = recordFor(projectRoot)
  const filePath = writeDashboardInstance(record, registry)

  assert.equal(filePath, dashboardInstancePath(projectRoot, registry))
  assert.deepEqual(readDashboardInstance(projectRoot, registry), record)
  assert.equal(removeDashboardInstance(projectRoot, 'instance_newer', registry), false)
  assert.equal(fs.existsSync(filePath), true)
  assert.equal(removeDashboardInstance(projectRoot, record.instanceId, registry), true)
  assert.equal(fs.existsSync(filePath), false)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700)
  }
})

test('registry enumerates only live private dashboard records for multi-project routing', () => {
  const runtimeRoot = tempRoot()
  const registry = { tempDir: runtimeRoot, userId: 'test-user', env: {} }
  const firstRoot = tempRoot()
  const secondRoot = tempRoot()
  const first = recordFor(firstRoot, { instanceId: 'instance_registry_first', pid: 101 })
  const second = recordFor(secondRoot, { instanceId: 'instance_registry_second', pid: 202 })
  writeDashboardInstance(first, { ...registry, isProcessAlive: () => false })
  writeDashboardInstance(second, { ...registry, isProcessAlive: () => false })

  const records = listDashboardInstances({ ...registry, isProcessAlive: (pid) => pid === 202 })
  assert.deepEqual(records.map((record) => record.instanceId), ['instance_registry_second'])
})

test('registry refuses a second live dashboard and replaces a stale one', () => {
  const projectRoot = tempRoot()
  const registry = { tempDir: tempRoot(), userId: 'test-user', env: {} }
  const first = recordFor(projectRoot)
  writeDashboardInstance(first, { ...registry, isProcessAlive: () => true })

  assert.throws(
    () => writeDashboardInstance({ ...first, instanceId: 'instance_registry_second' }, { ...registry, isProcessAlive: () => true }),
    /** @param {unknown} error */ (error) => error instanceof DashboardRegistryError && error.code === 'dashboard_already_advertised',
  )

  const replacement = { ...first, instanceId: 'instance_registry_replaced', pid: 999999 }
  writeDashboardInstance(replacement, { ...registry, isProcessAlive: () => false })
  assert.equal(readDashboardInstance(projectRoot, registry)?.instanceId, replacement.instanceId)
})

test('registry rejects symlink and broadly readable credential records', () => {
  const projectRoot = tempRoot()
  const registry = { tempDir: tempRoot(), userId: 'test-user', env: {} }
  const record = recordFor(projectRoot)
  const filePath = writeDashboardInstance(record, registry)
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o644)
    assert.throws(
      () => readDashboardInstance(projectRoot, registry),
      /** @param {unknown} error */ (error) => error instanceof DashboardRegistryError && error.code === 'dashboard_registry_permissions',
    )
    fs.chmodSync(filePath, 0o600)
  }

  const target = path.join(tempRoot(), 'registry-target.json')
  fs.renameSync(filePath, target)
  fs.symlinkSync(target, filePath)
  assert.throws(
    () => readDashboardInstance(projectRoot, registry),
    /** @param {unknown} error */ (error) => error instanceof DashboardRegistryError && error.code === 'dashboard_registry_invalid',
  )
})

test('registry accepts only credential-free loopback origins', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:53734'), true)
  assert.equal(isLoopbackOrigin('http://localhost:53734'), true)
  assert.equal(isLoopbackOrigin('http://[::1]:53734'), true)
  assert.equal(isLoopbackOrigin('http://0.0.0.0:53734'), false)
  assert.equal(isLoopbackOrigin('https://example.com'), false)
  assert.equal(isLoopbackOrigin('http://user:password@127.0.0.1:53734'), false)
})

test('discovery authenticates health and returns the verified record', async () => {
  const projectRoot = tempRoot()
  const registry = { tempDir: tempRoot(), userId: 'test-user', env: {} }
  const record = recordFor(projectRoot)
  writeDashboardInstance(record, registry)
  let receivedToken = ''

  const discovered = await discoverDashboardInstance({
    projectRoot,
    registry,
    isProcessAlive: () => true,
    fetchImpl: async (_url, init) => {
      receivedToken = new Headers(init?.headers).get('x-nax-token') || ''
      return new Response(JSON.stringify({
        ok: true,
        version: record.version,
        projectId: record.projectId,
        projectRoot: record.projectRoot,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.equal(discovered?.instanceId, record.instanceId)
  assert.equal(receivedToken, record.token)
})

test('discovery removes dead records and redacts tokens from unreachable errors', async () => {
  const projectRoot = tempRoot()
  const registry = { tempDir: tempRoot(), userId: 'test-user', env: {} }
  const record = recordFor(projectRoot)
  writeDashboardInstance(record, registry)

  assert.equal(await discoverDashboardInstance({ projectRoot, registry, isProcessAlive: () => false }), null)
  assert.equal(readDashboardInstance(projectRoot, registry), null)

  writeDashboardInstance(record, registry)
  await assert.rejects(
    discoverDashboardInstance({ projectRoot, registry, isProcessAlive: () => true, fetchImpl: async () => { throw new Error(record.token) } }),
    /** @param {unknown} error */ (error) => {
      assert.equal(error instanceof DashboardRegistryError && error.code === 'dashboard_unreachable', true)
      assert.doesNotMatch(String(error), new RegExp(record.token))
      return true
    },
  )
})

test('discovery rejects project and version mismatches without exposing the token', async () => {
  const projectRoot = tempRoot()
  const registry = { tempDir: tempRoot(), userId: 'test-user', env: {} }
  const record = recordFor(projectRoot)
  writeDashboardInstance(record, registry)

  await assert.rejects(
    discoverDashboardInstance({ projectRoot, registry, expectedVersion: '999.0.0', isProcessAlive: () => true }),
    /** @param {unknown} error */ (error) => error instanceof DashboardRegistryError && error.code === 'dashboard_version_mismatch',
  )
  await assert.rejects(
    discoverDashboardInstance({
      projectRoot,
      registry,
      isProcessAlive: () => true,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, version: record.version, projectId: 'project_wrong', projectRoot: record.projectRoot }), { status: 200 }),
    }),
    /** @param {unknown} error */ (error) => error instanceof DashboardRegistryError && error.code === 'project_scope_mismatch',
  )
})
