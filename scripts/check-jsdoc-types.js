#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

/**
 * Forbidden JSDoc pattern descriptor.
 * @typedef {{
 *   name: string,
 *   pattern: RegExp,
 * }} ForbiddenPattern
 */

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

/** @type {ForbiddenPattern[]} */
const forbiddenPatterns = [
  { name: 'any JSDoc type', pattern: /\{[^}\n]*\bany\b[^}\n]*\}/ },
  { name: 'broad Object JSDoc type', pattern: /\{[^}\n]*\bObject\b[^}\n]*\}/ },
  { name: 'Record<string, any>', pattern: /Record<string,\s*any>/ },
  { name: '@ts-ignore', pattern: /@ts-ignore/ },
  { name: '@ts-expect-error', pattern: /@ts-expect-error/ },
]

const targetPaths = process.argv.slice(2)
const files = targetPaths.length > 0
  ? targetPaths.filter((filePath) => filePath.endsWith('.js'))
  : [
      path.join(process.cwd(), 'bin', 'nax.js'),
      ...listJavaScriptFiles(path.join(process.cwd(), 'src')),
    ]

const offenders = []

for (const filePath of files) {
  const source = fs.readFileSync(filePath, 'utf8')
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    const commentLike = trimmed.startsWith('/**')
      || trimmed.startsWith('*')
      || trimmed.startsWith('//')
      || trimmed.includes('/** @')
    if (!commentLike) continue
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.pattern.test(line)) {
        offenders.push({
          filePath,
          line: index + 1,
          reason: forbidden.name,
          text: line.trim(),
        })
      }
    }
  }
}

if (offenders.length > 0) {
  console.error('forbidden JSDoc patterns found:')
  for (const offender of offenders) {
    const relativePath = path.relative(process.cwd(), offender.filePath)
    console.error(`${relativePath}:${offender.line}: ${offender.reason}: ${offender.text}`)
  }
  process.exit(1)
}

console.log(`checked ${files.length} JavaScript files`)
