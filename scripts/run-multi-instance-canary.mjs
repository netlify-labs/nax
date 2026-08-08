#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentRunnerSdk } from 'nax-agent-runner-sdk'

const MUTATION_GATE = 'ALLOW_MULTI_INSTANCE_CANARY'
const DEFAULT_REPO = 'netlify-labs/agent-sdk-canary'
const DEFAULT_BRANCH = 'main'
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout'])
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const NAX_CLI = path.join(REPO_ROOT, 'src', 'cli', 'nax.js')
const FLOW_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'live-canary-flows')

/** @typedef {Record<string, unknown>} JsonRecord */

/**
 * @typedef {{
 *   siteId: string,
 *   repo: string,
 *   branch: string,
 *   projectRoot: string,
 *   scenario: string,
 * }} CanaryOptions
 */

/**
 * @typedef {{
 *   code: number,
 *   stdout: string,
 *   stderr: string,
 * }} CommandResult
 */

/**
 * @typedef {JsonRecord & {
 *   agent?: string,
 *   model?: string,
 *   effort?: string,
 *   instanceId?: string,
 *   status?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   sdkHandle?: JsonRecord,
 * }} CanaryAgentRun
 */

/**
 * @typedef {JsonRecord & {
 *   id?: string,
 *   status?: string,
 *   runs?: CanaryAgentRun[],
 * }} CanaryStep
 */

/**
 * @typedef {JsonRecord & {
 *   runId?: string,
 *   flowId?: string,
 *   status?: string,
 *   createdAt?: string,
 *   completedAt?: string,
 *   dir?: string,
 *   steps?: CanaryStep[],
 * }} CanaryWorkflowState
 */

/**
 * @typedef {{
 *   flowId: string,
 *   expectedExit: 'zero' | 'nonzero',
 * }} CanaryScenario
 */

/** @param {unknown} value @returns {JsonRecord | undefined} */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {JsonRecord} */ (value)
    : undefined
}

/** @param {unknown} value @returns {string} */
function stringValue(value) {
  return typeof value === 'string' ? value : ''
}

/** @param {string[]} argv @returns {CanaryOptions} */
function parseArgs(argv) {
  let siteId = ''
  let repo = DEFAULT_REPO
  let branch = DEFAULT_BRANCH
  let projectRoot = ''
  let scenario = ''
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--site-id') {
      siteId = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--repo') {
      repo = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--branch') {
      branch = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--project-root') {
      projectRoot = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--scenario') {
      scenario = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--help' || value === '-h') {
      console.log(`Usage:
  ${MUTATION_GATE}=1 npm run canary:multi-instance -- --site-id <uuid> [options]

Options:
  --repo <owner/name>     Disposable GitHub repository (${DEFAULT_REPO})
  --branch <name>         Remote branch (${DEFAULT_BRANCH})
  --project-root <path>   Reuse an existing clean clone instead of making a temporary clone
  --scenario <flow-id>    Run one fixture only (diagnostic/retry use)

Runs four bounded, harmless NAX workflows, verifies durable state/events, archives every
created Agent Runner, and prints sanitized JSON evidence. Never point this at production.`)
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${value}`)
  }
  if (!siteId.trim()) throw new Error('--site-id is required')
  if (!repo.trim()) throw new Error('--repo must not be empty')
  if (!branch.trim()) throw new Error('--branch must not be empty')
  if (process.env[MUTATION_GATE] !== '1') throw new Error(`${MUTATION_GATE}=1 is required`)
  return {
    siteId: siteId.trim(),
    repo: repo.trim(),
    branch: branch.trim(),
    projectRoot: projectRoot ? path.resolve(projectRoot) : '',
    scenario: scenario.trim(),
  }
}

/**
 * Run a child process while preserving its output for both the operator and assertions.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, echo?: boolean }} [options]
 * @returns {Promise<CommandResult>}
 */
function runCommand(command, args, { cwd = REPO_ROOT, env = process.env, echo = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      if (echo) process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      if (echo) process.stderr.write(text)
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: Number.isInteger(code) ? Number(code) : 1, stdout, stderr }))
  })
}

/** @param {string} projectRoot @returns {CanaryWorkflowState[]} */
function workflowStates(projectRoot) {
  const root = path.join(projectRoot, '.nax', 'workflows')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'workflow.json'))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      const parsed = /** @type {CanaryWorkflowState} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')))
      return { ...parsed, dir: path.dirname(filePath) }
    })
}

/**
 * Give NAX's transport detector the same local context created by `netlify link`.
 * The default canary path is a disposable clone; an explicitly supplied project
 * root must either be unlinked or already linked to the requested site.
 * @param {string} projectRoot
 * @param {string} siteId
 */
function ensureDisposableSiteLink(projectRoot, siteId) {
  const netlifyDir = path.join(projectRoot, '.netlify')
  const statePath = path.join(netlifyDir, 'state.json')
  if (fs.existsSync(statePath)) {
    const state = record(JSON.parse(fs.readFileSync(statePath, 'utf8'))) || {}
    assert.equal(state.siteId, siteId, `Existing ${statePath} points at a different site`)
    return
  }
  fs.mkdirSync(netlifyDir, { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify({ siteId }, null, 2)}\n`, { mode: 0o600 })
}

/** @param {CanaryWorkflowState} state @returns {JsonRecord[]} */
function workflowEvents(state) {
  const eventPath = path.join(stringValue(state.dir), 'events.jsonl')
  if (!fs.existsSync(eventPath)) return []
  return fs.readFileSync(eventPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => /** @type {JsonRecord} */ (JSON.parse(line)))
}

/** @param {CanaryWorkflowState} state @param {string} stepId @returns {CanaryStep} */
function requiredStep(state, stepId) {
  const step = (state.steps || []).find((candidate) => candidate.id === stepId)
  assert.ok(step, `Missing step ${stepId} in ${state.flowId || 'unknown flow'}`)
  return step
}

/** @param {CanaryAgentRun} run @returns {JsonRecord} */
function handleInput(run) {
  const handle = record(run.sdkHandle) || {}
  return record(handle.kind === 'session' ? handle.sessionInput : handle.input) || {}
}

/**
 * @param {CanaryWorkflowState} state
 * @param {string} stepId
 * @returns {{ maxActive: number, sixthSubmittedAt: string, firstReleaseAt: string }}
 */
function schedulerEvidence(state, stepId) {
  const events = workflowEvents(state)
    .filter((event) => event.type === 'agent_status' && event.stepId === stepId)
    .sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0))
  const active = new Set()
  let maxActive = 0
  const submissions = []
  const releases = []
  for (const event of events) {
    const instanceId = stringValue(event.instanceId)
    const status = stringValue(event.status)
    if (status === 'submitted' && instanceId) {
      active.add(instanceId)
      submissions.push(event)
      maxActive = Math.max(maxActive, active.size)
    }
    if (instanceId && (event.terminal === true || TERMINAL_STATUSES.has(status))) {
      if (active.delete(instanceId)) releases.push(event)
    }
  }
  assert.equal(submissions.length, 6, 'The combo step must submit six instances')
  assert.ok(maxActive <= 5, `Observed ${maxActive} simultaneous non-terminal runners`)
  const sixthSequence = Number(submissions[5].seq || 0)
  const priorRelease = releases.find((event) => Number(event.seq || 0) < sixthSequence)
  assert.ok(priorRelease, 'The sixth instance was submitted before any scheduler slot was released')
  return {
    maxActive,
    sixthSubmittedAt: stringValue(submissions[5].at),
    firstReleaseAt: stringValue(priorRelease.at),
  }
}

/** @param {CanaryWorkflowState} state @param {string} stepId @returns {string[]} */
function resultArtifactPaths(state, stepId) {
  return workflowEvents(state)
    .filter((event) => event.type === 'artifact_written' && event.kind === 'agent_result' && event.stepId === stepId)
    .map((event) => stringValue(event.relativePath))
    .filter(Boolean)
}

/**
 * @param {string} flowId
 * @param {CanaryOptions} options
 * @param {string} projectRoot
 * @param {'zero' | 'nonzero'} expectedExit
 * @returns {Promise<{ state: CanaryWorkflowState, result: CommandResult }>}
 */
async function runScenario(flowId, options, projectRoot, expectedExit) {
  const priorRunIds = new Set(workflowStates(projectRoot).map((state) => state.runId))
  console.log(`\n=== ${flowId} ===`)
  const result = await runCommand(process.execPath, [
    NAX_CLI,
    'run',
    flowId,
    '--project-root', projectRoot,
    '--flows-dir', FLOW_ROOT,
    '--repo', options.repo,
    '--site-id', options.siteId,
    '--branch', options.branch,
    '--transport', 'netlify-api',
    '--timeout-minutes', '8',
    '--no-auto-context',
    '--force',
  ])
  if (expectedExit === 'zero') assert.equal(result.code, 0, `${flowId} exited ${result.code}`)
  else assert.notEqual(result.code, 0, `${flowId} unexpectedly exited zero`)
  const state = workflowStates(projectRoot).find((candidate) => (
    candidate.flowId === flowId && !priorRunIds.has(candidate.runId)
  ))
  assert.ok(state, `No new durable state found for ${flowId}`)
  return { state, result }
}

/** @param {CanaryWorkflowState} state */
function assertCombo(state) {
  assert.equal(state.status, 'completed')
  const compare = requiredStep(state, 'compare')
  const followUp = requiredStep(state, 'continue')
  assert.equal(compare.status, 'completed')
  assert.equal(followUp.status, 'completed')
  assert.equal(compare.runs?.length, 6)
  assert.equal(followUp.runs?.length, 6)
  assert.deepEqual(
    (compare.runs || []).map((run) => run.instanceId),
    [
      'claude:claude-opus-5:auto',
      'claude:claude-opus-4-8:auto',
      'claude:claude-fable-5:auto',
      'codex:gpt-5.6-sol:low',
      'codex:gpt-5.6-sol:medium',
      'codex:gpt-5.6-sol:high',
    ],
  )
  const followUpByInstance = new Map((followUp.runs || []).map((run) => [run.instanceId, run]))
  for (const source of compare.runs || []) {
    const continued = followUpByInstance.get(source.instanceId)
    assert.ok(continued, `Missing inherited instance ${source.instanceId || 'unknown'}`)
    assert.equal(continued.runnerId, source.runnerId, `Runner changed for ${source.instanceId || 'unknown'}`)
    assert.notEqual(continued.sessionId, source.sessionId, `Session was not continued for ${source.instanceId || 'unknown'}`)
    assert.deepEqual(
      {
        agent: handleInput(continued).agent,
        model: handleInput(continued).model,
        effort: handleInput(continued).effort,
      },
      {
        agent: source.agent,
        model: source.model,
        effort: source.effort,
      },
    )
  }
  const artifactPaths = resultArtifactPaths(state, 'compare')
  assert.equal(artifactPaths.length, 6)
  assert.equal(new Set(artifactPaths).size, 6, 'Combo result artifacts collided')
}

/** @param {CanaryWorkflowState} state */
function assertAuto(state) {
  assert.equal(state.status, 'completed')
  const council = requiredStep(state, 'council')
  assert.equal(council.status, 'completed')
  assert.equal(council.runs?.length, 3)
  assert.deepEqual((council.runs || []).map((run) => run.instanceId), [
    'claude:auto:auto',
    'gemini:auto:auto',
    'codex:auto:auto',
  ])
  for (const run of council.runs || []) {
    assert.equal(Object.hasOwn(run, 'model'), false, `${run.agent || 'agent'} state pinned a model`)
    assert.equal(Object.hasOwn(run, 'effort'), false, `${run.agent || 'agent'} state pinned an effort`)
    const input = handleInput(run)
    assert.equal(Object.hasOwn(input, 'model'), false, `${run.agent || 'agent'} wire input pinned a model`)
    assert.equal(Object.hasOwn(input, 'effort'), false, `${run.agent || 'agent'} wire input pinned an effort`)
  }
}

/** @param {CanaryWorkflowState} state */
function assertPartial(state) {
  assert.equal(state.status, 'completed')
  const mixed = requiredStep(state, 'mixed')
  const followUp = requiredStep(state, 'survivor-continues')
  assert.equal(mixed.status, 'completed_with_failures')
  assert.equal(followUp.status, 'completed')
  const succeeded = (mixed.runs || []).filter((run) => run.status === 'completed')
  const failed = (mixed.runs || []).filter((run) => run.status === 'failed' || run.status === 'timeout')
  assert.equal(succeeded.length, 1)
  assert.equal(failed.length, 1)
  assert.equal(followUp.runs?.length, 1, 'A failed instance leaked into the follow-up')
  const continued = (followUp.runs || [])[0]
  assert.equal(continued.instanceId, succeeded[0].instanceId)
  assert.equal(continued.runnerId, succeeded[0].runnerId)
  assert.notEqual(continued.sessionId, succeeded[0].sessionId)
}

/** @param {CanaryWorkflowState} state */
function assertAllFailed(state) {
  assert.equal(state.status, 'failed')
  const rejected = requiredStep(state, 'rejected')
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.runs?.length, 2)
  assert.ok((rejected.runs || []).every((run) => run.status === 'failed' || run.status === 'timeout'))
  assert.equal((state.steps || []).some((step) => step.id === 'must-not-run'), false, 'The halt sentinel ran')
}

/** @param {CanaryWorkflowState[]} states @returns {string[]} */
function runnerIds(states) {
  const durableIds = states.flatMap((state) => (state.steps || [])
    .flatMap((step) => step.runs || [])
    .map((run) => run.runnerId || ''))
  const eventIds = states.flatMap((state) => workflowEvents(state)
    .filter((event) => event.type === 'agent_status')
    .map((event) => stringValue(event.runnerId)))
  return [...new Set([...durableIds, ...eventIds].filter(Boolean))]
}

/**
 * Archive all remote runners created by the canary.
 * @param {string[]} ids
 * @returns {Promise<{ attempted: number, archived: number }>}
 */
async function archiveRunners(ids) {
  if (ids.length === 0) return { attempted: 0, archived: 0 }
  const sdk = createAgentRunnerSdk()
  const results = await Promise.allSettled(ids.map((runnerId) => sdk.transport.member(runnerId, 'archive', {})))
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length > 0) throw new Error(`Failed to archive ${failures.length} of ${ids.length} canary runners`)
  return { attempted: ids.length, archived: results.length }
}

/** @param {CanaryWorkflowState[]} states @returns {{ runner: Map<string, string>, session: Map<string, string>, workflow: Map<string, string> }} */
function idAliases(states) {
  const runner = new Map()
  const session = new Map()
  const workflow = new Map()
  for (const [stateIndex, state] of states.entries()) {
    if (state.runId) workflow.set(state.runId, `workflow-${String(stateIndex + 1).padStart(2, '0')}`)
    for (const step of state.steps || []) {
      for (const run of step.runs || []) {
        if (run.runnerId && !runner.has(run.runnerId)) runner.set(run.runnerId, `runner-${String(runner.size + 1).padStart(2, '0')}`)
        if (run.sessionId && !session.has(run.sessionId)) session.set(run.sessionId, `session-${String(session.size + 1).padStart(2, '0')}`)
      }
    }
  }
  return { runner, session, workflow }
}

/**
 * @param {CanaryWorkflowState} state
 * @param {{ runner: Map<string, string>, session: Map<string, string>, workflow: Map<string, string> }} aliases
 * @returns {JsonRecord}
 */
function sanitizedStateEvidence(state, aliases) {
  return {
    id: aliases.workflow.get(state.runId || '') || 'workflow-unknown',
    flowId: state.flowId || '',
    status: state.status || '',
    startedAt: state.createdAt || '',
    completedAt: state.completedAt || '',
    steps: (state.steps || []).map((step) => ({
      id: step.id || '',
      status: step.status || '',
      instances: (step.runs || []).map((run) => ({
        instanceId: run.instanceId || '',
        status: run.status || '',
        runnerId: aliases.runner.get(run.runnerId || '') || '',
        sessionId: aliases.session.get(run.sessionId || '') || '',
      })),
    })),
  }
}

/** @param {CanaryOptions} options */
async function main(options) {
  const temporaryRoot = options.projectRoot ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'nax-multi-canary-'))
  const projectRoot = options.projectRoot || path.join(temporaryRoot, 'project')
  /** @type {CanaryWorkflowState[]} */
  const states = []
  /** @type {{ attempted: number, archived: number }} */
  let cleanup = { attempted: 0, archived: 0 }
  try {
    if (!options.projectRoot) {
      const clone = await runCommand('gh', [
        'repo', 'clone', options.repo, projectRoot, '--',
        '--depth', '1', '--branch', options.branch,
      ])
      assert.equal(clone.code, 0, 'Could not clone the disposable canary repository')
    }
    ensureDisposableSiteLink(projectRoot, options.siteId)

    /** @type {CanaryScenario[]} */
    const allScenarios = [
      { flowId: 'arena-combo-canary', expectedExit: 'zero' },
      { flowId: 'arena-auto-canary', expectedExit: 'zero' },
      { flowId: 'arena-partial-canary', expectedExit: 'zero' },
      { flowId: 'arena-all-failed-canary', expectedExit: 'nonzero' },
    ]
    const scenarios = options.scenario
      ? allScenarios.filter((scenario) => scenario.flowId === options.scenario)
      : allScenarios
    assert.ok(scenarios.length > 0, `Unknown canary scenario: ${options.scenario}`)
    for (const scenario of scenarios) {
      const { state } = await runScenario(scenario.flowId, options, projectRoot, scenario.expectedExit)
      states.push(state)
      if (scenario.flowId === 'arena-combo-canary') assertCombo(state)
      if (scenario.flowId === 'arena-auto-canary') assertAuto(state)
      if (scenario.flowId === 'arena-partial-canary') assertPartial(state)
      if (scenario.flowId === 'arena-all-failed-canary') assertAllFailed(state)
    }

    const comboState = states.find((state) => state.flowId === 'arena-combo-canary')
    const scheduler = comboState ? schedulerEvidence(comboState, 'compare') : null
    const aliases = idAliases(states)
    cleanup = await archiveRunners(runnerIds(states))
    console.log('\n=== sanitized evidence ===')
    console.log(JSON.stringify({
      schema: 'nax-multi-instance-canary-v1',
      completedAt: new Date().toISOString(),
      target: {
        site: 'dedicated-disposable-site',
        repo: options.repo,
        branch: options.branch,
      },
      assertions: {
        ...(comboState && scheduler ? {
          distinctArtifacts: resultArtifactPaths(comboState, 'compare').length,
          maxSimultaneousNonTerminal: scheduler.maxActive,
          firstSlotReleasedAt: scheduler.firstReleaseAt,
          sixthInstanceSubmittedAt: scheduler.sixthSubmittedAt,
          followUpRunnerIdentityPreserved: true,
          followUpSessionIdentityAdvanced: true,
        } : {}),
        ...(states.some((state) => state.flowId === 'arena-auto-canary')
          ? { bareProvidersOmittedModelAndEffort: true }
          : {}),
        ...(states.some((state) => state.flowId === 'arena-partial-canary')
          ? { partialFailureSurvivorsOnly: true }
          : {}),
        ...(states.some((state) => state.flowId === 'arena-all-failed-canary')
          ? { allFailedHaltedBeforeSentinel: true }
          : {}),
      },
      workflows: states.map((state) => sanitizedStateEvidence(state, aliases)),
      cleanup,
    }, null, 2))
  } finally {
    if (states.length > 0 && cleanup.archived === 0) {
      cleanup = await archiveRunners(runnerIds(states))
      console.error(`Archived ${cleanup.archived}/${cleanup.attempted} canary runners during failure cleanup.`)
    }
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

const options = parseArgs(process.argv.slice(2))
main(options).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
