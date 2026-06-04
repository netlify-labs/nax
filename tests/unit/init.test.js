const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  WORKFLOW_PATH,
  defaultSiteName,
  enableGitHubActionsSetup,
  ensureNaxGitignore,
  ensureNetlifyProject,
  ensureWorkflow,
  findExistingAgentRunnerWorkflow,
  initProject,
  listGitHubSecretNames,
  readLinkedSiteId,
  readNetlifyCliToken,
  setGitHubSecret,
  siteIdFromStatus,
} = require('../../src/init')

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

test('findExistingAgentRunnerWorkflow detects the action under any filename', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const workflowsDir = path.join(tmp, '.github', 'workflows')
  fs.mkdirSync(workflowsDir, { recursive: true })
  fs.writeFileSync(path.join(workflowsDir, 'unrelated.yml'), 'name: CI\n')
  fs.writeFileSync(path.join(workflowsDir, 'agents.yml'), 'jobs:\n  go:\n    steps:\n      - uses: netlify-labs/agent-runner-action@v1\n')

  const result = findExistingAgentRunnerWorkflow(tmp)
  assert.ok(result)
  assert.equal(path.basename(result.path), 'agents.yml')
})

test('findExistingAgentRunnerWorkflow returns null when no workflow references the action', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const workflowsDir = path.join(tmp, '.github', 'workflows')
  fs.mkdirSync(workflowsDir, { recursive: true })
  fs.writeFileSync(path.join(workflowsDir, 'ci.yaml'), 'name: CI\n')

  assert.equal(findExistingAgentRunnerWorkflow(tmp), null)
})

test('findExistingAgentRunnerWorkflow returns null when workflows dir is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  assert.equal(findExistingAgentRunnerWorkflow(tmp), null)
})

test('ensureWorkflow skips install when an agent-runner workflow already exists at a different filename', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const workflowsDir = path.join(tmp, '.github', 'workflows')
  fs.mkdirSync(workflowsDir, { recursive: true })
  const customPath = path.join(workflowsDir, 'agents.yml')
  fs.writeFileSync(customPath, 'jobs:\n  go:\n    steps:\n      - uses: netlify-labs/agent-runner-action@v1\n')

  const result = ensureWorkflow({ projectRoot: tmp })
  assert.equal(result.status, 'exists')
  assert.equal(result.path, customPath)
  assert.equal(fs.existsSync(path.join(tmp, WORKFLOW_PATH)), false)
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

test('enableGitHubActionsSetup creates workflow even when gh is not installed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  fs.mkdirSync(path.join(tmp, '.git'))

  const result = enableGitHubActionsSetup({
    projectRoot: tmp,
    repo: 'netlify-labs/nax',
    netlify: { siteId: 'site-123', status: 'exists' },
    hasGitHubCli: () => false,
  })

  assert.equal(result.githubActions, true)
  assert.equal(result.workflow.status, 'created')
  assert.equal(fs.existsSync(path.join(tmp, WORKFLOW_PATH)), true)
  assert.deepEqual(result.secrets.map((secret) => [secret.name, secret.status]), [
    ['NETLIFY_SITE_ID', 'skipped'],
    ['NETLIFY_AUTH_TOKEN', 'skipped'],
  ])
  assert.match(result.secrets[0].reason, /GitHub CLI is required/)
})

test('enableGitHubActionsSetup creates workflow when gh auth fails and reports skipped secrets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  fs.mkdirSync(path.join(tmp, '.git'))

  const result = enableGitHubActionsSetup({
    projectRoot: tmp,
    repo: 'netlify-labs/nax',
    netlify: { siteId: 'site-123', status: 'exists' },
    hasGitHubCli: () => true,
    checkGitHubAuth() {
      throw new Error('GitHub CLI authentication check failed: Run gh auth login')
    },
  })

  assert.equal(result.githubActions, true)
  assert.equal(result.workflow.status, 'created')
  assert.equal(result.repo, 'netlify-labs/nax')
  assert.deepEqual(result.secrets.map((secret) => [secret.name, secret.status]), [
    ['NETLIFY_SITE_ID', 'skipped'],
    ['NETLIFY_AUTH_TOKEN', 'skipped'],
  ])
  assert.match(result.secrets[0].reason, /gh auth login/)
})

test('listGitHubSecretNames reads repo secret names', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const calls = []
  const names = listGitHubSecretNames({
    projectRoot: tmp,
    repo: 'netlify-labs/nax',
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify([{ name: 'NETLIFY_SITE_ID' }, { name: 'NETLIFY_AUTH_TOKEN' }]) }
    },
  })

  assert.deepEqual([...names].sort(), ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'])
  assert.equal(calls[0].command, 'gh')
  assert.deepEqual(calls[0].args, ['secret', 'list', '--repo', 'netlify-labs/nax', '--json', 'name'])
  assert.equal(calls[0].options.cwd, tmp)
})

test('setGitHubSecret skips existing secrets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const calls = []
  const result = setGitHubSecret({
    projectRoot: tmp,
    repo: 'netlify-labs/nax',
    name: 'NETLIFY_SITE_ID',
    value: 'site-123',
    existingSecrets: new Set(['NETLIFY_SITE_ID']),
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: '' }
    },
  })

  assert.deepEqual(result, { name: 'NETLIFY_SITE_ID', status: 'exists' })
  assert.deepEqual(calls, [])
})

test('setGitHubSecret sets missing secrets and records them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const calls = []
  const existingSecrets = new Set()
  const result = setGitHubSecret({
    projectRoot: tmp,
    repo: 'netlify-labs/nax',
    name: 'NETLIFY_AUTH_TOKEN',
    value: 'token-123',
    existingSecrets,
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0, stdout: '' }
    },
  })

  assert.deepEqual(result, { name: 'NETLIFY_AUTH_TOKEN', status: 'set' })
  assert.equal(existingSecrets.has('NETLIFY_AUTH_TOKEN'), true)
  assert.equal(calls[0].command, 'gh')
  assert.deepEqual(calls[0].args, ['secret', 'set', 'NETLIFY_AUTH_TOKEN', '--repo', 'netlify-labs/nax'])
  assert.equal(calls[0].options.cwd, tmp)
  assert.equal(calls[0].options.input, 'token-123')
})

test('ensureNaxGitignore creates gitignore with .nax entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const result = ensureNaxGitignore({ projectRoot: tmp })

  assert.equal(result.status, 'created')
  assert.equal(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8'), '.nax/\n')
})

test('ensureNaxGitignore appends .nax entry without duplicating it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-init-test-'))
  const gitignorePath = path.join(tmp, '.gitignore')
  fs.writeFileSync(gitignorePath, 'node_modules/\n')

  assert.equal(ensureNaxGitignore({ projectRoot: tmp }).status, 'updated')
  assert.match(fs.readFileSync(gitignorePath, 'utf8'), /# Added by nax init\n\.nax\/\n$/)
  assert.equal(ensureNaxGitignore({ projectRoot: tmp }).status, 'exists')
  assert.equal((fs.readFileSync(gitignorePath, 'utf8').match(/\.nax\/?/g) || []).length, 1)
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
