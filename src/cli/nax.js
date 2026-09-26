#!/usr/bin/env node

/**
 * Loads the CLI modules with `--json` hidden from process.argv.
 * @davidwells/box-logger reads argv at require time and disables colors on `--json`, and its
 * disabled chalk returns strings from `hex()`, which crashes box rendering during program build.
 * @returns {typeof import('./commands/program')}
 */
function loadProgramWithoutJsonArgv() {
  if (!process.argv.includes('--json')) return require('./commands/program')
  const originalArgv = process.argv
  process.argv = process.argv.filter((arg) => arg !== '--json')
  try {
    return require('./commands/program')
  } finally {
    process.argv = originalArgv
  }
}

const main = loadProgramWithoutJsonArgv()

/** @param {unknown} error */
function formatCaughtError(error) {
  if (error && typeof error === 'object') {
    const maybeError = /** @type {{ stack?: unknown, message?: unknown }} */ (error)
    if (typeof maybeError.message === 'string' && maybeError.message) return maybeError.message
    if (typeof maybeError.stack === 'string' && maybeError.stack) return maybeError.stack
  }
  return String(error)
}

if (require.main === module) {
  main.buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(formatCaughtError(error))
    process.exit(1)
  })
}

module.exports = main
