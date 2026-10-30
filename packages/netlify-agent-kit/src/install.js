const path = require('node:path')

const { loadConfig } = require('./config')
const { detect } = require('./detect')
const { excludePaths } = require('./exclude')
const { configureMcpServers } = require('./mcp')
const { commandEnv } = require('./paths')
const { writeRecord } = require('./record')
const { cloneRepository } = require('./repositories')
const { checkSecrets } = require('./secrets')
const { installSkills } = require('./skills/install')
const { resolveSource } = require('./skills/sources')
const { runShell } = require('./process')
const { installTool } = require('./tools')
const { version } = require('../package.json')

/**
 * @typedef {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   strict?: boolean,
 *   log?: (message: string) => void,
 *   config?: import('./config').AgentConfig,
 *   deps?: {
 *     tools?: import('./tools').ToolOptions,
 *     sources?: import('./skills/sources').SourceOptions,
 *     runShell?: typeof runShell,
 *     runFile?: import('./process').RunFile,
 *     repositoryBaseUrl?: string,
 *   },
 * }} InstallOptions
 *
 * @typedef {{ record: import('./record').InstallRecord | null, exitCode: number, skipped: boolean }} InstallResult
 */

/** @param {Error | unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Installs what the agent needs: secrets → repositories → tools → skills → MCP → run → exclusions.
 * Does nothing outside agent runners unless forced; a dry run shows the plan anywhere.
 * Never throws for step failures; they're recorded.
 * @param {InstallOptions} [options]
 * @returns {Promise<InstallResult>}
 */
async function install({
  cwd = process.cwd(),
  env = process.env,
  force = false,
  dryRun = false,
  strict,
  log = (message) => console.log(`[netlify-agent-kit] ${message}`),
  config: providedConfig,
  deps = {},
} = {}) {
  const detection = detect(env, { force: force || dryRun })
  if (!detection.active) {
    log(`skipped (${detection.label}: ${detection.reason})`)
    return { record: null, exitCode: 0, skipped: true }
  }

  const started = Date.now()
  /** @type {import('./record').InstallRecord} */
  const record = {
    version,
    at: new Date().toISOString(),
    cwd,
    detect: detection,
    dryRun,
    steps: [],
    warnings: [],
    errors: [],
    ms: 0,
  }

  let config = providedConfig || null
  if (!config) {
    const loaded = loadConfig(cwd)
    record.warnings.push(...loaded.warnings)
    record.errors.push(...loaded.errors)
    config = loaded.config
    if (!config && loaded.errors.length === 0) record.warnings.push('no netlify-agent.json or package.json#netlifyAgent config found')
  }
  const isStrict = strict ?? config?.strict ?? false

  /** @param {import('./record').InstallStep} step */
  const addStep = (step) => {
    record.steps.push(step)
    const label = [step.kind, step.name || step.repo || step.from || step.command].filter(Boolean).join(' ')
    if (step.status === 'error') {
      record.errors.push(`${label}: ${step.error}`)
      log(`✗ ${label}: ${step.error}`)
    } else {
      log(`${dryRun ? '·' : '✓'} ${label}: ${step.status}`)
    }
  }

  /** @type {string[]} */
  const repoPaths = []

  if (config && record.errors.length === 0) {
    log(dryRun ? 'would install:' : `installing (${detection.label}: ${detection.reason})`)

    const secretNames = [
      ...config.secrets,
      ...config.skills.map((skill) => skill.auth?.env).filter(Boolean),
      ...config.repositories.map((repo) => repo.auth?.env).filter(Boolean),
    ]
    if (secretNames.length > 0) {
      const { present, missing } = checkSecrets(secretNames, env)
      addStep({ kind: 'secrets', status: missing.length > 0 ? 'missing' : 'ok', present, missing })
      if (missing.length > 0) {
        const message = `missing environment variables: ${missing.join(', ')}`
        if (isStrict) record.errors.push(message)
        else record.warnings.push(message)
      }
    }

    for (const repo of config.repositories) {
      addStep(cloneRepository(repo, { env, dryRun, runFile: deps.runFile, baseUrl: deps.repositoryBaseUrl }))
    }

    for (const tool of config.tools) {
      if (dryRun) {
        addStep({ kind: 'tool', name: tool.name, status: 'would-install' })
        continue
      }
      try {
        const result = await installTool(tool, { env, cwd, ...deps.tools })
        addStep(result.step)
        repoPaths.push(...result.repoPaths)
        for (const warning of /** @type {string[]} */ (result.step.warnings || [])) record.warnings.push(warning)
      } catch (error) {
        addStep({ kind: 'tool', name: tool.name, status: 'error', error: messageOf(error) })
      }
    }

    for (const skill of config.skills) {
      const stepStarted = Date.now()
      try {
        const source = await resolveSource(skill, { env, cwd, ...deps.sources })
        try {
          const result = installSkills({ sourceDir: source.dir, from: skill.from, names: skill.names, cwd, env, dryRun })
          repoPaths.push(...result.createdPaths)
          const step = {
            kind: 'skills',
            from: skill.from,
            status: result.missing.length > 0 ? 'error' : dryRun ? 'would-install' : 'ok',
            installed: result.installed,
            skipped: result.skipped,
            targets: result.targets,
            token: source.tokenEnv,
            ms: Date.now() - stepStarted,
          }
          if (result.missing.length > 0) step.error = `not found in source: ${result.missing.join(', ')}`
          addStep(step)
        } finally {
          source.cleanup()
        }
      } catch (error) {
        addStep({ kind: 'skills', from: skill.from, status: 'error', error: messageOf(error), ms: Date.now() - stepStarted })
      }
    }

    if (Object.keys(config.mcpServers).length > 0) {
      if (config.experimental.mcpServers) {
        const step = configureMcpServers(config.mcpServers, { env, dryRun })
        addStep(step)
        const missing = /** @type {string[]} */ (step.missingEnv)
        if (missing.length > 0) record.warnings.push(`MCP servers skipped for missing variables: ${missing.join(', ')}`)
      } else {
        record.warnings.push('mcpServers ignored: set "experimental": { "mcpServers": true } to enable')
      }
    }

    for (const entry of config.run) {
      const runCwd = path.resolve(cwd, entry.cwd || '.')
      if (dryRun) {
        addStep({ kind: 'run', command: entry.command, cwd: entry.cwd || '.', status: 'would-run' })
        continue
      }
      const stepStarted = Date.now()
      try {
        const exitCode = (deps.runShell || runShell)(entry.command, { cwd: runCwd, env: commandEnv(env) })
        addStep({
          kind: 'run',
          command: entry.command,
          cwd: entry.cwd || '.',
          status: exitCode === 0 ? 'ok' : 'error',
          exitCode,
          ...(exitCode === 0 ? {} : { error: `exited with ${exitCode}` }),
          ms: Date.now() - stepStarted,
        })
      } catch (error) {
        addStep({ kind: 'run', command: entry.command, cwd: entry.cwd || '.', status: 'error', error: messageOf(error) })
      }
    }

    if (!dryRun) {
      const result = excludePaths(cwd, repoPaths, { runFile: deps.runFile })
      if (result.status === 'skipped') {
        if (repoPaths.length > 0) record.warnings.push(`couldn't hide installed files from git: ${result.reason}`)
        record.steps.push({ kind: 'exclude', status: 'skipped', reason: result.reason })
      } else {
        record.steps.push({ kind: 'exclude', status: 'ok', paths: result.patterns.length })
      }
    }
  } else if (record.errors.length > 0) {
    for (const error of record.errors) log(`✗ ${error}`)
  }

  for (const warning of record.warnings) log(`! ${warning}`)
  record.ms = Date.now() - started
  if (!dryRun) writeRecord(record, env)
  if (!dryRun) log(`${record.errors.length === 0 ? 'done' : `finished with ${record.errors.length} error(s)`} in ${Math.round(record.ms / 100) / 10}s. Run \`npx netlify-agent-kit status\` for details.`)

  return { record, exitCode: isStrict && record.errors.length > 0 ? 1 : 0, skipped: false }
}

module.exports = { install }
