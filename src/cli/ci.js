const { spawnSync } = require('child_process')
const { classifyNetlifyRuntime } = require('../netlify/runtime')

/**
 * Process runner used by `nax ci`.
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options: import('child_process').SpawnSyncOptions,
 * ) => import('../types').CommandResult} CiRunCommand
 *
 * Injectable dependencies for `nax ci`.
 * @typedef {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   runCommand?: CiRunCommand,
 *   log?: (message: string) => void,
 * }} CiDependencies
 *
 * Result returned by the `nax ci` handler.
 * @typedef {{
 *   skipped: boolean,
 *   status: number,
 *   signal?: string,
 *   command: string,
 *   runtime: import('../netlify/runtime').NetlifyRuntimeClassification,
 * }} CiResult
 */

/**
 * Normalizes variadic Commander command parts into one shell command.
 * @param {string | string[]} [commandParts]
 * @returns {string}
 */
function normalizeCiCommand(commandParts = []) {
  return (Array.isArray(commandParts) ? commandParts : [commandParts])
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Runs a command only inside a Netlify Agent Runner environment.
 * @param {string | string[]} [commandParts]
 * @param {import('../commands/options').CliOptions} [options]
 * @param {CiDependencies} [dependencies]
 * @returns {CiResult}
 */
function handleCi(commandParts = [], options = {}, {
  cwd = process.cwd(),
  env = process.env,
  runCommand = spawnSync,
  log = console.log,
} = {}) {
  const commandText = normalizeCiCommand(commandParts)
  if (!commandText) throw new Error('Usage: nax ci <command>')

  const runtime = classifyNetlifyRuntime(env)
  if (!runtime.isAgentRunner) {
    if (!options.quiet) log(`nax ci: skipped ${commandText} (${runtime.label}: ${runtime.reason})`)
    return {
      skipped: true,
      status: 0,
      command: commandText,
      runtime,
    }
  }

  if (!options.quiet) log(`nax ci: running ${commandText} (${runtime.reason})`)
  const result = runCommand(commandText, [], {
    cwd,
    env,
    shell: true,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  return {
    skipped: false,
    status: Number.isInteger(result.status) ? result.status : (result.signal ? 1 : 0),
    signal: result.signal || '',
    command: commandText,
    runtime,
  }
}

module.exports = {
  handleCi,
  normalizeCiCommand,
}
