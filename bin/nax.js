#!/usr/bin/env node

const main = require('../src/cli/commands/program')

/** @param {unknown} error */
function formatCaughtError(error) {
  if (error && typeof error === 'object') {
    const maybeError = /** @type {{ stack?: unknown, message?: unknown }} */ (error)
    if (typeof maybeError.stack === 'string' && maybeError.stack) return maybeError.stack
    if (typeof maybeError.message === 'string' && maybeError.message) return maybeError.message
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
