import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

interface ModelEffortContract {
  provenance: {
    source: string
    commit: string
    capturedAt: string
    note: string
  }
  requests: {
    createPinned: Record<string, unknown>
    createAuto: Record<string, unknown>
    followUpPinned: Record<string, unknown>
  }
  responses: {
    sessionSnakeCase: Record<string, unknown>
    sessionCamelCase: Record<string, unknown>
  }
  catalog: Record<string, string[]>
  efforts: {
    standardPinnedModels: string[]
    opencode: Record<string, string[]>
    wireTranslations: Record<string, Record<string, string>>
  }
  githubAction: {
    pinnedCommit: string
    providerInput: string
    legacyProviderAlias: string
    supportsProvider: boolean
    supportsPinnedModel: boolean
    supportsEffort: boolean
  }
}

const contract = JSON.parse(readFileSync(
  new URL('./fixtures/contracts/model-effort-v1-2026-08-06.json', import.meta.url),
  'utf8',
)) as ModelEffortContract

test('model and effort fixture pins exact create, Auto, and follow-up bodies', () => {
  assert.deepEqual(contract.requests.createPinned, {
    prompt: 'Can you do security audit of the services directory please',
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    file_keys: [],
  })
  assert.deepEqual(contract.requests.createAuto, {
    prompt: 'Can you do security audit of the services directory please',
    agent: 'claude',
    file_keys: [],
  })
  assert.deepEqual(contract.requests.followUpPinned, {
    prompt: 'Now audit the authentication boundary',
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    file_keys: [],
  })
  assert.equal('model' in contract.requests.createAuto, false)
  assert.equal('effort' in contract.requests.createAuto, false)
})

test('session fixtures pin model and effort beneath snake and camel agent config', () => {
  assert.deepEqual(contract.responses.sessionSnakeCase.agent_config, {
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
  })
  assert.deepEqual(contract.responses.sessionCamelCase.agentConfig, {
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
  })
  assert.equal('model' in contract.responses.sessionSnakeCase, false)
  assert.equal('effort' in contract.responses.sessionSnakeCase, false)
})

test('catalog fixture includes every verified provider model and wire translation', () => {
  assert.deepEqual(Object.keys(contract.catalog), [
    'claude',
    'codex',
    'gemini',
    'opencode',
  ])
  assert.equal(
    Object.values(contract.catalog).flat().length,
    19,
    JSON.stringify(contract.catalog, null, 2),
  )
  assert.ok(
    contract.catalog.opencode?.includes('~deepseek/deepseek-v4-flash-latest'),
  )
  assert.deepEqual(contract.efforts.wireTranslations, {
    'z-ai/glm-5.2': { max: 'xhigh' },
    'deepseek/deepseek-v4-pro': { max: 'xhigh' },
  })
})

test('pinned GitHub Action fixture exposes provider selection only', () => {
  const template = readFileSync(
    new URL('../../../src/templates/netlify-agents.yml', import.meta.url),
    'utf8',
  )
  assert.match(
    template,
    new RegExp(`agent-runner-action@${contract.githubAction.pinnedCommit}`),
  )
  assert.equal(contract.githubAction.providerInput, 'default-agent')
  assert.equal(contract.githubAction.legacyProviderAlias, 'default-model')
  assert.equal(contract.githubAction.supportsProvider, true)
  assert.equal(contract.githubAction.supportsPinnedModel, false)
  assert.equal(contract.githubAction.supportsEffort, false)
  assert.doesNotMatch(template, /^\s+(?:default-)?model:/m)
  assert.doesNotMatch(template, /^\s+effort:/m)
})
