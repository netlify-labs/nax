const fs = require('node:fs')
const path = require('node:path')

const { recordPath } = require('./paths')

/**
 * @typedef {{ kind: string, status: string, [key: string]: unknown }} InstallStep
 *
 * @typedef {{
 *   version: string,
 *   at: string,
 *   cwd: string,
 *   detect: import('./detect').Detection,
 *   dryRun: boolean,
 *   steps: InstallStep[],
 *   warnings: string[],
 *   errors: string[],
 *   ms: number,
 * }} InstallRecord
 */

/**
 * Writes the record atomically. Callers only put variable names in it, never values.
 * @param {InstallRecord} record
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function writeRecord(record, env = process.env) {
  const file = recordPath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return file
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {InstallRecord | null}
 */
function readRecord(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(env), 'utf8'))
  } catch {
    return null
  }
}

module.exports = {
  readRecord,
  writeRecord,
}
