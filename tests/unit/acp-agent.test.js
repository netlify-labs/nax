const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createNaxAcpAgent, listAcpSites, promptText, resolveAcpSite, verifyAcpSiteRepo } = require('../../src/integrations/acp/agent')
const { createNaxAgentRunnerSdk } = require('../../src/integrations/netlify/agent-runner-sdk')
const { loadAcpSession } = require('../../src/integrations/acp/session-store')
const { appendPatch, clonedRepo, git, runnerApi } = require('../fixtures/acp/harness')

/**
 * @param {string} cwd
 * @param {ReturnType<typeof runnerApi>} remote
 * @param {Record<string, unknown>} [overrides]
 */
function harness(cwd, remote, overrides = {}) {
  const updates = []
  const agent = createNaxAcpAgent({
    createSdk: () => createNaxAgentRunnerSdk({ transport: remote.transport, promptBlobDisable: true, retryDelayMs: 0 }),
    createApi: () => remote.api,
    resolveSite: () => ({ projectRoot: cwd, siteId: 'site-1' }),
    sendUpdate: async (sessionId, update) => { updates.push({ sessionId, ...update }) },
    sleep: async () => {},
    pollIntervalMs: 0,
    newSessionId: () => 'nax-test',
    version: '0.0.0-test',
    verifySiteRepo: async () => {},
    ...overrides,
  })
  return { agent, updates }
}

/** @param {Array<Record<string, any>>} updates @param {string} kind */
function messages(updates, kind = 'agent_message_chunk') {
  return updates.filter((update) => update.sessionUpdate === kind).map((update) => update.content.text).join('')
}

/** @param {string} text @returns {Array<{ type: 'text', text: string }>} */
function promptOf(text) {
  return [{ type: 'text', text }]
}

test('initialize advertises session loading and text prompts', async () => {
  const { agent } = harness(clonedRepo(), runnerApi({ scripts: {} }))
  const response = await agent.initialize({ protocolVersion: 1 })
  assert.equal(response.protocolVersion, 1)
  assert.equal(response.agentCapabilities.loadSession, true)
  assert.equal(response.agentCapabilities.promptCapabilities.image, false)
  assert.deepEqual(response.authMethods, [])
  assert.equal(response.agentInfo.name, 'nax')
})

test('new session returns config options without touching the site or the disk', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-acp-unlinked-'))
  let resolved = 0
  const { agent } = harness(cwd, runnerApi({ scripts: {} }), {
    resolveSite: () => {
      resolved += 1
      throw new Error('No linked Netlify site')
    },
  })
  const response = await agent.newSession({ cwd, mcpServers: [] })
  assert.equal(response.sessionId, 'nax-test')
  assert.deepEqual(response.configOptions.map((option) => option.id), ['model', 'effort', 'changes'])
  await agent.setConfigOption({ sessionId: 'nax-test', configId: 'changes', value: 'pr' })
  assert.equal(resolved, 0, 'clients probing for models never trigger site discovery')
  assert.deepEqual(fs.readdirSync(cwd), [], 'probe sessions leave no files behind')
  await assert.rejects(agent.prompt({ sessionId: 'nax-test', prompt: promptOf('hi') }), /No linked Netlify site/)
})

test('first prompt saves the session with its site', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'done', resultText: 'Hi.', hasResultDiff: false }] } })
  const { agent } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  assert.equal(loadAcpSession(cwd, 'nax-test'), null)
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('hi') })
  const record = loadAcpSession(cwd, 'nax-test')
  assert.equal(record.siteId, 'site-1')
  assert.equal(record.branch, 'main')
})

test('first prompt starts a runner on the pushed branch, streams progress, and applies its diff', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({
    scripts: {
      'session-1': [
        { state: 'running', currentTask: 'Reading readme.md' },
        { state: 'running', currentTask: 'Editing readme.md' },
        { state: 'done', resultText: 'Added a world line.', hasResultDiff: true },
      ],
    },
    patches: { 'session-1': appendPatch('world') },
  })
  const { agent, updates } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await agent.setConfigOption({ sessionId: 'nax-test', configId: 'model', value: 'claude:claude-opus-5' })
  await agent.setConfigOption({ sessionId: 'nax-test', configId: 'effort', value: 'high' })

  const response = await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Add a world line') })

  assert.deepEqual(response, { stopReason: 'end_turn' })
  const created = remote.calls.find((call) => call.op === 'createRunner').input
  assert.match(created.prompt, /^Add a world line/)
  assert.equal(created.siteId, 'site-1')
  assert.equal(created.agent, 'claude')
  assert.equal(created.model, 'claude-opus-5')
  assert.equal(created.effort, 'high')
  assert.equal(created.branch, 'main')

  const toolCall = updates.find((update) => update.sessionUpdate === 'tool_call')
  assert.equal(toolCall.status, 'in_progress')
  assert.match(toolCall.content[0].content.text, /https:\/\/app\.netlify\.com\/projects\/my-site\/agent-runs\/runner-1\?session=session-1/)
  const steps = updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'in_progress')
    .map((update) => update.title)
  assert.deepEqual(steps, ['Reading readme.md', 'Editing readme.md'])
  assert.equal(updates.filter((update) => update.sessionUpdate === 'tool_call_update').at(-1).status, 'completed')

  assert.match(messages(updates), /Added a world line\./)
  assert.match(messages(updates), /Applied changes to 1 file: readme\.md/)
  assert.equal(fs.readFileSync(path.join(cwd, 'readme.md'), 'utf8'), 'hello\nworld\n')

  const record = loadAcpSession(cwd, 'nax-test')
  assert.ok(record.handle, 'the runner handle is saved for follow-ups and reloads')
  assert.deepEqual(record.transcript.map((entry) => entry.role), ['user', 'agent'])
  assert.equal(record.transcript[0].text, 'Add a world line')
})

test('later prompts are follow-up sessions that apply only their own diff', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({
    scripts: {
      'session-1': [{ state: 'done', resultText: 'First.', hasResultDiff: true }],
      'session-2': [{ state: 'done', resultText: 'Second.', hasResultDiff: true }],
    },
    patches: {
      'session-1': appendPatch('one'),
      'session-2': [
        'diff --git a/readme.md b/readme.md',
        '--- a/readme.md',
        '+++ b/readme.md',
        '@@ -1,2 +1,3 @@',
        ' hello',
        ' one',
        '+two',
        '',
      ].join('\n'),
    },
  })
  const { agent } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Add one') })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Add two') })

  const followUp = remote.calls.find((call) => call.op === 'createSession')
  assert.equal(followUp.runnerId, 'runner-1')
  assert.match(String(followUp.input.prompt), /^Add two/)
  assert.equal(remote.calls.filter((call) => call.op === 'createRunner').length, 1)
  assert.equal(fs.readFileSync(path.join(cwd, 'readme.md'), 'utf8'), 'hello\none\ntwo\n')
})

test('warns before the first turn when local work is invisible to the runner', async () => {
  const cwd = clonedRepo()
  fs.writeFileSync(path.join(cwd, 'readme.md'), 'local edit\n')
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'done', resultText: 'Nothing to do.', hasResultDiff: false }] } })
  const { agent, updates } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Check it') })
  assert.match(messages(updates), /Uncommitted local changes are not visible to the agent runner/)
  assert.doesNotMatch(messages(updates), /Applied changes/)
  assert.equal(remote.calls.some((call) => call.op === 'request'), false, 'an unchanged result fetches no diff')
})

test('a diff that does not apply is saved for review and the workspace is untouched', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({
    scripts: { 'session-1': [{ state: 'done', resultText: 'Edited.', hasResultDiff: true }] },
    patches: { 'session-1': appendPatch('world') },
  })
  const { agent, updates } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  fs.writeFileSync(path.join(cwd, 'readme.md'), 'diverged\n')
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Edit') })

  const patchPath = path.join(cwd, '.nax', 'acp-sessions', 'nax-test', 'session-1.patch')
  assert.equal(fs.readFileSync(patchPath, 'utf8'), appendPatch('world'))
  assert.match(messages(updates), /did not apply to the local workspace/)
  assert.ok(messages(updates).includes(patchPath))
  assert.equal(fs.readFileSync(path.join(cwd, 'readme.md'), 'utf8'), 'diverged\n')
})

test('pull request mode opens a PR and leaves the workspace alone', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({
    scripts: { 'session-1': [{ state: 'done', resultText: 'Edited.', hasResultDiff: true }] },
    patches: { 'session-1': appendPatch('world') },
  })
  const { agent, updates } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await agent.setConfigOption({ sessionId: 'nax-test', configId: 'changes', value: 'pr' })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Edit') })

  assert.ok(remote.calls.some((call) => call.op === 'member' && call.action === 'pull_request'))
  assert.match(messages(updates), /Pull request: https:\/\/github\.com\/acme\/site\/pull\/7/)
  assert.equal(fs.readFileSync(path.join(cwd, 'readme.md'), 'utf8'), 'hello\n')
})

test('cancel stops the runner and ends the turn as cancelled', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'running', currentTask: 'Thinking' }] } })
  let agent
  let polls = 0
  ;({ agent } = harness(cwd, remote, {
    sleep: async () => {
      polls += 1
      if (polls === 2) await agent.cancel({ sessionId: 'nax-test' })
    },
  }))
  await agent.newSession({ cwd, mcpServers: [] })
  const response = await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Long task') })
  assert.deepEqual(response, { stopReason: 'cancelled' })
  assert.ok(remote.calls.some((call) => call.op === 'cancelRunner' || call.op === 'cancelSession'))
})

test('a failed run rejects the prompt with the runner failure', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'error', resultText: 'Build tooling crashed' }] } })
  const { agent } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await assert.rejects(
    agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Do it') }),
    /Netlify agent runner runner-1 failed/,
  )
})

test('loading a session replays its transcript and restores its config', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'done', resultText: 'Answer.', hasResultDiff: false }] } })
  const first = harness(cwd, remote)
  await first.agent.newSession({ cwd, mcpServers: [] })
  await first.agent.setConfigOption({ sessionId: 'nax-test', configId: 'changes', value: 'pr' })
  await first.agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Question?') })

  const second = harness(cwd, remote)
  const response = await second.agent.loadSession({ sessionId: 'nax-test', cwd, mcpServers: [] })
  assert.equal(response.configOptions.find((option) => option.id === 'changes').currentValue, 'pr')
  assert.deepEqual(second.updates.map((update) => [update.sessionUpdate, update.content.text]), [
    ['user_message_chunk', 'Question?'],
    ['agent_message_chunk', 'Answer.'],
  ])
})

test('prompting an unknown session fails clearly', async () => {
  const { agent } = harness(clonedRepo(), runnerApi({ scripts: {} }))
  await assert.rejects(agent.prompt({ sessionId: 'nax-nope', prompt: promptOf('hi') }), /Unknown ACP session nax-nope/)
})

test('site discovery refuses folders outside a git repository instead of scanning them', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-acp-nogit-'))
  assert.throws(() => resolveAcpSite(outside), /is not inside a git repository/)
})

test('prompt text drops instructions the ACP client wrote for its own tools', () => {
  const text = promptText([{
    type: 'text',
    text: '<t3_code_instructions>\n## T3 Code browser\nUse preview_* tools.\n</t3_code_instructions>\n\nFix the header',
  }])
  assert.equal(text, 'Fix the header')
})

test('runner file links point at the local repository instead of the runner checkout', async () => {
  const cwd = clonedRepo()
  const repoRoot = git(cwd, ['rev-parse', '--show-toplevel'])
  const remote = runnerApi({
    scripts: {
      'session-1': [{
        state: 'done',
        hasResultDiff: false,
        resultText: '[nax.js](/opt/build/repo/src/cli/nax.js) and /opt/build/repo/readme.md, root /opt/build/repo.',
      }],
    },
  })
  const { agent, updates } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Where?') })
  assert.equal(
    messages(updates),
    `[nax.js](${repoRoot}/src/cli/nax.js) and ${repoRoot}/readme.md, root ${repoRoot}.`,
  )
})

test('a session opened in a subfolder applies changes anywhere in the repository', async () => {
  const root = clonedRepo()
  const cwd = path.join(root, 'app')
  fs.mkdirSync(cwd)
  const remote = runnerApi({
    scripts: { 'session-1': [{ state: 'done', resultText: 'Edited.', hasResultDiff: true }] },
    patches: { 'session-1': appendPatch('world') },
  })
  const { agent, updates } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('Edit the root readme') })
  assert.match(messages(updates), /Applied changes to 1 file: readme\.md/)
  assert.equal(fs.readFileSync(path.join(root, 'readme.md'), 'utf8'), 'hello\nworld\n')
})

test('a repository with several linked sites asks for one before starting a runner', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'done', resultText: 'Done.', hasResultDiff: false }] } })
  const sites = [
    { siteId: 'site-a', label: 'sites/a', dir: path.join(cwd, 'sites', 'a') },
    { siteId: 'site-b', label: 'sites/b', dir: path.join(cwd, 'sites', 'b') },
  ]
  const { agent } = harness(cwd, remote, {
    listSites: () => sites,
    resolveSite: () => { throw new Error('No Netlify site is linked') },
  })
  const created = await agent.newSession({ cwd, mcpServers: [] })
  assert.equal(created.configOptions.find((option) => option.id === 'site').currentValue, 'choose')
  await assert.rejects(
    agent.prompt({ sessionId: 'nax-test', prompt: promptOf('hi') }),
    /This repository links 2 Netlify sites\. Choose one in the Netlify site option: sites\/a, sites\/b/,
  )
  await agent.setConfigOption({ sessionId: 'nax-test', configId: 'site', value: 'site-b' })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('hi') })
  assert.equal(remote.calls.find((call) => call.op === 'createRunner').input.siteId, 'site-b')

  const reloaded = harness(cwd, remote, { listSites: () => sites, resolveSite: () => { throw new Error('No Netlify site is linked') } })
  const loaded = await reloaded.agent.loadSession({ sessionId: 'nax-test', cwd, mcpServers: [] })
  assert.equal(loaded.configOptions.find((option) => option.id === 'site').currentValue, 'site-b')
})

test('a session opened inside a linked site defaults to that site', async () => {
  const cwd = clonedRepo()
  const inside = path.join(cwd, 'sites', 'b', 'src')
  fs.mkdirSync(inside, { recursive: true })
  const sites = [
    { siteId: 'site-a', label: 'sites/a', dir: path.join(cwd, 'sites', 'a') },
    { siteId: 'site-b', label: 'sites/b', dir: path.join(cwd, 'sites', 'b') },
  ]
  const { agent } = harness(inside, runnerApi({ scripts: {} }), { listSites: () => sites })
  const created = await agent.newSession({ cwd: inside, mcpServers: [] })
  assert.equal(created.configOptions.find((option) => option.id === 'site').currentValue, 'site-b')
})

/** @param {Record<string, unknown> | null} site */
function siteApi(site) {
  return {
    async requestResponse(_method, apiPath) {
      return site
        ? { ok: true, status: 200, text: JSON.stringify(site), payload: site, apiPath }
        : { ok: false, status: 404, text: 'Not Found', payload: null, apiPath }
    },
  }
}

test('a site building the same repository passes, whatever URL form each side uses', async () => {
  const cwd = clonedRepo()
  git(cwd, ['remote', 'set-url', 'origin', 'git@github.com:netlify-labs/gtm-services.git'])
  const api = siteApi({ name: 'gtm-services', build_settings: { repo_url: 'https://github.com/netlify-labs/gtm-services' } })
  await verifyAcpSiteRepo({ api, siteId: 'site-1', repoRoot: cwd })
})

test('a site that builds another repository is refused', async () => {
  const cwd = clonedRepo()
  git(cwd, ['remote', 'set-url', 'origin', 'git@github.com:netlify-labs/gtm-services.git'])
  const api = siteApi({ name: 'research-report', build_settings: { repo_url: 'https://hgit.example.net/apps/pqa.git' } })
  await assert.rejects(
    verifyAcpSiteRepo({ api, siteId: 'site-1', repoRoot: cwd }),
    /Netlify site research-report builds hgit\.example\.net\/apps\/pqa, not github\.com\/netlify-labs\/gtm-services/,
  )
})

test('a site with no connected repository is refused', async () => {
  const cwd = clonedRepo()
  git(cwd, ['remote', 'set-url', 'origin', 'https://github.com/netlify-labs/gtm-services.git'])
  const api = siteApi({ name: 'fleet-docs', build_settings: {} })
  await assert.rejects(
    verifyAcpSiteRepo({ api, siteId: 'site-1', repoRoot: cwd }),
    /Netlify site fleet-docs is not connected to a git repository/,
  )
})

test('the first prompt refuses a site that does not build this repository, and starts no runner', async () => {
  const cwd = clonedRepo()
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'done', resultText: 'Done.', hasResultDiff: false }] } })
  const { agent } = harness(cwd, remote, {
    verifySiteRepo: async () => { throw new Error('Netlify site x builds another repository') },
  })
  await agent.newSession({ cwd, mcpServers: [] })
  await assert.rejects(agent.prompt({ sessionId: 'nax-test', prompt: promptOf('hi') }), /builds another repository/)
  assert.equal(remote.calls.some((call) => call.op === 'createRunner'), false)
})

test('linked sites are listed once each, with the root link named for people', () => {
  const cwd = clonedRepo()
  /** @param {string} dir @param {string} siteId */
  const link = (dir, siteId) => {
    fs.mkdirSync(path.join(cwd, dir, '.netlify'), { recursive: true })
    fs.writeFileSync(path.join(cwd, dir, '.netlify', 'state.json'), JSON.stringify({ siteId }))
  }
  link('.', 'site-root')
  link('sites/docs', 'site-docs')
  link('sites/platform', 'site-docs')
  assert.deepEqual(listAcpSites(cwd).map((site) => [site.label, site.siteId]), [
    ['repository root', 'site-root'],
    ['sites/docs, sites/platform', 'site-docs'],
  ])
})

test('prompt text drops the client runtime and pull request tool blocks', () => {
  const text = promptText([{
    type: 'text',
    text: '<user_request>Ship it</user_request><runtime_info>You run in T3.</runtime_info>\n\n<pull_request_linking>Call link_pull_request.</pull_request_linking>',
  }])
  assert.equal(text, '<user_request>Ship it</user_request>')
})

test('the first turn tells the runner about local work it cannot see; later turns do not', async () => {
  const cwd = clonedRepo()
  fs.writeFileSync(path.join(cwd, 'readme.md'), 'local edit\n')
  const remote = runnerApi({
    scripts: {
      'session-1': [{ state: 'done', resultText: 'One.', hasResultDiff: false }],
      'session-2': [{ state: 'done', resultText: 'Two.', hasResultDiff: false }],
    },
  })
  const { agent } = harness(cwd, remote)
  await agent.newSession({ cwd, mcpServers: [] })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('What is WIP?') })
  await agent.prompt({ sessionId: 'nax-test', prompt: promptOf('And now?') })

  const first = String(remote.calls.find((call) => call.op === 'createRunner').input.prompt)
  assert.match(first, /^What is WIP\?\n\n<local_workspace>/)
  assert.match(first, /1 uncommitted file you cannot see: readme\.md/)
  const followUp = String(remote.calls.find((call) => call.op === 'createSession').input.prompt)
  assert.doesNotMatch(followUp, /local_workspace/)
  assert.equal(loadAcpSession(cwd, 'nax-test').transcript[0].text, 'What is WIP?')
})
