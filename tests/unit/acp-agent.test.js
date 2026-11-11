const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { createNaxAcpAgent } = require('../../src/integrations/acp/agent')
const { createNaxAgentRunnerSdk } = require('../../src/integrations/netlify/agent-runner-sdk')
const { loadAcpSession } = require('../../src/integrations/acp/session-store')
const { appendPatch, clonedRepo, runnerApi } = require('../fixtures/acp/harness')

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

test('new session saves the site and returns the config options', async () => {
  const cwd = clonedRepo()
  const { agent } = harness(cwd, runnerApi({ scripts: {} }))
  const response = await agent.newSession({ cwd, mcpServers: [] })
  assert.equal(response.sessionId, 'nax-test')
  assert.deepEqual(response.configOptions.map((option) => option.id), ['model', 'effort', 'changes'])
  const record = loadAcpSession(cwd, 'nax-test')
  assert.equal(record.siteId, 'site-1')
  assert.equal(record.handle, null)
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
