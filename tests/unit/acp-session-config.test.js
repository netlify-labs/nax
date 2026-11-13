const test = require('node:test')
const assert = require('node:assert/strict')

const {
  defaultSessionConfig,
  sessionConfigOptions,
  updateSessionConfig,
} = require('../../src/integrations/acp/session-config')

/**
 * @typedef {import('../../src/integrations/acp/session-config').AcpSessionConfig} AcpSessionConfig
 * @typedef {import('../../src/integrations/acp/session-config').AcpSelectOption} AcpSelectOption
 * @typedef {import('../../src/integrations/acp/session-config').AcpSelectGroup} AcpSelectGroup
 */

test('default config runs Claude on Auto and applies changes locally', () => {
  assert.deepEqual(defaultSessionConfig(), {
    agent: 'claude',
    model: 'auto',
    effort: 'auto',
    changes: 'apply',
    site: '',
  })
})

test('model option groups every agent so ACP clients drive one model picker', () => {
  const options = sessionConfigOptions(defaultSessionConfig())
  const model = options.find((option) => option.id === 'model')
  assert.equal(model.type, 'select')
  assert.equal(model.category, 'model')
  assert.equal(model.currentValue, 'claude:auto')
  const modelGroups = /** @type {AcpSelectGroup[]} */ (model.options)
  const groups = modelGroups.map((group) => group.group)
  assert.deepEqual(groups, ['claude', 'gemini', 'codex', 'opencode'])
  const claude = modelGroups[0]
  assert.equal(claude.name, 'Claude')
  assert.deepEqual(claude.options[0], { value: 'claude:auto', name: 'Claude Auto' })
  assert.ok(claude.options.some((option) => option.value === 'claude:claude-opus-5'))
})

test('effort option lists the selected model efforts as a thought level', () => {
  const options = sessionConfigOptions({ ...defaultSessionConfig(), model: 'claude-opus-5' })
  const effort = options.find((option) => option.id === 'effort')
  assert.equal(effort.category, 'thought_level')
  assert.equal(effort.currentValue, 'auto')
  assert.equal(/** @type {AcpSelectOption[]} */ (effort.options)[0].value, 'auto')
  assert.ok(effort.options.length > 1, 'a named model offers efforts beyond Auto')
})

test('changes option offers applying locally or opening a pull request', () => {
  const changes = sessionConfigOptions(defaultSessionConfig()).find((option) => option.id === 'changes')
  assert.equal(changes.currentValue, 'apply')
  assert.deepEqual(/** @type {AcpSelectOption[]} */ (changes.options).map((option) => option.value), ['apply', 'pr'])
})

test('selecting a model from another agent switches agent and resets effort', () => {
  /** @type {AcpSessionConfig} */
  const start = { agent: 'claude', model: 'claude-opus-5', effort: 'high', changes: 'apply', site: '' }
  assert.deepEqual(updateSessionConfig(start, 'model', 'codex:gpt-6.1-sol'), {
    agent: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'auto',
    changes: 'apply',
    site: '',
  })
})

test('model ids containing slashes and colons keep everything after the agent prefix', () => {
  const next = updateSessionConfig(defaultSessionConfig(), 'model', 'opencode:moonshotai/kimi-k3')
  assert.equal(next.agent, 'opencode')
  assert.equal(next.model, 'moonshotai/kimi-k3')
})

test('effort and changes accept only offered values', () => {
  const config = { ...defaultSessionConfig(), model: 'claude-opus-5' }
  const effortOptions = /** @type {AcpSelectOption[]} */ (sessionConfigOptions(config).find((option) => option.id === 'effort').options)
  const effort = effortOptions[1].value
  assert.equal(updateSessionConfig(config, 'effort', effort).effort, effort)
  assert.equal(updateSessionConfig(config, 'changes', 'pr').changes, 'pr')
  assert.throws(() => updateSessionConfig(config, 'effort', 'ludicrous'), /Unsupported effort "ludicrous"/)
  assert.throws(() => updateSessionConfig(config, 'changes', 'push'), /Unsupported changes value "push"/)
  assert.throws(() => updateSessionConfig(config, 'model', 'bard:x'), /Unsupported agent provider "bard"/)
  assert.throws(() => updateSessionConfig(config, 'color', 'red'), /Unknown session config option "color"/)
})

const SITES = [
  { siteId: 'site-a', label: 'sites/a', dir: '/repo/sites/a' },
  { siteId: 'site-b', label: 'sites/b, sites/c', dir: '/repo/sites/b' },
]

test('site option appears only when a repository links several Netlify sites', () => {
  assert.equal(sessionConfigOptions(defaultSessionConfig(), [SITES[0]]).some((option) => option.id === 'site'), false)
  const site = sessionConfigOptions(defaultSessionConfig(), SITES).find((option) => option.id === 'site')
  assert.equal(site.currentValue, 'choose')
  assert.deepEqual(/** @type {AcpSelectOption[]} */ (site.options).map((option) => [option.value, option.name]), [
    ['choose', 'Choose a site…'],
    ['site-a', 'sites/a'],
    ['site-b', 'sites/b, sites/c'],
  ])
})

test('site accepts only a linked site', () => {
  assert.equal(updateSessionConfig(defaultSessionConfig(), 'site', 'site-b', SITES).site, 'site-b')
  assert.throws(() => updateSessionConfig(defaultSessionConfig(), 'site', 'site-z', SITES), /Unknown Netlify site "site-z"/)
})
