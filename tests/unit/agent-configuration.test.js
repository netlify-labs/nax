const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  AGENT_CONFIGURATION_CATALOG,
  SUPPORTED_AGENT_PROVIDERS,
  formatAgentConfigLabel,
  getAgentEffortOptions,
  getAgentModelOptions,
  getBestModelForProvider,
  getEffortAvailabilityNotice,
  getHighestEffortForModel,
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  resolveAgentRunConfig,
  validateAgentConfig,
} = require('../../src/core/agents/configuration')

/** @type {Record<string, string[]>} */
const EXPECTED_MODELS = {
  claude: [
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-fable-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ],
  codex: [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4-mini',
  ],
  gemini: [
    'gemini-3.1-pro-preview',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
  ],
  opencode: [
    'moonshotai/kimi-k3',
    'moonshotai/kimi-k2.7-code',
    'z-ai/glm-5.2',
    'deepseek/deepseek-v4-pro',
    '~deepseek/deepseek-v4-flash-latest',
    'x-ai/grok-4.5',
    'minimax/minimax-m3',
  ],
}

const EXPECTED_LABELS = {
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-fable-5': 'Fable 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'gpt-5.6-sol': 'GPT 5.6 Sol',
  'gpt-5.6-terra': 'GPT 5.6 Terra',
  'gpt-5.6-luna': 'GPT 5.6 Luna',
  'gpt-5.4-mini': 'GPT 5.4 Mini',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'moonshotai/kimi-k3': 'Kimi K3',
  'moonshotai/kimi-k2.7-code': 'Kimi K2.7 Code',
  'z-ai/glm-5.2': 'GLM 5.2',
  'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
  '~deepseek/deepseek-v4-flash-latest': 'DeepSeek V4 Flash Latest',
  'x-ai/grok-4.5': 'Grok 4.5',
  'minimax/minimax-m3': 'MiniMax M3',
}

test('catalog matches the verified React UI snapshot and remains serializable', () => {
  assert.deepEqual(SUPPORTED_AGENT_PROVIDERS, ['claude', 'gemini', 'codex', 'opencode'])
  assert.deepEqual(AGENT_CONFIGURATION_CATALOG.provenance, {
    source: 'netlify-react-ui AgentConfigModal/models.ts',
    commit: '0a61ba66',
    syncedAt: '2026-08-06',
  })
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(AGENT_CONFIGURATION_CATALOG)))

  const actualModels = Object.fromEntries(
    AGENT_CONFIGURATION_CATALOG.providers.map((provider) => [
      provider.id,
      provider.models.map((model) => model.id),
    ]),
  )
  assert.deepEqual(actualModels, EXPECTED_MODELS)
  const actualLabels = Object.fromEntries(
    AGENT_CONFIGURATION_CATALOG.providers.flatMap((provider) =>
      provider.models.map((model) => [model.id, model.label])),
  )
  assert.deepEqual(actualLabels, EXPECTED_LABELS)

  const flash = AGENT_CONFIGURATION_CATALOG.providers
    .find((provider) => provider.id === 'opencode')
    .models.find((model) => model.id === '~deepseek/deepseek-v4-flash-latest')
  assert.equal(flash.aliasFor, 'deepseek/deepseek-v4-flash-0731')
})

test('Auto omits both model and effort', () => {
  assert.deepEqual(resolveAgentRunConfig('claude'), { agent: 'claude', warnings: [] })
  assert.deepEqual(resolveAgentRunConfig('claude', {
    defaults: {
      models: { claude: 'claude-opus-4-8' },
      efforts: { claude: 'high' },
    },
    step: {
      models: { claude: 'Auto' },
      efforts: { claude: 'AUTO' },
    },
  }), { agent: 'claude', warnings: [] })
})

test('Claude, Codex, and Gemini models accept every low/medium/high effort', () => {
  for (const agent of ['claude', 'codex', 'gemini']) {
    for (const model of EXPECTED_MODELS[agent]) {
      for (const effort of ['low', 'medium', 'high']) {
        assert.deepEqual(
          validateAgentConfig({ agent, model, effort }),
          { agent, model, effort, warnings: [] },
          JSON.stringify({ agent, model, effort }),
        )
      }
    }
  }
})

test('OpenCode model effort matrix and Max wire translations are exhaustive', () => {
  /** @type {Array<[string, string[], { max?: string }]>} */
  const cases = [
    ['moonshotai/kimi-k3', ['low', 'high', 'max'], { max: 'max' }],
    ['moonshotai/kimi-k2.7-code', [], {}],
    ['z-ai/glm-5.2', ['high', 'max'], { max: 'xhigh' }],
    ['deepseek/deepseek-v4-pro', ['high', 'max'], { max: 'xhigh' }],
    ['~deepseek/deepseek-v4-flash-latest', ['low', 'high', 'max'], { max: 'max' }],
    ['x-ai/grok-4.5', ['low', 'medium', 'high'], {}],
    ['minimax/minimax-m3', [], {}],
  ]
  const candidateEfforts = ['low', 'medium', 'high', 'max', 'xhigh']

  for (const [model, allowed, translations] of cases) {
    for (const effort of candidateEfforts) {
      const shouldAllow = allowed.includes(effort)
        || (effort === 'xhigh' && translations.max === 'xhigh')
      if (!shouldAllow) {
        assert.throws(
          () => validateAgentConfig({ agent: 'opencode', model, effort }),
          { code: 'unsupported_model_effort' },
          JSON.stringify({ model, effort, allowed }),
        )
        continue
      }
      const result = validateAgentConfig({ agent: 'opencode', model, effort })
      const expectedEffort = effort === 'max' ? (translations.max || 'max') : effort
      assert.equal(result.effort, expectedEffort, JSON.stringify({ model, effort, result }))
    }
  }
})

test('resolution precedence resets stale effort on model changes', () => {
  const defaults = {
    models: { claude: 'claude-opus-4-8' },
    efforts: { claude: 'high' },
  }
  assert.deepEqual(resolveAgentRunConfig('claude', {
    defaults,
    step: { models: { claude: 'claude-sonnet-5' } },
  }), {
    agent: 'claude',
    model: 'claude-sonnet-5',
    warnings: [],
  })
  assert.deepEqual(resolveAgentRunConfig('claude', {
    defaults,
    step: { efforts: { claude: 'medium' } },
  }), {
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'medium',
    warnings: [],
  })
  assert.deepEqual(resolveAgentRunConfig('claude', {
    defaults,
    step: {
      models: { claude: 'claude-sonnet-5' },
      efforts: { claude: 'low' },
    },
    globalCli: {
      models: { claude: 'claude-fable-5' },
      efforts: { claude: 'medium' },
    },
    stepCli: {
      models: { claude: 'claude-opus-5' },
      efforts: { claude: 'high' },
    },
  }), {
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
    warnings: [],
  })
})

test('known invalids fail before mutation', () => {
  assert.throws(
    () => validateAgentConfig({ agent: 'unknown', model: 'future-model' }),
    { code: 'unsupported_agent' },
  )
  assert.throws(
    () => validateAgentConfig({ agent: 'claude', effort: 'high' }),
    { code: 'effort_requires_model' },
  )
  assert.throws(
    () => validateAgentConfig({ agent: 'codex', model: 'claude-opus-4-8' }),
    { code: 'model_provider_mismatch' },
  )
  assert.throws(
    () => validateAgentConfig({
      agent: 'claude',
      model: 'claude-opus-4-8',
      effort: 'maximum-plus',
    }),
    { code: 'unsupported_model_effort' },
  )
})

test('unknown future IDs pass through exactly with warnings', () => {
  const result = validateAgentConfig({
    agent: 'gemini',
    model: 'gemini-future-experimental',
    effort: 'turbo',
  })
  assert.equal(result.model, 'gemini-future-experimental')
  assert.equal(result.effort, 'turbo')
  assert.equal(result.warnings.length, 2)
  assert.match(result.warnings[0], /not in NAX's .* catalog/)
  assert.match(result.warnings[1], /passed through unchanged/)
})

test('mapping normalizers reject duplicates and old provider-list model forms', () => {
  assert.deepEqual(normalizeProviderModelMap([
    'claude=claude-opus-4-8',
    'codex=gpt-5.6-sol',
  ]), {
    claude: 'claude-opus-4-8',
    codex: 'gpt-5.6-sol',
  })
  assert.deepEqual(normalizeProviderEffortMap({ claude: 'High' }), { claude: 'High' })
  assert.throws(
    () => normalizeProviderModelMap(['claude=claude-opus-4-8', 'claude=claude-opus-5']),
    { code: 'duplicate_model_assignment' },
  )
  assert.throws(
    () => normalizeProviderModelMap('claude,codex'),
    /** @param {unknown} error */
    (error) => Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'invalid_model_mapping' &&
      'message' in error &&
      /--agents/.test(String(error.message)),
    ),
  )
})

test('catalog helpers preserve unknown values and display Max', () => {
  assert.deepEqual(getAgentModelOptions('claude').slice(0, 2), [
    { id: 'auto', label: 'Auto' },
    { id: 'claude-opus-5', label: 'Opus 5' },
  ])
  assert.deepEqual(getAgentModelOptions('claude', { includeModel: 'future-model' }).at(-1), {
    id: 'future-model',
    label: 'future-model',
  })
  assert.deepEqual(getAgentEffortOptions('opencode', 'z-ai/glm-5.2'), [
    { id: 'auto', label: 'Auto' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' },
  ])
  assert.match(
    getEffortAvailabilityNotice('opencode', 'minimax/minimax-m3'),
    /does not expose/,
  )
  assert.equal(
    formatAgentConfigLabel({ agent: 'opencode', model: 'z-ai/glm-5.2', effort: 'xhigh' }),
    'OpenCode · GLM 5.2 · Max',
  )
  assert.equal(
    formatAgentConfigLabel({ agent: 'claude', model: 'future-model', effort: 'turbo' }),
    'Claude · future-model · turbo',
  )
})

test('getBestModelForProvider returns the flagship model per provider', () => {
  assert.equal(getBestModelForProvider('claude'), 'claude-fable-5')
  assert.equal(getBestModelForProvider('gemini'), 'gemini-3.1-pro-preview')
  assert.equal(getBestModelForProvider('codex'), 'gpt-5.6-sol')
  assert.equal(getBestModelForProvider('opencode'), 'moonshotai/kimi-k3')
  assert.equal(getBestModelForProvider('unknown-provider'), 'auto')
})

test('getHighestEffortForModel returns the top catalog effort or auto', () => {
  assert.equal(getHighestEffortForModel('claude', 'claude-opus-5'), 'high')
  assert.equal(getHighestEffortForModel('opencode', 'z-ai/glm-5.2'), 'max')
  assert.equal(getHighestEffortForModel('opencode', 'moonshotai/kimi-k3'), 'max')
  assert.equal(getHighestEffortForModel('opencode', 'moonshotai/kimi-k2.7-code'), 'auto')
  assert.equal(getHighestEffortForModel('claude', 'auto'), 'auto')
})

test('catalog exposes a configurable defaultModel per provider (Claude = Fable 5)', () => {
  const byId = Object.fromEntries(
    AGENT_CONFIGURATION_CATALOG.providers.map((p) => [p.id, p.defaultModel]),
  )
  assert.deepEqual(byId, {
    claude: 'claude-fable-5',
    gemini: 'gemini-3.1-pro-preview',
    codex: 'gpt-5.6-sol',
    opencode: 'moonshotai/kimi-k3',
  })
  // every defaultModel is a real model of its provider
  for (const p of AGENT_CONFIGURATION_CATALOG.providers) {
    assert.ok(p.models.some((m) => m.id === p.defaultModel), `${p.id} default missing`)
  }
})
