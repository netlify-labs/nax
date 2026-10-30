const path = require('node:path')

const { detect } = require('./detect')
const { localBinDir } = require('./paths')
const { runShell } = require('./process')

/**
 * Environment for commands setup runs: ~/.local/bin first on PATH.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function commandEnv(env) {
  return { ...env, PATH: [localBinDir(env), env.PATH || ''].filter(Boolean).join(path.delimiter) }
}

/**
 * Runs one shell command, but only in an agent runner (or with local: true).
 * @param {string} command
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, local?: boolean, runShell?: typeof runShell }} [options]
 * @returns {{ skipped: boolean, exitCode: number, detect: import('./detect').Detection }}
 */
function run(command, { cwd = process.cwd(), env = process.env, local = false, runShell: shell = runShell } = {}) {
  const detection = detect(env, { local })
  if (!detection.active) return { skipped: true, exitCode: 0, detect: detection }
  return { skipped: false, exitCode: shell(command, { cwd, env: commandEnv(env) }), detect: detection }
}

module.exports = {
  commandEnv,
  run,
}
