const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  WORKFLOW_PATH,
  defaultSiteName,
  ensureNetlifyProject,
  ensureWorkflow,
  initProject,
  readLinkedSiteId,
  readNetlifyCliToken,
  siteIdFromStatus,
} = require('../lib/init')

test('readLinkedSiteId reads .netlify/state.json and env wins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  fs.mkdirSync(path.join(tmp, '.netlify'))
  fs.writeFileSync(path.join(tmp, '.netlify', 'state.json'), JSON.stringify({ siteId: 'site-from-file' }))

  assert.equal(readLinkedSiteId(tmp, {}), 'site-from-file')
  assert.equal(readLinkedSiteId(tmp, { NETLIFY_SITE_ID: 'site-from-env' }), 'site-from-env')
})

test('readNetlifyCliToken reads env before config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-home-'))
  const configDir = path.join(home, 'Library', 'Preferences', 'netlify')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    userId: 'u1',
    users: {
      u1: { auth: { token: 'token-from-config' } },
    },
  }))

  assert.deepEqual(readNetlifyCliToken({ env: { NETLIFY_AUTH_TOKEN: 'token-from-env' }, home }), {
    token: 'token-from-env',
    source: 'NETLIFY_AUTH_TOKEN',
  })
  assert.equal(readNetlifyCliToken({ env: {}, home }).token, 'token-from-config')
})

test('readNetlifyCliToken reads Linux XDG config path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-home-'))
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-xdg-'))
  const configDir = path.join(xdg, 'netlify')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    userId: 'u1',
    users: {
      u1: { auth: { token: 'token-from-xdg' } },
    },
  }))

  assert.deepEqual(readNetlifyCliToken({ env: { XDG_CONFIG_HOME: xdg }, home }), {
    token: 'token-from-xdg',
    source: path.join(configDir, 'config.json'),
  })
})

test('ensureWorkflow creates workflow from bundled template and preserves existing nax workflow', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const result = ensureWorkflow({ projectRoot: tmp })
  const workflowPath = path.join(tmp, WORKFLOW_PATH)

  assert.equal(result.status, 'created')
  assert.equal(result.path, workflowPath)
  assert.match(fs.readFileSync(workflowPath, 'utf8'), /netlify-labs\/agent-runner-action@v1/)
  assert.equal(ensureWorkflow({ projectRoot: tmp }).status, 'exists')
})

test('ensureWorkflow rejects existing unrelated workflow unless force is set', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const workflowPath = path.join(tmp, WORKFLOW_PATH)
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true })
  fs.writeFileSync(workflowPath, 'name: Existing\n')

  assert.throws(() => ensureWorkflow({ projectRoot: tmp }), /already exists/)
  assert.equal(ensureWorkflow({ projectRoot: tmp, force: true, dryRun: true }).status, 'replaced')
  assert.equal(fs.readFileSync(workflowPath, 'utf8'), 'name: Existing\n')
})

test('siteIdFromStatus and defaultSiteName normalize expected values', () => {
  assert.equal(siteIdFromStatus({ siteData: { 'site-id': 'site-123' } }), 'site-123')
  assert.equal(defaultSiteName('/tmp/ignored', 'netlify-labs/Gmail Emailer'), 'gmail-emailer')
})

test('ensureNetlifyProject supports dry create without a real site id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const result = ensureNetlifyProject({
    projectRoot: tmp,
    repo: 'netlify-labs/example-app',
    create: true,
    dryRun: true,
  })

  assert.equal(result.status, 'would-create')
  assert.equal(result.siteName, 'example-app')
})

test('ensureNetlifyProject delegates default interactive setup to netlify init', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const calls = []
  const notices = []
  let initialized = false

  const result = ensureNetlifyProject({
    projectRoot: tmp,
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      initialized = true
      return { status: 0 }
    },
    readProject() {
      return initialized
        ? {
            siteId: 'site-after-init',
            siteName: 'after-init',
            adminUrl: 'https://app.netlify.com/projects/after-init',
            accountName: 'Netlify Labs',
          }
        : null
    },
    initNotice(projectRoot) {
      notices.push(projectRoot)
    },
  })

  assert.equal(result.status, 'initialized')
  assert.equal(result.siteId, 'site-after-init')
  assert.deepEqual(notices, [tmp])
  assert.deepEqual(calls.map((call) => call.args), [['init']])
  assert.equal(calls[0].command, 'netlify')
  assert.equal(calls[0].options.stdio, 'inherit')
})

test('initProject can skip GitHub Actions setup after site linking', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  fs.mkdirSync(path.join(tmp, '.git'))

  const result = initProject({
    projectRoot: tmp,
    siteId: 'site-123',
    githubActions: false,
    dryRun: true,
  })

  assert.equal(result.githubActions, false)
  assert.equal(result.repo, '')
  assert.equal(result.netlify.status, 'would-link')
  assert.equal(result.workflow, null)
  assert.deepEqual(result.secrets, [])
})

test('initProject dry-run does not require netlify binary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  fs.mkdirSync(path.join(tmp, '.git'))

  const restorePath = process.env.PATH
  process.env.PATH = ''
  try {
    assert.doesNotThrow(() => initProject({
      projectRoot: tmp,
      siteId: 'site-123',
      githubActions: false,
      dryRun: true,
    }))
  } finally {
    process.env.PATH = restorePath
  }
})
