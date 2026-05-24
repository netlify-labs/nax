#!/usr/bin/env node
'use strict'

if (process.env.FORCE_COLOR) delete process.env.NO_COLOR

const { _private } = require('../bin/nax')

const DEFAULT_WIDTH = 118

function parseWidth(argv) {
  const index = argv.indexOf('--width')
  if (index !== -1 && argv[index + 1]) {
    const value = Number.parseInt(argv[index + 1], 10)
    if (Number.isFinite(value) && value > 0) return value
  }
  const inline = argv.find((arg) => arg.startsWith('--width='))
  if (inline) {
    const value = Number.parseInt(inline.slice('--width='.length), 10)
    if (Number.isFinite(value) && value > 0) return value
  }
  return process.stdout.columns || DEFAULT_WIDTH
}

const width = parseWidth(process.argv.slice(2))
const useCases = _private.AGENT_RUNNER_USE_CASES || []

for (const [index, useCase] of useCases.entries()) {
  const color = _private.DID_YOU_KNOW_BORDER_COLORS?.[index % _private.DID_YOU_KNOW_BORDER_COLORS.length]
  const [, ...boxLines] = _private.formatDidYouKnowLines(useCase, { width, color })
  if (index > 0) console.log('')
  console.log(boxLines.join('\n'))
}
