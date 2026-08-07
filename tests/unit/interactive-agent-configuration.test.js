const assert = require('node:assert/strict')
const { test } = require('node:test')

const { chooseSingleAgentConfigInteractively, configureAgentsInteractively } = require('../../src/cli/main')
const { resolveAgentRunConfig } = require('../../src/core/agents/configuration')

/**
 * @param {unknown[]} answers
 * @returns {{
 *   clack: {
 *     confirm: (input: Record<string, unknown>) => Promise<unknown>,
 *     select: (input: Record<string, unknown>) => Promise<unknown>,
 *     isCancel: (value: unknown) => boolean,
 *   },
 *   calls: Array<{ kind: string, input: Record<string, unknown> }>,
 * }}
 */
function promptHarness(answers) {
  const queue = [...answers]
  /** @type {Array<{ kind: string, input: Record<string, unknown> }>} */
  const calls = []
  return {
    calls,
    clack: {
      async confirm(input) {
        calls.push({ kind: 'confirm', input })
        return queue.shift()
      },
      async select(input) {
        calls.push({ kind: 'select', input })
        return queue.shift()
      },
      isCancel(value) {
        return value === Symbol.for('cancel')
      },
    },
  }
}

const EMPTY_FLOW = {
  id: 'interactive',
  title: 'Interactive',
  defaults: { agents: ['claude', 'opencode'] },
  steps: [{
    id: 'one',
    title: 'One',
    agents: ['claude', 'opencode'],
  }],
}

test('interactive configuration keeps Auto as the one-step default', async () => {
  const harness = promptHarness([false])
  const result = await configureAgentsInteractively({
    clack: harness.clack,
    flow: EMPTY_FLOW,
    options: {},
    agents: ['claude', 'opencode'],
  })

  assert.deepEqual(result, { models: {}, efforts: {} })
  assert.deepEqual(harness.calls.map((call) => call.kind), ['confirm'])
})

test('interactive configuration preserves provider choices and submits Max through the resolver', async () => {
  const harness = promptHarness([
    true,
    'claude-opus-4-8',
    'high',
    'z-ai/glm-5.2',
    'max',
  ])
  const result = await configureAgentsInteractively({
    clack: harness.clack,
    flow: EMPTY_FLOW,
    options: {},
    agents: ['claude', 'opencode'],
  })

  assert.deepEqual(result, {
    models: {
      claude: 'claude-opus-4-8',
      opencode: 'z-ai/glm-5.2',
    },
    efforts: {
      claude: 'high',
      opencode: 'max',
    },
  })
  assert.equal(resolveAgentRunConfig('opencode', {
    globalCli: result,
  }).effort, 'xhigh')

  const modelPrompt = harness.calls.find((call) => call.input.message === 'Claude model')
  assert.deepEqual(modelPrompt.input.options[0], { value: 'auto', label: 'Auto' })
  const maxPrompt = harness.calls.find((call) => call.input.message === 'OpenCode reasoning effort')
  assert.deepEqual(maxPrompt.input.options, [
    { value: 'auto', label: 'Auto' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
  ])
})

test('interactive configuration resets inherited effort after a model change', async () => {
  const harness = promptHarness([true, 'claude-sonnet-5', 'medium'])
  const flow = {
    ...EMPTY_FLOW,
    defaults: {
      agents: ['claude'],
      models: { claude: 'claude-opus-4-8' },
      efforts: { claude: 'high' },
    },
    steps: [{ id: 'one', title: 'One', agents: ['claude'] }],
  }
  const result = await configureAgentsInteractively({
    clack: harness.clack,
    flow,
    options: {},
    agents: ['claude'],
  })

  const effortPrompt = harness.calls.find((call) => call.input.message === 'Claude reasoning effort')
  assert.equal(effortPrompt.input.initialValue, 'auto')
  assert.deepEqual(result, {
    models: { claude: 'claude-sonnet-5' },
    efforts: { claude: 'medium' },
  })
})

test('interactive configuration skips the effort prompt for models without a dial', async () => {
  const harness = promptHarness([true, 'minimax/minimax-m3'])
  const result = await configureAgentsInteractively({
    clack: harness.clack,
    flow: EMPTY_FLOW,
    options: {},
    agents: ['opencode'],
  })

  assert.deepEqual(result, {
    models: { opencode: 'minimax/minimax-m3' },
    efforts: { opencode: 'auto' },
  })
  assert.deepEqual(harness.calls.map((call) => call.kind), ['confirm', 'select'])
})

test('interactive configuration preserves unknown inherited IDs and exposes cancellation', async () => {
  const unknownHarness = promptHarness([true, 'future-model', 'turbo'])
  const flow = {
    ...EMPTY_FLOW,
    defaults: {
      agents: ['claude'],
      models: { claude: 'future-model' },
      efforts: { claude: 'turbo' },
    },
    steps: [{ id: 'one', title: 'One', agents: ['claude'] }],
  }
  const unknownResult = await configureAgentsInteractively({
    clack: unknownHarness.clack,
    flow,
    options: {},
    agents: ['claude'],
  })
  assert.deepEqual(unknownResult, {
    models: { claude: 'future-model' },
    efforts: { claude: 'turbo' },
  })
  const unknownModelPrompt = unknownHarness.calls.find((call) => call.input.message === 'Claude model')
  const unknownModelOptions = /** @type {Array<Record<string, unknown>>} */ (unknownModelPrompt.input.options)
  assert.deepEqual(unknownModelOptions.at(-1), {
    value: 'future-model',
    label: 'future-model',
  })

  const cancelHarness = promptHarness([Symbol.for('cancel')])
  await assert.rejects(
    () => configureAgentsInteractively({
      clack: cancelHarness.clack,
      flow: EMPTY_FLOW,
      options: {},
      agents: ['claude'],
      exit(code) {
        throw new Error(`exit:${code}`)
      },
    }),
    /exit:0/,
  )
})

test('single-agent config defaults to the best model and its highest effort', async () => {
  const harness = promptHarness(['claude-fable-5', 'high'])
  const result = await chooseSingleAgentConfigInteractively({ clack: harness.clack, agent: 'claude' })

  assert.deepEqual(result, {
    models: { claude: 'claude-fable-5' },
    efforts: { claude: 'high' },
  })
  assert.deepEqual(harness.calls.map((call) => call.kind), ['select', 'select'])
  const modelPrompt = harness.calls.find((call) => call.input.message === 'Claude model')
  assert.equal(modelPrompt.input.initialValue, 'claude-fable-5')
  const effortPrompt = harness.calls.find((call) => call.input.message === 'Claude reasoning effort')
  assert.equal(effortPrompt.input.initialValue, 'high')
})

test('single-agent config defaults OpenCode to Max and submits xhigh through the resolver', async () => {
  const harness = promptHarness(['z-ai/glm-5.2', 'max'])
  const result = await chooseSingleAgentConfigInteractively({ clack: harness.clack, agent: 'opencode' })

  assert.deepEqual(result, {
    models: { opencode: 'z-ai/glm-5.2' },
    efforts: { opencode: 'max' },
  })
  const modelPrompt = harness.calls.find((call) => call.input.message === 'OpenCode model')
  assert.equal(modelPrompt.input.initialValue, 'moonshotai/kimi-k3')
  const effortPrompt = harness.calls.find((call) => call.input.message === 'OpenCode reasoning effort')
  assert.equal(effortPrompt.input.initialValue, 'max')
  assert.equal(resolveAgentRunConfig('opencode', { globalCli: result }).effort, 'xhigh')
})

test('single-agent config with Auto model skips the effort prompt', async () => {
  const harness = promptHarness(['auto'])
  const result = await chooseSingleAgentConfigInteractively({ clack: harness.clack, agent: 'claude' })

  assert.deepEqual(result, { models: { claude: 'auto' }, efforts: { claude: 'auto' } })
  assert.deepEqual(harness.calls.map((call) => call.kind), ['select'])
})

test('single-agent config skips effort for a model with no configurable effort', async () => {
  const harness = promptHarness(['moonshotai/kimi-k2.7-code'])
  const logs = []
  const originalLog = console.log
  console.log = (message) => { logs.push(String(message)) }
  try {
    const result = await chooseSingleAgentConfigInteractively({ clack: harness.clack, agent: 'opencode' })
    assert.deepEqual(result, {
      models: { opencode: 'moonshotai/kimi-k2.7-code' },
      efforts: { opencode: 'auto' },
    })
  } finally {
    console.log = originalLog
  }
  assert.deepEqual(harness.calls.map((call) => call.kind), ['select'])
  assert.match(logs.join('\n'), /does not expose configurable reasoning effort/)
})
