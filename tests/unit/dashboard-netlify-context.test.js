const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  formatDashboardNetlifyContext,
  resolveDashboardNetlifyContext,
} = require('../../src/integrations/netlify/dashboard-context')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-netlify-context-'))
}

/** @param {string} dir @param {string} siteId */
function writeSiteState(dir, siteId) {
  fs.mkdirSync(path.join(dir, '.netlify'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.netlify', 'state.json'), JSON.stringify({ siteId }))
}

/** @param {string} dir @param {string} command */
function writeNetlifyConfig(dir, command = '') {
  fs.mkdirSync(dir, { recursive: true })
  const build = command ? `[build]\n  command = "${command}"\n` : '[build]\n  publish = "public"\n'
  fs.writeFileSync(path.join(dir, 'netlify.toml'), build)
}

test('dashboard Netlify context names all links and explains the exact runner target', async () => {
  const projectRoot = tmpRoot()
  const agentRouterDir = path.join(projectRoot, 'clients', 'agent-router')
  const frontendDir = path.join(projectRoot, 'clients', 'frontend')
  const notifyDir = path.join(projectRoot, 'clients', 'notify-demo')
  writeSiteState(projectRoot, 'notify-site')
  writeNetlifyConfig(agentRouterDir, 'pnpm build')
  writeSiteState(agentRouterDir, 'router-site')
  writeNetlifyConfig(frontendDir, 'pnpm --filter revenue-engine-frontend build:netlify')
  writeSiteState(frontendDir, 'frontend-site')
  writeNetlifyConfig(notifyDir)

  const siteNames = new Map([
    ['notify-site', 're-notify-demo'],
    ['router-site', 'agent-router'],
    ['frontend-site', 'revenue-engine-dev'],
  ])
  const context = await resolveDashboardNetlifyContext({
    projectRoot,
    env: {},
    chooseTarget: async () => ({
      filter: 'revenue-engine-frontend',
      netlifyConfig: path.join('clients', 'frontend', 'netlify.toml'),
      netlifySiteId: 'frontend-site',
      netlifySiteSource: path.join('clients', 'frontend', '.netlify', 'state.json'),
    }),
    checkAccess: async ({ siteId }) => ({
      ok: true,
      code: 'ok',
      message: `Access to ${siteId}`,
      account: { email: 'david@example.com' },
      site: {
        id: siteId,
        name: siteNames.get(siteId) || siteId,
        accountSlug: 'team',
      },
    }),
  })

  assert.equal(context.account.email, 'david@example.com')
  assert.deepEqual(context.linkedSites.map(({ name, source }) => ({ name, source })), [
    {
      name: 'agent-router',
      source: path.join('clients', 'agent-router', '.netlify', 'state.json'),
    },
    {
      name: 're-notify-demo',
      source: path.join('.netlify', 'state.json'),
    },
    {
      name: 'revenue-engine-dev',
      source: path.join('clients', 'frontend', '.netlify', 'state.json'),
    },
  ])
  assert.equal(context.target.name, 'revenue-engine-dev')
  assert.equal(context.target.siteId, 'frontend-site')
  assert.equal(context.target.filter, 'revenue-engine-frontend')
  assert.match(context.target.reason, /only detected config with a monorepo filter/)
  assert.match(context.target.adminUrl, /projects\/revenue-engine-dev\/agent-runs$/)

  const output = formatDashboardNetlifyContext(context).join('\n')
  assert.match(output, /Agent Runner site: revenue-engine-dev/)
  assert.match(output, /re-notify-demo — \.netlify\/state\.json/)
  assert.match(output, /revenue-engine-dev .*Agent Runner target/)
})
