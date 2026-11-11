// Shared nax acp test fixtures: a real git clone of a bare origin, and a scripted Agent Runner API.
// The scripted API stands in for the network edge only; the real SDK engine runs on top of it.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A clone of a bare origin with readme.md pushed on main and .nax already ignored. */
function clonedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-acp-agent-'))
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  git(root, ['init', '-q', '--bare', '-b', 'main', origin])
  git(root, ['clone', '-q', origin, work])
  git(work, ['config', 'user.email', 'nax@example.com'])
  git(work, ['config', 'user.name', 'nax'])
  git(work, ['checkout', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(work, 'readme.md'), 'hello\n')
  fs.writeFileSync(path.join(work, '.gitignore'), '.nax/\n')
  git(work, ['add', '.'])
  git(work, ['commit', '-q', '-m', 'init'])
  git(work, ['push', '-q', 'origin', 'main'])
  return work
}

/** @param {string} line */
function appendPatch(line) {
  return [
    'diff --git a/readme.md b/readme.md',
    '--- a/readme.md',
    '+++ b/readme.md',
    '@@ -1 +1,2 @@',
    ' hello',
    `+${line}`,
    '',
  ].join('\n')
}

/**
 * Scripted Agent Runner API: each session walks its script, one step per poll.
 * @param {{ scripts: Record<string, Array<{ state: string, currentTask?: string, resultText?: string, hasResultDiff?: boolean }>>, patches?: Record<string, string> }} input
 */
function runnerApi({ scripts, patches = {} }) {
  const calls = []
  /** @type {Array<{ sessionId: string, prompt: string, step: number }>} */
  const sessions = []
  let cancelled = false
  let prUrl
  const current = (sessionId) => {
    const session = sessions.find((candidate) => candidate.sessionId === sessionId)
    const script = scripts[sessionId]
    if (cancelled) return { state: 'cancelled' }
    return script[Math.min(session.step, script.length - 1)]
  }
  const sessionView = (sessionId) => ({
    sessionId,
    runnerId: 'runner-1',
    prompt: sessions.find((candidate) => candidate.sessionId === sessionId).prompt,
    usage: null,
    ...current(sessionId),
  })
  const runnerView = () => {
    const latest = sessions[sessions.length - 1]
    return {
      runnerId: 'runner-1',
      siteId: 'site-1',
      siteName: 'my-site',
      codeOrigin: 'github',
      branch: 'main',
      state: current(latest.sessionId).state,
      ...(prUrl ? { prUrl } : {}),
    }
  }
  const transport = /** @type {import('nax-agent-runner-sdk').Transport} */ ({
    async createRunner(input) {
      calls.push({ op: 'createRunner', input })
      sessions.push({ sessionId: 'session-1', prompt: String(input.prompt), step: 0 })
      return runnerView()
    },
    async createSession(runnerId, input) {
      calls.push({ op: 'createSession', runnerId, input })
      const sessionId = `session-${sessions.length + 1}`
      sessions.push({ sessionId, prompt: String(input.prompt), step: 0 })
      return sessionView(sessionId)
    },
    async getRunner() {
      return runnerView()
    },
    async getSession(_runnerId, sessionId) {
      const view = sessionView(sessionId)
      sessions.find((candidate) => candidate.sessionId === sessionId).step += 1
      return view
    },
    async listSessions() {
      return sessions.map((session) => ({ ...sessionView(session.sessionId) }))
    },
    async listRunners() { throw new Error('unexpected listRunners') },
    async listAccountRunners() { throw new Error('unexpected listAccountRunners') },
    async cancelRunner(runnerId) {
      calls.push({ op: 'cancelRunner', runnerId })
      cancelled = true
    },
    async cancelSession(runnerId, sessionId) {
      calls.push({ op: 'cancelSession', runnerId, sessionId })
      cancelled = true
    },
    async member(runnerId, action) {
      calls.push({ op: 'member', action })
      if (action === 'diff') return { diff: null }
      if (action === 'pull_request') {
        prUrl = 'https://github.com/acme/site/pull/7'
        return runnerView()
      }
      throw new Error(`unexpected member action ${action}`)
    },
  })
  const api = {
    async requestResponse(method, apiPath) {
      calls.push({ op: 'request', method, apiPath })
      const match = apiPath.match(/^\/agent_runners\/runner-1\/sessions\/([^/]+)\/diff\/result$/)
      const text = match ? patches[match[1]] : undefined
      return text
        ? { ok: true, status: 200, text, payload: null }
        : { ok: false, status: 404, text: '{"code":404,"message":"Not Found"}', payload: null }
    },
  }
  return { transport, api, calls }
}

module.exports = {
  appendPatch,
  clonedRepo,
  git,
  runnerApi,
}
