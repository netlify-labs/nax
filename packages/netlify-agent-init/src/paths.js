const os = require('node:os')
const path = require('node:path')

/** @param {NodeJS.ProcessEnv} [env] */
function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir()
}

/** @param {NodeJS.ProcessEnv} [env] */
function cacheDir(env = process.env) {
  return path.join(homeDir(env), '.cache', 'netlify-agent-init')
}

/** @param {NodeJS.ProcessEnv} [env] */
function recordPath(env = process.env) {
  return path.join(cacheDir(env), 'last-setup.json')
}

/** @param {NodeJS.ProcessEnv} [env] */
function localBinDir(env = process.env) {
  return path.join(homeDir(env), '.local', 'bin')
}

/**
 * Replaces the home directory with ~ for display and records.
 * @param {string} filePath
 * @param {NodeJS.ProcessEnv} [env]
 */
function tildify(filePath, env = process.env) {
  const home = homeDir(env)
  return filePath === home || filePath.startsWith(home + path.sep)
    ? '~' + filePath.slice(home.length)
    : filePath
}

module.exports = {
  cacheDir,
  homeDir,
  localBinDir,
  recordPath,
  tildify,
}
