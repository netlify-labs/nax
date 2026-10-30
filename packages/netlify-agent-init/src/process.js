const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * @typedef {{ status: number, stdout: string, stderr: string, error?: Error }} ProcessResult
 *
 * @typedef {(
 *   command: string,
 *   args: string[],
 *   options?: { cwd?: string, env?: NodeJS.ProcessEnv, input?: string },
 * ) => ProcessResult} RunFile
 */

/** @type {RunFile} */
function runFile(command, args, { cwd, env, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  }
}

/**
 * Runs a shell command with inherited stdio.
 * @param {string} command
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 */
function runShell(command, { cwd, env } = {}) {
  const result = spawnSync(command, { cwd, env, shell: true, stdio: 'inherit' })
  if (result.error) throw result.error
  if (typeof result.status === 'number') return result.status
  return result.signal ? 1 : 0
}

/**
 * Finds an executable on PATH without spawning a shell.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function which(name, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}

/**
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} [env]
 */
function isOnPath(dir, env = process.env) {
  const target = path.resolve(dir)
  return String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === target)
}

/** @param {string} dir */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

module.exports = {
  isOnPath,
  isWritableDir,
  runFile,
  runShell,
  which,
}
