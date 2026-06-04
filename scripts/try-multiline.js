#!/usr/bin/env node
'use strict'

const { multiline } = require('../src/multiline')

function parseFlag(argv, name) {
  const i = argv.indexOf(`--${name}`)
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return null
}

async function main() {
  const argv = process.argv.slice(2)
  const message = parseFlag(argv, 'message') || 'Try the multiline prompt'
  const placeholder = parseFlag(argv, 'placeholder') || 'Type something. Shift+Enter inserts a newline. ↑↓←→ navigate. Home/End jump.'
  const initialValue = parseFlag(argv, 'initial') || ''

  console.log('--- multiline harness ---')
  console.log('Try these:')
  console.log('  - Type a few lines (Shift+Enter for new line)')
  console.log('  - Press ↑/↓/←/→ to navigate, Home/End to jump')
  console.log('  - Insert characters mid-line; verify tail repaints')
  console.log('  - Submit with Enter; the line below should print on a fresh row')
  console.log('-------------------------')

  const value = await multiline({ message, placeholder, initialValue })

  console.log('Next line should appear here, on a fresh row, without overlapping the input.')
  console.log('--- captured ---')
  console.log(JSON.stringify(value))
  console.log('--- end ---')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
