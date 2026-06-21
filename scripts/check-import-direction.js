#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

/**
 * Recursively lists JavaScript files below a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function listJavaScriptFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return listJavaScriptFiles(fullPath)
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : []
  })
}

const offenders = []

for (const filePath of listJavaScriptFiles(path.join(process.cwd(), 'src'))) {
  const source = fs.readFileSync(filePath, 'utf8')
  if (source.includes("require('../bin/nax") || source.includes("require('../../bin/nax")) {
    offenders.push(path.relative(process.cwd(), filePath))
  }
}

if (offenders.length > 0) {
  console.error('src modules must not import bin/nax.js:')
  for (const offender of offenders) console.error(`- ${offender}`)
  process.exit(1)
}

console.log('import direction ok')
