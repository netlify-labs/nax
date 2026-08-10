const test = require('node:test')
const assert = require('node:assert/strict')

const { DashboardAutostartError, autostartEnabled, ensureDashboardRunning } = require('../../src/mcp/autostart')

const immediateWait = () => Promise.resolve()

test('does not launch when a dashboard is already advertised', async () => {
  let launches = 0
  const result = await ensureDashboardRunning({
    projectRoot: '/p',
    discover: async () => ({ instanceId: 'abc' }),
    launch: () => { launches += 1 },
    wait: immediateWait,
  })
  assert.deepEqual(result, { started: false })
  assert.equal(launches, 0)
})

test('launches once and resolves when the dashboard becomes healthy', async () => {
  let launches = 0
  let polls = 0
  const result = await ensureDashboardRunning({
    projectRoot: '/p',
    // null (none) at first, then healthy after the dashboard "boots".
    discover: async () => {
      polls += 1
      return polls >= 3 ? { instanceId: 'abc' } : null
    },
    launch: () => { launches += 1 },
    wait: immediateWait,
    now: () => 0,
    timeoutMs: 30000,
  })
  assert.deepEqual(result, { started: true })
  assert.equal(launches, 1)
})

test('opt-out is a pure no-op: no probe, no launch (adapter handles no-dashboard)', async () => {
  let discovers = 0
  const result = await ensureDashboardRunning({
    projectRoot: '/p',
    discover: async () => { discovers += 1; return null },
    launch: () => assert.fail('must not launch when autostart is disabled'),
    autostart: false,
    wait: immediateWait,
  })
  assert.deepEqual(result, { started: false })
  assert.equal(discovers, 0)
})

test('times out with a clear error when the dashboard never becomes healthy', async () => {
  let clock = 0
  await assert.rejects(
    ensureDashboardRunning({
      projectRoot: '/p',
      discover: async () => null,
      launch: () => {},
      wait: immediateWait,
      now: () => (clock += 10000), // advances past a 30s deadline within a few polls
      timeoutMs: 30000,
    }),
    (err) => err instanceof DashboardAutostartError && err.code === 'dashboard_autostart_timeout',
  )
})

test('a throwing first discover surfaces (e.g. version mismatch), no launch', async () => {
  await assert.rejects(
    ensureDashboardRunning({
      projectRoot: '/p',
      discover: async () => { throw new Error('dashboard_version_mismatch') },
      launch: () => assert.fail('must not launch on a hard discovery error'),
      wait: immediateWait,
    }),
    /dashboard_version_mismatch/,
  )
})

test('autostartEnabled honors NAX_MCP_AUTOSTART opt-out values', () => {
  assert.equal(autostartEnabled({}), true)
  assert.equal(autostartEnabled({ NAX_MCP_AUTOSTART: '1' }), true)
  assert.equal(autostartEnabled({ NAX_MCP_AUTOSTART: '0' }), false)
  assert.equal(autostartEnabled({ NAX_MCP_AUTOSTART: 'false' }), false)
  assert.equal(autostartEnabled({ NAX_MCP_AUTOSTART: 'off' }), false)
})
