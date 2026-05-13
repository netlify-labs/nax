const test = require('node:test')
const assert = require('node:assert/strict')

const { buildIssueBody, buildIssueTitle, listPromptNames, loadPrompt } = require('../lib/prompts')

const fakePrompt = {
  name: 'summarize-consensus',
  title: 'Summarize Consensus',
  description: 'desc',
  instruction: 'please summarize',
  body: 'PROMPT BODY',
}

test('buildIssueBody renders Resolves #N footer when resolves array is provided', () => {
  const out = buildIssueBody({
    runner: '@netlify',
    model: 'claude',
    prompt: fakePrompt,
    context: '',
    roundResults: '',
    date: '2026-05-09',
    resolves: [67, 68, 69],
  })

  assert.match(out, /Resolves #67/)
  assert.match(out, /Resolves #68/)
  assert.match(out, /Resolves #69/)
  // Each on its own line
  assert.match(out, /Resolves #67\nResolves #68\nResolves #69/)
})

test('buildIssueBody Resolves footer sits before the workflow-prompt marker', () => {
  const out = buildIssueBody({
    runner: '@netlify',
    model: 'claude',
    prompt: fakePrompt,
    context: '',
    roundResults: '',
    date: '2026-05-09',
    resolves: [67],
  })

  const resolvesIdx = out.indexOf('Resolves #67')
  const markerIdx = out.indexOf('<!-- netlify-workflow-prompt:summarize-consensus:claude:2026-05-09 -->')
  assert.ok(resolvesIdx > 0)
  assert.ok(markerIdx > resolvesIdx)
})

test('buildIssueBody omits Resolves footer when array is empty or missing', () => {
  const without = buildIssueBody({
    runner: '@netlify',
    model: 'claude',
    prompt: fakePrompt,
    context: '',
    roundResults: '',
    date: '2026-05-09',
  })
  assert.doesNotMatch(without, /Resolves #/)

  const empty = buildIssueBody({
    runner: '@netlify',
    model: 'claude',
    prompt: fakePrompt,
    context: '',
    roundResults: '',
    date: '2026-05-09',
    resolves: [],
  })
  assert.doesNotMatch(empty, /Resolves #/)
})

test('buildIssueTitle uses the standard format for non-summarize prompts', () => {
  const reviewPrompt = { name: 'review', title: 'Review' }
  const out = buildIssueTitle({
    date: '2026-05-09',
    model: 'claude',
    prompt: reviewPrompt,
    sourceModels: ['claude', 'gemini', 'codex'],
  })
  assert.equal(out, '2026-05-09 Claude Review')
})

test('buildIssueTitle for summarize-consensus lists source models and synthesizer', () => {
  const out = buildIssueTitle({
    date: '2026-05-09',
    model: 'codex',
    prompt: fakePrompt,
    sourceModels: ['claude', 'gemini', 'codex'],
  })
  assert.equal(out, '2026-05-09 Summarize Claude/Gemini/Codex Consensus using Codex')
})

test('buildIssueTitle for summarize-consensus falls back to default format when sourceModels is empty', () => {
  const out = buildIssueTitle({
    date: '2026-05-09',
    model: 'codex',
    prompt: fakePrompt,
    sourceModels: [],
  })
  assert.equal(out, '2026-05-09 Codex Summarize Consensus')
})

test('buildIssueTitle honors an explicit --title even for summarize-consensus', () => {
  const out = buildIssueTitle({
    date: '2026-05-09',
    model: 'codex',
    prompt: fakePrompt,
    title: 'Custom Title',
    sourceModels: ['claude', 'gemini', 'codex'],
  })
  assert.equal(out, '2026-05-09 Codex Custom Title')
})

test('loadPrompt returns the summarize-consensus template intact', () => {
  const prompt = loadPrompt('summarize-consensus')
  assert.equal(prompt.name, 'summarize-consensus')
  assert.match(prompt.body, /Cross Reference Synthesis/)
})

test('loadPrompt resolves numbered prompt filenames with clean names', () => {
  assert.ok(listPromptNames().includes('review'))
  assert.equal(loadPrompt('review').name, 'review')
  assert.match(loadPrompt('review').path, /1_review\.md$/)
})
