const fs = require('node:fs')
const path = require('node:path')

const { homeDir } = require('./paths')

/**
 * Resolves { env, prefix } references to values.
 * @param {Record<string, string | import('./config').EnvValueRef> | undefined} values
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} missing
 * @returns {Record<string, string> | undefined}
 */
function resolveValues(values, env, missing) {
  if (!values) return undefined
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      out[key] = value
    } else if (value && typeof value.env === 'string') {
      if (!env[value.env]) missing.push(value.env)
      else out[key] = `${value.prefix || ''}${env[value.env]}`
    }
  }
  return out
}

/**
 * Experimental: adds MCP servers to Claude Code's user-level config (~/.claude.json).
 * Existing servers with the same name are left alone. The file is written 0600.
 * @param {Record<string, import('./config').McpServerSpec>} servers
 * @param {{ env?: NodeJS.ProcessEnv, dryRun?: boolean }} [options]
 * @returns {import('./record').SetupStep}
 */
function configureMcpServers(servers, { env = process.env, dryRun = false } = {}) {
  const file = path.join(homeDir(env), '.claude.json')
  /** @type {Record<string, unknown>} */
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    current = {}
  }
  const existing = /** @type {Record<string, unknown>} */ (current.mcpServers || {})
  const added = []
  const skipped = []
  /** @type {string[]} */
  const missing = []
  for (const [name, spec] of Object.entries(servers)) {
    if (existing[name]) {
      skipped.push(name)
      continue
    }
    const missingBefore = missing.length
    const server = {
      ...(spec.type ? { type: spec.type } : {}),
      ...(spec.command ? { command: spec.command, args: spec.args || [] } : {}),
      ...(spec.url ? { url: spec.url, type: spec.type || 'http' } : {}),
      ...(spec.env ? { env: resolveValues(spec.env, env, missing) } : {}),
      ...(spec.headers ? { headers: resolveValues(spec.headers, env, missing) } : {}),
    }
    if (missing.length > missingBefore) {
      skipped.push(name)
      continue
    }
    existing[name] = server
    added.push(name)
  }
  if (!dryRun && added.length > 0) {
    current.mcpServers = existing
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  }
  return {
    kind: 'mcp',
    status: missing.length > 0 ? 'partial' : 'ok',
    file: '~/.claude.json',
    added,
    skipped,
    missingEnv: [...new Set(missing)],
  }
}

module.exports = { configureMcpServers }
