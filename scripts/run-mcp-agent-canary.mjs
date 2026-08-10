#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  assertCanaryContext,
  assertCanaryPlan,
  assertCanaryRepository,
  assertCanaryUsage,
  canaryDiagnostic,
  loadMcpCanaryConfig,
} = require('../src/mcp/canary')

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..')
const TERMINAL = new Set(['abandoned', 'cancelled', 'completed', 'completed_with_failures', 'dismissed', 'failed', 'skipped'])
const CANARY_PROMPT = 'Return a short confirmation that this bounded NAX MCP Agent Runner canary executed successfully. Do not modify files or external state.'

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {string} phase @param {Record<string, string | number | boolean | null>} details */
function report(phase, details) {
  process.stderr.write(`${JSON.stringify(canaryDiagnostic(phase, details))}\n`)
}

class CanaryMcpClient {
  /** @param {string} projectRoot */
  constructor(projectRoot) {
    const env = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, FORCE_COLOR: '0', CLAUDE_PROJECT_DIR: projectRoot })
    delete env.NO_COLOR
    this.child = spawn(process.execPath, [path.join(REPOSITORY_ROOT, 'src', 'cli', 'nax.js'), 'mcp'], {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.nextId = 1
    this.buffer = ''
    this.stderr = ''
    /** @type {Map<number, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString() })
    this.child.stdout.on('data', (chunk) => this.onData(chunk.toString()))
    this.child.on('exit', (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`MCP child exited with code ${code}.`))
      }
      this.pending.clear()
    })
  }

  /** @param {string} text */
  onData(text) {
    this.buffer += text
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = /** @type {Record<string, unknown>} */ (JSON.parse(line))
      const id = Number(message.id)
      const pending = this.pending.get(id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve(message)
    }
  }

  /** @param {string} method @param {Record<string, unknown>} params */
  request(method, params) {
    const id = this.nextId
    this.nextId += 1
    return /** @type {Promise<Record<string, unknown>>} */ (new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for MCP method ${method}.`))
      }, 35000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }))
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'nax-real-agent-canary', version: '1.0.0' },
    })
    if (response.error) throw new Error(`MCP initialize failed: ${JSON.stringify(response.error)}`)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }

  /** @param {string} name @param {Record<string, unknown>} args */
  async callTool(name, args) {
    const response = await this.request('tools/call', { name, arguments: args })
    if (response.error) throw new Error(`${name} protocol failure: ${JSON.stringify(response.error)}`)
    const result = objectValue(response.result)
    const structured = objectValue(result.structuredContent)
    if (result.isError === true || structured.ok !== true) {
      const error = objectValue(structured.error)
      throw new Error(`${name} failed (${String(error.code || 'unknown')}): ${String(error.message || 'No message')}`)
    }
    return { result, structured }
  }

  async close() {
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM')
        resolve(undefined)
      }, 5000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
  }
}

/** @param {string} projectRoot */
function gitRemote(projectRoot) {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: projectRoot, encoding: 'utf8', timeout: 5000 })
  if (result.status !== 0 || !String(result.stdout || '').trim()) throw new Error('The canary project must have a readable remote.origin.url.')
  return String(result.stdout).trim()
}

/** @param {unknown} details */
function firstArtifactUri(details) {
  const artifacts = objectValue(details).artifacts
  if (!Array.isArray(artifacts)) return ''
  for (const artifact of artifacts) {
    const uri = String(objectValue(artifact).resourceUri || '')
    if (uri.startsWith('nax://')) return uri
  }
  return ''
}

/** @param {unknown} resource */
function resourceSize(resource) {
  const contents = objectValue(resource).contents
  if (!Array.isArray(contents) || contents.length === 0) return 0
  const item = objectValue(contents[0])
  if (typeof item.text === 'string') return Buffer.byteLength(item.text)
  if (typeof item.blob === 'string') return Buffer.byteLength(item.blob, 'base64')
  return 0
}

async function main() {
  const config = loadMcpCanaryConfig(process.env, { canonicalize: (projectRoot) => path.resolve(projectRoot) })
  assertCanaryRepository(config, gitRemote(config.projectRoot))
  report('preflight', {
    repository: config.repository,
    siteId: config.siteId,
    accountSlug: config.accountSlug,
    branch: config.branch,
    maxRunners: config.maxRunners,
    maxCredits: config.maxCredits,
    timeoutMs: config.timeoutMs,
    requestId: config.requestId,
  })

  const startedAt = Date.now()
  const client = new CanaryMcpClient(config.projectRoot)
  let runId = ''
  try {
    await client.initialize()
    const contextCall = await client.callTool('context_get', {})
    const context = objectValue(contextCall.structured.data)
    assertCanaryContext(config, context)
    report('context_verified', { elapsedMs: Date.now() - startedAt, runtime: String(context.runtime), siteId: config.siteId })

    const planCall = await client.callTool('agent_run_plan', {
      prompt: CANARY_PROMPT,
      instance: { agent: config.agent },
      branch: config.branch,
    })
    const plan = objectValue(planCall.structured.data)
    assertCanaryPlan(config, plan)
    const planText = Array.isArray(planCall.result.content) ? String(objectValue(planCall.result.content[0]).text || '') : ''
    if (!planText.includes(config.siteId) || !planText.includes(config.branch) || !/Remote runners:\s*1/.test(planText)) {
      throw new Error('The human-readable canary plan did not confirm the exact site, branch, and one-run budget.')
    }
    report('plan_verified', {
      elapsedMs: Date.now() - startedAt,
      planId: String(plan.planId),
      expectedAgentRuns: Number(plan.expectedAgentRuns),
    })

    const startArgs = { plan_id: String(plan.planId), request_id: config.requestId }
    const firstStart = await client.callTool('run_start', startArgs)
    const firstStartData = objectValue(firstStart.structured.data)
    runId = String(objectValue(firstStartData.run).runId || '')
    if (!runId || firstStartData.replayed === true) throw new Error('The first canary start did not create one new durable run.')
    const replay = await client.callTool('run_start', startArgs)
    const replayData = objectValue(replay.structured.data)
    if (replayData.replayed !== true || String(objectValue(replayData.run).runId || '') !== runId) {
      throw new Error('The repeated canary start did not replay the original durable run.')
    }
    report('start_replayed', { elapsedMs: Date.now() - startedAt, runId, requestId: config.requestId })

    let cursor = '0'
    let status = String(objectValue(firstStartData.run).status || '')
    let events = 0
    const deadline = startedAt + config.timeoutMs
    while (!TERMINAL.has(status)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Canary run ${runId} exceeded its ${config.timeoutMs}ms wall-clock budget.`)
      const waited = await client.callTool('run_wait', { run_id: runId, since: cursor, timeout_ms: Math.min(30000, remaining) })
      const waitData = objectValue(waited.structured.data)
      cursor = String(waitData.nextCursor || cursor)
      status = String(objectValue(waitData.run).status || status)
      events += Array.isArray(waitData.events) ? waitData.events.length : 0
      report('wait', {
        elapsedMs: Date.now() - startedAt,
        runId,
        status,
        reason: String(waitData.reason || ''),
        eventCount: events,
        cursor,
      })
      if (String(waitData.reason) === 'review' || String(waitData.reason) === 'stalled') {
        throw new Error(`Canary run ${runId} requires human intervention (${String(waitData.reason)}).`)
      }
    }
    if (status !== 'completed') throw new Error(`Canary run ${runId} ended in ${status}.`)

    const read = await client.callTool('run_get', { run_id: runId, view: 'details' })
    const runRead = objectValue(read.structured.data)
    const run = objectValue(runRead.run)
    const agentRuns = Array.isArray(run.agentRuns) ? run.agentRuns : []
    if (agentRuns.length !== config.maxRunners) throw new Error(`Canary run ${runId} reported ${agentRuns.length} Agent Runners instead of one.`)
    const credits = assertCanaryUsage(config, run)
    const artifactUri = firstArtifactUri(runRead.details)
    if (!artifactUri) throw new Error(`Canary run ${runId} did not expose an artifact resource.`)
    const resource = await client.request('resources/read', { uri: artifactUri })
    if (resource.error) throw new Error(`Canary artifact read failed: ${JSON.stringify(resource.error)}`)
    const artifactBytes = resourceSize(resource.result)
    if (artifactBytes <= 0) throw new Error(`Canary run ${runId} returned an empty artifact.`)
    report('complete', {
      elapsedMs: Date.now() - startedAt,
      runId,
      status,
      agentRuns: agentRuns.length,
      eventCount: events,
      credits,
      artifactBytes,
    })
  } catch (error) {
    report('failed', {
      elapsedMs: Date.now() - startedAt,
      runId: runId || null,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  process.stderr.write(`MCP Agent Runner canary failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
