#!/usr/bin/env node

const main = require('../src/commands/program')

if (require.main === module) {
  main.buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = main
