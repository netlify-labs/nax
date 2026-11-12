// Turn engine behind `nax acp`: maps ACP sessions and prompts onto Netlify Agent Runner runs.
// One ACP session is one agent runner; its first prompt starts the runner and later prompts are follow-up sessions.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { validateAgentConfig } = require('../../core/agents/configuration')
const { formatAgentRunUrl } = require('../../workflows/results/agent-run-results')
const { createNaxAgentRunnerSdk } = require('../netlify/agent-runner-sdk')
const { createNetlifyApiClient } = require('../netlify/api-client')
const { listLinkedNetlifySites, resolveNetlifyProjectTarget } = require('../netlify/local-runner')
const { gitRepositoryRoot, resolveProjectRoot } = require('../netlify/project-selection')
const { defaultSessionConfig, sessionConfigOptions, updateSessionConfig } = require('./session-config')
const { loadAcpSession, saveAcpSession } = require('./session-store')
const { runCommand } = require('../git/review-context')
const { applyPatchFile, inspectWorkspace, workspaceWarnings } = require('./workspace')

const ACP_PROTOCOL_VERSION = 1
const DEFAULT_POLL_INTERVAL_MS = 10000
// Instructions ACP clients add for their own tools and UI, which an agent runner cannot use.
const CLIENT_INSTRUCTION_BLOCKS = /<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>/g
// Where agent runners check out the site repository; runner replies cite files under it.
const RUNNER_REPO_PATH = /\/opt\/build\/repo(?![\w-]|\.\w)/g

/**
 * @typedef {import('nax-agent-runner-sdk').AgentRunnerSdk} AgentRunnerSdk
 * @typedef {import('nax-agent-runner-sdk').Handle} Handle
 * @typedef {import('nax-agent-runner-sdk').RunResult} RunResult
 * @typedef {import('./session-store').AcpSessionRecord} AcpSessionRecord
 * @typedef {import('./session-config').AcpSiteChoice} AcpSiteChoice
 *
 * @typedef {{ requestResponse: (method: string, apiPath: string) => Promise<{ ok: boolean, status: number, text: string, payload: unknown }> }} AcpApiClient
 *
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).SessionUpdate} AcpSessionUpdate
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).ContentBlock} AcpContentBlock
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).InitializeRequest} AcpInitializeRequest
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).InitializeResponse} AcpInitializeResponse
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).NewSessionRequest} AcpNewSessionRequest
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).NewSessionResponse} AcpNewSessionResponse
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).LoadSessionRequest} AcpLoadSessionRequest
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).LoadSessionResponse} AcpLoadSessionResponse
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).SetSessionConfigOptionRequest} AcpSetConfigOptionRequest
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).SetSessionConfigOptionResponse} AcpSetConfigOptionResponse
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).PromptRequest} AcpPromptRequest
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).PromptResponse} AcpPromptResponse
 * @typedef {import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).CancelNotification} AcpCancelNotification
 *
 * @typedef {{
 *   record: AcpSessionRecord,
 *   sdk: AgentRunnerSdk | null,
 *   api: AcpApiClient | null,
 *   handle: Handle | null,
 *   sites: AcpSiteChoice[],
 *   cancelRequested: boolean,
 * }} LiveSession
 *
 * @typedef {LiveSession & { sdk: AgentRunnerSdk, api: AcpApiClient }} ConnectedSession
 *
 * @typedef {{
 *   createSdk?: (input: { siteId: string }) => AgentRunnerSdk,
 *   createApi?: (input: { siteId: string }) => AcpApiClient,
 *   resolveSite?: (cwd: string) => { projectRoot: string, siteId: string },
 *   listSites?: (cwd: string) => AcpSiteChoice[],
 *   verifySiteRepo?: (input: { api: AcpApiClient, siteId: string, repoRoot: string }) => Promise<void>,
 *   inspect?: typeof inspectWorkspace,
 *   applyPatch?: typeof applyPatchFile,
 *   sendUpdate: (sessionId: string, update: AcpSessionUpdate) => Promise<void>,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   pollIntervalMs?: number,
 *   newSessionId?: () => string,
 *   now?: () => Date,
 *   version?: string,
 * }} NaxAcpAgentOptions
 */

/**
 * Finds the Netlify site linked to an ACP session's working directory.
 * Site discovery scans the project tree, so folders outside a git repository are refused rather than scanned.
 * @param {string} cwd
 * @returns {{ projectRoot: string, siteId: string }}
 */
function resolveAcpSite(cwd) {
  if (!gitRepositoryRoot(cwd)) {
    throw new Error(`${cwd} is not inside a git repository. Netlify agent runners work on a site's git repository; open that repository's folder.`)
  }
  const projectRoot = resolveProjectRoot('', { cwd })
  const target = resolveNetlifyProjectTarget({ projectRoot })
  if (!target.siteId) {
    throw new Error(`No linked Netlify site for ${cwd}. Run "netlify link" there, or set NETLIFY_SITE_ID in the provider's environment.`)
  }
  return { projectRoot, siteId: target.siteId }
}

/**
 * Lists the Netlify sites linked anywhere in the session's repository, one choice per site.
 * @param {string} cwd
 * @returns {AcpSiteChoice[]}
 */
function listAcpSites(cwd) {
  const repoRoot = gitRepositoryRoot(cwd)
  if (!repoRoot) return []
  /** @type {Map<string, AcpSiteChoice>} */
  const bySite = new Map()
  for (const linked of listLinkedNetlifySites(repoRoot)) {
    const label = linked.dir === '.' ? 'repository root' : linked.dir
    const existing = bySite.get(linked.siteId)
    if (existing) existing.label = `${existing.label}, ${label}`
    else bySite.set(linked.siteId, { siteId: linked.siteId, label, dir: path.join(repoRoot, linked.dir) })
  }
  return [...bySite.values()]
}

/**
 * Reduces a git remote URL to host/path so SSH and HTTPS forms of one repository compare equal.
 * @param {string} url
 * @returns {string}
 */
function repoIdentity(url) {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const scp = trimmed.match(/^[\w.-]+@([^:/]+):(.+)$/)
  const bare = scp ? `${scp[1]}/${scp[2]}` : trimmed.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '')
  return bare.toLowerCase()
}

/**
 * Refuses a site whose builds come from another repository: its agent runners would never see this code.
 * @param {{ api: AcpApiClient, siteId: string, repoRoot: string }} input
 * @returns {Promise<void>}
 */
async function verifyAcpSiteRepo({ api, siteId, repoRoot }) {
  const origin = runCommand('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot })
  if (origin.status !== 0 || !origin.stdout) return
  const response = await api.requestResponse('GET', `/sites/${siteId}`)
  if (!response.ok) throw new Error(`Could not read Netlify site ${siteId} (HTTP ${response.status}).`)
  const site = /** @type {{ name?: string, build_settings?: { repo_url?: string } }} */ (response.payload || {})
  const name = site.name || siteId
  const local = repoIdentity(origin.stdout)
  const fix = `Link this folder to a site that builds ${local} with "netlify link", or pick one in the Netlify site option.`
  const repoUrl = site.build_settings?.repo_url || ''
  if (!repoUrl) {
    throw new Error(`Netlify site ${name} is not connected to a git repository, so its agent runners cannot work on ${local}. ${fix}`)
  }
  const remote = repoIdentity(repoUrl)
  if (remote !== local) throw new Error(`Netlify site ${name} builds ${remote}, not ${local}. ${fix}`)
}

/**
 * Picks the linked site whose folder contains the session's folder, if any.
 * @param {AcpSiteChoice[]} sites
 * @param {string} cwd
 * @returns {string}
 */
function siteContaining(sites, cwd) {
  const containing = sites
    .filter((site) => cwd === site.dir || cwd.startsWith(`${site.dir}${path.sep}`))
    .sort((a, b) => b.dir.length - a.dir.length)
  return containing[0]?.siteId || ''
}

/**
 * Flattens ACP prompt content into the text an agent runner receives.
 * @param {AcpContentBlock[]} blocks
 * @returns {string}
 */
function promptText(blocks) {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text || ''
    if (block.type === 'resource' && 'text' in block.resource) return `\n<file uri="${block.resource.uri}">\n${block.resource.text}\n</file>\n`
    if (block.type === 'resource_link') return `@${block.uri}`
    return ''
  }).join('').replace(CLIENT_INSTRUCTION_BLOCKS, '').trim()
}

/**
 * Points file paths in a runner reply at the local repository.
 * @param {string} text
 * @param {string} repoRoot
 * @returns {string}
 */
function localizeRunnerPaths(text, repoRoot) {
  return repoRoot ? text.replace(RUNNER_REPO_PATH, repoRoot) : text
}

/**
 * @param {string} text
 * @returns {AcpSessionUpdate}
 */
function agentMessage(text) {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

/**
 * @param {string[]} files
 * @returns {string}
 */
function fileList(files) {
  return `${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`
}

/**
 * @param {NaxAcpAgentOptions} options
 */
function createNaxAcpAgent({
  createSdk = ({ siteId }) => createNaxAgentRunnerSdk({ siteId }),
  createApi = ({ siteId }) => createNetlifyApiClient({ siteId }),
  resolveSite = resolveAcpSite,
  listSites = listAcpSites,
  verifySiteRepo = verifyAcpSiteRepo,
  inspect = inspectWorkspace,
  applyPatch = applyPatchFile,
  sendUpdate,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  newSessionId = () => `nax-${randomUUID()}`,
  now = () => new Date(),
  version = '',
}) {
  /** @type {Map<string, LiveSession>} */
  const sessions = new Map()

  /**
   * Tracks a session; one with a known site also gets its runner clients and saved handle.
   * @param {AcpSessionRecord} record
   * @param {AcpSiteChoice[]} sites
   * @returns {LiveSession}
   */
  function openSession(record, sites) {
    const sdk = record.siteId ? createSdk({ siteId: record.siteId }) : null
    const live = {
      record,
      sdk,
      api: record.siteId ? createApi({ siteId: record.siteId }) : null,
      handle: sdk && record.handle ? sdk.parseHandle(record.handle) : null,
      sites,
      cancelRequested: false,
    }
    sessions.set(record.sessionId, live)
    return live
  }

  /**
   * Resolves and checks the session's site and branch on its first prompt, so clients that only probe sessions cost nothing.
   * @param {LiveSession} live
   * @returns {Promise<ConnectedSession>}
   */
  async function connectSession(live) {
    if (!live.sdk || !live.api) {
      const { projectRoot, siteId } = chooseSite(live)
      const repoRoot = gitRepositoryRoot(live.record.cwd) || projectRoot
      const api = createApi({ siteId })
      await verifySiteRepo({ api, siteId, repoRoot })
      const workspace = inspect({ cwd: live.record.cwd })
      live.record = {
        ...live.record,
        projectRoot,
        repoRoot,
        siteId,
        branch: workspace.remoteSha ? workspace.branch : '',
      }
      live.sdk = createSdk({ siteId })
      live.api = api
    }
    return /** @type {ConnectedSession} */ (live)
  }

  /** @param {string} sessionId @returns {LiveSession} */
  function liveSession(sessionId) {
    const live = sessions.get(sessionId)
    if (!live) throw new Error(`Unknown ACP session ${sessionId}. Create or load it first.`)
    return live
  }

  /**
   * Uses the site picked in the session's config, else the site linked to its folder.
   * @param {LiveSession} live
   * @returns {{ projectRoot: string, siteId: string }}
   */
  function chooseSite(live) {
    const chosen = live.sites.find((site) => site.siteId === live.record.config.site)
    if (chosen) return { projectRoot: chosen.dir, siteId: chosen.siteId }
    try {
      return resolveSite(live.record.cwd)
    } catch (error) {
      if (live.sites.length === 1) return { projectRoot: live.sites[0].dir, siteId: live.sites[0].siteId }
      if (live.sites.length > 1) {
        throw new Error(`This repository links ${live.sites.length} Netlify sites. Choose one in the Netlify site option: ${live.sites.map((site) => site.label).join(', ')}.`)
      }
      throw error
    }
  }

  /** @param {ConnectedSession} live */
  function save(live) {
    live.record = {
      ...live.record,
      handle: live.handle ? live.sdk.serializeHandle(live.handle) : null,
      updatedAt: now().toISOString(),
    }
    saveAcpSession(live.record)
  }

  /**
   * Starts the runner on the first turn, or a follow-up session on later turns.
   * @param {ConnectedSession} live
   * @param {string} text
   * @returns {Promise<Handle>}
   */
  async function submitTurn(live, text) {
    const { agent, model, effort } = validateAgentConfig(live.record.config)
    const runConfig = { agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    if (live.handle) return live.sdk.followUp(live.handle, { prompt: text, ...runConfig })
    return live.sdk.start({
      siteId: live.record.siteId,
      prompt: text,
      ...runConfig,
      ...(live.record.branch ? { branch: live.record.branch } : {}),
      land: 'none',
    })
  }

  /**
   * Polls the runner to a terminal result, reporting each new step on the turn's tool call.
   * @param {ConnectedSession} live
   * @param {string} toolCallId
   * @returns {Promise<RunResult>}
   */
  async function waitForResult(live, toolCallId) {
    const handle = /** @type {Handle} */ (live.handle)
    let lastStep = ''
    for (;;) {
      const snapshot = await live.sdk.getSnapshot(handle)
      if (snapshot.kind === 'terminal') return snapshot.result
      if (snapshot.latestStep && snapshot.latestStep !== lastStep) {
        lastStep = snapshot.latestStep
        await sendUpdate(live.record.sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', title: lastStep })
      }
      if (now().getTime() > handle.policy.deadlineAt && !live.cancelRequested) {
        live.cancelRequested = true
        await live.sdk.stop(handle)
        throw new Error(`Netlify agent runner ${handle.runnerId} hit its 25-minute limit and was stopped.`)
      }
      await sleep(pollIntervalMs)
    }
  }

  /**
   * Fetches this session's own diff and applies it to the workspace, saving the patch beside the session record.
   * @param {ConnectedSession} live
   * @param {Extract<RunResult, { status: 'succeeded' }>} result
   * @returns {Promise<string>}
   */
  async function applyTurnChanges(live, result) {
    if (result.changes === 'unchanged') return ''
    const { runnerId, sessionId } = result
    const response = await live.api.requestResponse('GET', `/agent_runners/${runnerId}/sessions/${sessionId}/diff/result`)
    if (response.status === 404 || (response.ok && !response.text.trim())) {
      return result.changes === 'changed' ? 'The agent runner reported changes, but its diff is not available.' : ''
    }
    if (!response.ok) throw new Error(`Could not fetch the diff for agent runner ${runnerId} session ${sessionId} (HTTP ${response.status}).`)
    const patchPath = path.join(live.record.repoRoot, '.nax', 'acp-sessions', live.record.sessionId, `${sessionId}.patch`)
    fs.mkdirSync(path.dirname(patchPath), { recursive: true })
    fs.writeFileSync(patchPath, response.text)
    // Runner diffs are relative to the repository root; git apply skips paths outside a subfolder cwd.
    const applied = applyPatch({ cwd: live.record.repoRoot, patchPath })
    if (applied.status === 'applied') return `Applied changes to ${fileList(applied.files)}`
    return `The agent runner's changes to ${fileList(applied.files)} did not apply to the local workspace (${applied.detail}). The patch is saved at ${patchPath}`
  }

  /**
   * Opens or updates the runner's pull request; the session keeps its own landing policy for later turns.
   * @param {ConnectedSession} live
   * @returns {Promise<string>}
   */
  async function openPullRequest(live) {
    const handle = /** @type {Handle} */ (live.handle)
    const landed = await live.sdk.land({ ...handle, policy: { ...handle.policy, landing: 'pr' } })
    live.handle = landed.handle
    const landing = landed.landing
    if (landing.kind === 'prOpen' || landing.kind === 'merged') return `Pull request: ${landing.prUrl}`
    if (landing.kind === 'failed') return `Could not open a pull request: ${landing.failure.message}`
    if (landing.kind === 'unsupported') return `Could not open a pull request: ${landing.reason}`
    return ''
  }

  return {
    /** @param {AcpInitializeRequest} _params @returns {Promise<AcpInitializeResponse>} */
    async initialize(_params) {
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        authMethods: [],
        agentInfo: { name: 'nax', title: 'Netlify Agent Runners', version },
      }
    },

    /** @param {AcpNewSessionRequest} params @returns {Promise<AcpNewSessionResponse>} */
    async newSession({ cwd }) {
      const timestamp = now().toISOString()
      const sites = listSites(cwd)
      const live = openSession({
        version: 1,
        sessionId: newSessionId(),
        cwd,
        projectRoot: '',
        repoRoot: '',
        siteId: '',
        branch: '',
        config: { ...defaultSessionConfig(), site: siteContaining(sites, cwd) },
        handle: null,
        transcript: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }, sites)
      return { sessionId: live.record.sessionId, configOptions: sessionConfigOptions(live.record.config, sites) }
    },

    /** @param {AcpLoadSessionRequest} params @returns {Promise<AcpLoadSessionResponse>} */
    async loadSession({ sessionId, cwd }) {
      const repoRoot = gitRepositoryRoot(cwd)
      const record = repoRoot ? loadAcpSession(repoRoot, sessionId) : null
      if (!record) throw new Error(`Unknown ACP session ${sessionId} in ${cwd}.`)
      const live = openSession({ ...record, config: { ...defaultSessionConfig(), ...record.config } }, listSites(cwd))
      for (const entry of record.transcript) {
        await sendUpdate(sessionId, {
          sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: entry.text },
        })
      }
      return { configOptions: sessionConfigOptions(live.record.config, live.sites) }
    },

    /** @param {AcpSetConfigOptionRequest} params @returns {Promise<AcpSetConfigOptionResponse>} */
    async setConfigOption({ sessionId, configId, value }) {
      const live = liveSession(sessionId)
      if (typeof value !== 'string') throw new Error(`Session config option "${configId}" takes a string value.`)
      live.record = { ...live.record, config: updateSessionConfig(live.record.config, configId, value, live.sites) }
      if (live.sdk && live.api) save(/** @type {ConnectedSession} */ (live))
      return { configOptions: sessionConfigOptions(live.record.config, live.sites) }
    },

    /** @param {AcpPromptRequest} params @returns {Promise<AcpPromptResponse>} */
    async prompt({ sessionId, prompt }) {
      const live = await connectSession(liveSession(sessionId))
      live.cancelRequested = false
      const text = promptText(prompt)
      /** @type {string[]} */
      const reply = []
      /** @param {string} chunk */
      const say = async (chunk) => {
        reply.push(chunk)
        await sendUpdate(sessionId, agentMessage(chunk))
      }

      if (!live.handle) {
        const warnings = workspaceWarnings(inspect({ cwd: live.record.cwd }))
        if (warnings.length > 0) await say(`${warnings.map((warning) => `> ${warning}`).join('\n')}\n\n`)
      }

      live.record = { ...live.record, transcript: [...live.record.transcript, { role: 'user', text }] }
      live.handle = await submitTurn(live, text)
      save(live)
      if (live.cancelRequested) await live.sdk.stop(live.handle)

      const runner = await live.sdk.transport.getRunner(live.handle.runnerId)
      const runUrl = formatAgentRunUrl(runner.siteName || '', live.handle.runnerId, live.handle.currentSessionId)
      const toolCallId = `run-${live.handle.currentSessionId}`
      await sendUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `Netlify agent runner (${live.record.config.agent})`,
        kind: 'other',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: runUrl || `Agent runner ${live.handle.runnerId}` } }],
      })

      const result = await waitForResult(live, toolCallId)
      const succeeded = result.status === 'succeeded'
      await sendUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: succeeded ? 'completed' : 'failed' })

      try {
        if (live.cancelRequested || result.status === 'cancelled') return { stopReason: 'cancelled' }
        if (result.status === 'failed') {
          throw new Error(`Netlify agent runner ${result.runnerId} failed: ${result.failure.message}`)
        }
        if (result.status === 'timedOut') {
          throw new Error(`Netlify agent runner ${result.runnerId} timed out.`)
        }
        if (result.resultText) await say(localizeRunnerPaths(result.resultText, live.record.repoRoot))
        const changes = live.record.config.changes === 'pr'
          ? await openPullRequest(live)
          : await applyTurnChanges(live, result)
        if (changes) await say(`${result.resultText ? '\n\n' : ''}${changes}`)
        return { stopReason: 'end_turn' }
      } finally {
        if (reply.length > 0) {
          live.record = { ...live.record, transcript: [...live.record.transcript, { role: 'agent', text: reply.join('') }] }
        }
        save(live)
      }
    },

    /** @param {AcpCancelNotification} params */
    async cancel({ sessionId }) {
      const live = sessions.get(sessionId)
      if (!live || live.cancelRequested) return
      live.cancelRequested = true
      if (live.sdk && live.handle) await live.sdk.stop(live.handle)
    },
  }
}

module.exports = {
  createNaxAcpAgent,
  listAcpSites,
  promptText,
  resolveAcpSite,
  verifyAcpSiteRepo,
}
