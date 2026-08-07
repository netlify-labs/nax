#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  AGENT_RUNNER_SDK_VERSION,
  DEFAULT_BB_API_URL,
  DEFAULT_NETLIFY_API_URL,
  createAgentRunnerSdk,
  createAuthenticatedNetlifyClient,
} from 'nax-agent-runner-sdk'

const MUTATION_GATE = 'ALLOW_AGENT_RUNNER_MODEL_EFFORT_CANARY'
const DEADLINE_MS = 5 * 60_000
const POLL_INTERVAL_MS = 3_000
const CONFIG_OBSERVATION_DEADLINE_MS = 30_000

/**
 * @typedef {import('nax-agent-runner-sdk').AuthenticatedNetlifyClient} AuthenticatedNetlifyClient
 * @typedef {import('nax-agent-runner-sdk').Handle} Handle
 * @typedef {import('nax-agent-runner-sdk').RunHandle} RunHandle
 */

/**
 * @param {string[]} argv
 * @returns {{ siteId: string, apiStyle: 'v1' | 'bb-api' }}
 */
function parseArgs(argv) {
  let siteId = ''
  /** @type {'v1' | 'bb-api'} */
  let apiStyle = 'v1'
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--site-id') {
      siteId = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--api-style') {
      const selected = argv[index + 1]
      if (selected !== 'v1' && selected !== 'bb-api') {
        throw new Error('--api-style must be v1 or bb-api')
      }
      apiStyle = selected
      index += 1
      continue
    }
    if (value === '--help' || value === '-h') {
      console.log(`Usage:
  ${MUTATION_GATE}=1 npm run probe:model-effort -- --site-id <uuid> [--api-style v1|bb-api]

Runs bounded ask-mode create, follow-up, resume, and manual-retry canaries.
Every live handle is cancelled before exit.`)
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${value}`)
  }
  if (!siteId.trim()) throw new Error('--site-id is required')
  if (process.env[MUTATION_GATE] !== '1') {
    throw new Error(`${MUTATION_GATE}=1 is required`)
  }
  return { siteId: siteId.trim(), apiStyle }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {string | undefined}
 */
function optionalString(value, key) {
  const selected = value[key]
  return typeof selected === 'string' && selected ? selected : undefined
}

/**
 * @param {AuthenticatedNetlifyClient} client
 * @param {Handle} handle
 * @returns {Promise<{ agent_config: { agent?: string, model?: string, effort?: string } }>}
 */
async function readRawSession(client, handle) {
  const response = await client.requestResponse(
    'GET',
    `/agent_runners/${encodeURIComponent(handle.runnerId)}/sessions/${encodeURIComponent(handle.currentSessionId)}`,
    { operation: 'model-effort-canary-observe' },
  )
  if (!response.ok) {
    throw new Error(`Session observation failed with HTTP ${response.status}`)
  }
  const payload = record(response.payload)
  const agentConfig = record(payload?.agent_config ?? payload?.agentConfig)
  if (!agentConfig) throw new Error('Session response omitted agent_config')
  return {
    agent_config: {
      ...(optionalString(agentConfig, 'agent') ? { agent: optionalString(agentConfig, 'agent') } : {}),
      ...(optionalString(agentConfig, 'model') ? { model: optionalString(agentConfig, 'model') } : {}),
      ...(optionalString(agentConfig, 'effort') ? { effort: optionalString(agentConfig, 'effort') } : {}),
    },
  }
}

/**
 * @param {{ agent?: string, model?: string, effort?: string }} actual
 * @param {{ agent: string, model: string, effort: string }} expected
 */
function assertExactConfig(actual, expected) {
  assert.deepEqual(actual, expected)
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * @param {AuthenticatedNetlifyClient} client
 * @param {Handle} handle
 * @param {{ agent: string, model: string, effort: string }} expected
 * @returns {Promise<{ agent_config: { agent?: string, model?: string, effort?: string } }>}
 */
async function waitForConfig(client, handle, expected) {
  const deadline = Date.now() + CONFIG_OBSERVATION_DEADLINE_MS
  let observed = await readRawSession(client, handle)
  while (Date.now() < deadline) {
    try {
      assertExactConfig(observed.agent_config, expected)
      return observed
    } catch {
      await sleep(1_000)
      observed = await readRawSession(client, handle)
    }
  }
  return observed
}

/**
 * @param {{ agent?: string, model?: string, effort?: string }} actual
 * @param {{ agent: string, model: string, effort: string }} expected
 * @returns {boolean}
 */
function configMatches(actual, expected) {
  try {
    assertExactConfig(actual, expected)
    return true
  } catch {
    return false
  }
}

/**
 * @param {Handle} handle
 * @returns {{ agent?: string, model?: string, effort?: string }}
 */
function handleConfig(handle) {
  const input = handle.kind === 'session' ? handle.sessionInput : handle.input
  return {
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  }
}

/**
 * @param {string} siteId
 * @param {'v1' | 'bb-api'} apiStyle
 */
async function main(siteId, apiStyle) {
  const baseUrl = apiStyle === 'bb-api' ? DEFAULT_BB_API_URL : DEFAULT_NETLIFY_API_URL
  const sdk = createAgentRunnerSdk({
    apiStyle,
    baseUrl,
    defaultDeadlineMs: DEADLINE_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  })
  const client = createAuthenticatedNetlifyClient({ baseUrl })
  /** @type {Set<Handle>} */
  const handlesToStop = new Set()
  /** @type {Array<Record<string, unknown>>} */
  const evidence = []
  /** @type {Array<Record<string, unknown>>} */
  const discrepancies = []

  /**
   * @param {Handle} handle
   * @returns {Promise<void>}
   */
  const stop = async (handle) => {
    await sdk.stop(handle)
    handlesToStop.delete(handle)
  }

  try {
    /** @type {import('nax-agent-runner-sdk').StartInput} */
    const claudeInput = {
      siteId,
      requestId: randomUUID(),
      prompt: 'Model and effort canary. Do not edit files. Reply only: NAX CANARY OK.',
      agent: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
      mode: 'ask',
      land: 'none',
      deadlineMs: DEADLINE_MS,
      retryBudget: { capacity: 0 },
    }
    const claude = await sdk.start(claudeInput)
    handlesToStop.add(claude)
    const claudeExpected = {
      agent: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
    }
    const resumedClaude = sdk.parseHandle(sdk.serializeHandle(claude))
    assertExactConfig(handleConfig(resumedClaude), claudeExpected)
    const claudeResult = await sdk.waitFor(resumedClaude)
    assert.equal(claudeResult.status, 'succeeded')
    const claudeObserved = await waitForConfig(client, claude, claudeExpected)
    assertExactConfig(claudeObserved.agent_config, claudeExpected)

    const followUp = await sdk.followUp(resumedClaude, {
      requestId: randomUUID(),
      prompt: 'Follow-up canary. Do not edit files. Reply only: NAX FOLLOW-UP OK.',
      agent: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
      mode: 'ask',
    })
    assertExactConfig(handleConfig(followUp), claudeExpected)
    const followUpResult = await sdk.waitFor(followUp)
    assert.equal(followUpResult.status, 'succeeded')
    const followUpObserved = await waitForConfig(client, followUp, claudeExpected)
    const followUpMatches = configMatches(followUpObserved.agent_config, claudeExpected)
    if (!followUpMatches) {
      discrepancies.push({
        case: 'claude-explicit-follow-up',
        expected: claudeExpected,
        observed: followUpObserved.agent_config,
      })
    }
    await stop(followUp)
    await stop(claude)
    evidence.push({
      case: 'claude-explicit-follow-up-resume',
      request: { agent: 'claude', model: 'claude-opus-4-8', effort: 'high' },
      observed: claudeObserved,
      followUpObserved,
      followUpMatches,
      runnerId: claude.runnerId,
      sessionId: claude.currentSessionId,
      followUpSessionId: followUp.currentSessionId,
      resumed: true,
      stopped: true,
    })

    const auto = await sdk.start({
      siteId,
      requestId: randomUUID(),
      prompt: 'Auto configuration canary. Do not edit files. Reply only: NAX AUTO OK.',
      agent: 'claude',
      mode: 'ask',
      land: 'none',
      deadlineMs: DEADLINE_MS,
      retryBudget: { capacity: 0 },
    })
    handlesToStop.add(auto)
    assert.equal(Object.hasOwn(auto.input, 'model'), false)
    assert.equal(Object.hasOwn(auto.input, 'effort'), false)
    const autoObserved = await readRawSession(client, auto)
    await stop(auto)
    evidence.push({
      case: 'claude-auto-omission',
      request: { agent: 'claude', modelOmitted: true, effortOmitted: true },
      observed: autoObserved,
      runnerId: auto.runnerId,
      sessionId: auto.currentSessionId,
      stopped: true,
    })

    const openCodeExpected = {
      agent: 'opencode',
      model: 'z-ai/glm-5.2',
      effort: 'xhigh',
    }
    const openCode = await sdk.start({
      siteId,
      requestId: randomUUID(),
      prompt: 'OpenCode Max canary. Do not edit files. Reply only: NAX OPENCODE OK.',
      ...openCodeExpected,
      mode: 'ask',
      land: 'none',
      deadlineMs: DEADLINE_MS,
      retryBudget: { capacity: 1 },
    })
    handlesToStop.add(openCode)
    const resumedOpenCode = sdk.parseHandle(sdk.serializeHandle(openCode))
    assertExactConfig(handleConfig(resumedOpenCode), openCodeExpected)
    const openCodeResult = await sdk.waitFor(resumedOpenCode)
    assert.equal(openCodeResult.status, 'succeeded')
    const openCodeObserved = await waitForConfig(client, openCode, openCodeExpected)
    assertExactConfig(openCodeObserved.agent_config, openCodeExpected)

    const retriedOpenCode = await sdk.retry(/** @type {RunHandle} */ (resumedOpenCode))
    handlesToStop.add(retriedOpenCode)
    assertExactConfig(handleConfig(retriedOpenCode), openCodeExpected)
    const retryResult = await sdk.waitFor(retriedOpenCode)
    assert.equal(retryResult.status, 'succeeded')
    const retryObserved = await waitForConfig(client, retriedOpenCode, openCodeExpected)
    assertExactConfig(retryObserved.agent_config, openCodeExpected)
    await stop(openCode)
    await stop(retriedOpenCode)
    evidence.push({
      case: 'opencode-glm-max-retry-resume',
      request: openCodeExpected,
      observed: openCodeObserved,
      retryObserved,
      runnerId: openCode.runnerId,
      retryRunnerId: retriedOpenCode.runnerId,
      sessionId: openCode.currentSessionId,
      retrySessionId: retriedOpenCode.currentSessionId,
      wireEffort: 'xhigh',
      resumed: true,
      retried: true,
      stopped: true,
    })
  } finally {
    const cleanup = await Promise.allSettled(
      [...handlesToStop].map((handle) => sdk.stop(handle)),
    )
    const failedCleanup = cleanup.filter((result) => result.status === 'rejected')
    if (failedCleanup.length > 0) {
      throw new Error(`Failed to stop ${failedCleanup.length} canary handle(s)`)
    }
  }

  console.log(JSON.stringify({
    siteId,
    apiStyle,
    sdkVersion: AGENT_RUNNER_SDK_VERSION,
    completedAt: new Date().toISOString(),
    evidence,
    discrepancies,
  }, null, 2))
  if (discrepancies.length > 0) {
    throw new Error(`${discrepancies.length} live contract discrepancy found`)
  }
}

const { siteId, apiStyle } = parseArgs(process.argv.slice(2))
main(siteId, apiStyle).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
