#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const PROJECT_ROOT = process.env.NAX_BOUNDARY_ROOT || process.cwd()

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'node:assert',
  'node:buffer',
  'node:child_process',
  'node:crypto',
  'node:events',
  'node:fs',
  'node:http',
  'node:https',
  'node:module',
  'node:os',
  'node:path',
  'node:process',
  'node:readline',
  'node:stream',
  'node:url',
  'os',
  'path',
  'process',
  'readline',
  'stream',
  'url',
])

const TOP_LEVEL_SRC_FILES = new Set([
  'types.js',
])

/**
 * @typedef {{
 *   filePath: string,
 *   specifier: string,
 *   resolvedPath: string,
 * }} ImportReference
 *
 * @typedef {{
 *   filePath: string,
 *   reason: string,
 *   detail: string,
 *   warning?: boolean,
 * }} BoundaryFinding
 */

/**
 * Recursively lists source files below a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function listSourceFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (fullPath.includes(path.join('src', 'dashboard', 'web', 'dist'))) return []
      return listSourceFiles(fullPath)
    }
    return entry.isFile() && /\.(js|mjs|ts|tsx)$/.test(entry.name) ? [fullPath] : []
  })
}

/** @param {string} filePath */
function toProjectPath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/')
}

/**
 * @param {string} filePath
 * @param {string} specifier
 */
function resolveImport(filePath, specifier) {
  if (!specifier.startsWith('.')) return specifier
  return path.normalize(path.join(path.dirname(filePath), specifier)).split(path.sep).join('/')
}

/**
 * @param {string} filePath
 * @param {string} source
 * @returns {ImportReference[]}
 */
function importsForSource(filePath, source) {
  const imports = []
  const patterns = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      imports.push({
        filePath,
        specifier,
        resolvedPath: resolveImport(filePath, specifier),
      })
    }
  }
  return imports
}

/**
 * @param {ImportReference} ref
 * @param {string[]} prefixes
 */
function importsPath(ref, prefixes) {
  return prefixes.some((prefix) => ref.resolvedPath === prefix || ref.resolvedPath.startsWith(`${prefix}/`))
}

/** @param {ImportReference} ref */
function importsCliEntrypoint(ref) {
  return ref.resolvedPath === 'src/cli/nax' || ref.resolvedPath === 'src/cli/nax.js'
}

/**
 * @param {BoundaryFinding[]} findings
 * @param {string} filePath
 * @param {string} reason
 * @param {string} detail
 * @param {boolean} [warning]
 */
function addFinding(findings, filePath, reason, detail, warning = false) {
  findings.push({
    filePath: toProjectPath(filePath),
    reason,
    detail,
    warning,
  })
}

/** @param {string} filePath */
function isUnder(filePath, dir) {
  const relative = path.relative(path.resolve(dir), path.resolve(filePath))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * @param {string} filePath
 * @param {ImportReference[]} imports
 * @param {BoundaryFinding[]} findings
 */
function checkDashboardApi(filePath, imports, findings) {
  if (!isUnder(filePath, path.join(PROJECT_ROOT, 'src', 'dashboard', 'api'))) return
  for (const ref of imports) {
    if (['fs', 'node:fs', 'child_process', 'node:child_process'].includes(ref.specifier)) {
      addFinding(findings, filePath, 'dashboard-api-local-node-import', ref.specifier)
    }
    if (importsPath(ref, [
      'src/run-state',
      'src/agent-selection',
      'src/status',
      'src/workflow-artifacts',
      'src/local-runner',
      'src/dashboard/storage',
      'src/dashboard/runtime/local-files',
    ])) {
      addFinding(
        findings,
        filePath,
        'dashboard-api-runtime-import',
        ref.resolvedPath,
      )
    }
  }
}

/**
 * @param {string} filePath
 * @param {ImportReference[]} imports
 * @param {BoundaryFinding[]} findings
 */
function checkDashboardWeb(filePath, imports, findings) {
  if (!isUnder(filePath, path.join(PROJECT_ROOT, 'src', 'dashboard', 'web', 'src'))) return
  for (const ref of imports) {
    if (NODE_BUILTINS.has(ref.specifier)) {
      addFinding(findings, filePath, 'dashboard-web-node-import', ref.specifier)
    }
    if (importsPath(ref, ['src/dashboard/api', 'src/workflows', 'src/integrations'])) {
      addFinding(findings, filePath, 'dashboard-web-internal-runtime-import', ref.resolvedPath)
    }
  }
}

/**
 * @param {string} filePath
 * @param {ImportReference[]} imports
 * @param {BoundaryFinding[]} findings
 */
function checkCore(filePath, imports, findings) {
  if (!isUnder(filePath, path.join(PROJECT_ROOT, 'src', 'core'))) return
  for (const ref of imports) {
    if (['fs', 'node:fs', 'child_process', 'node:child_process'].includes(ref.specifier)) {
      addFinding(findings, filePath, 'core-local-node-import', ref.specifier)
    }
    if (importsPath(ref, ['src/integrations', 'src/storage/local', 'src/dashboard'])) {
      addFinding(findings, filePath, 'core-runtime-import', ref.resolvedPath)
    }
  }
}

/** @param {BoundaryFinding[]} findings */
function checkTopLevelSrcInventory(findings) {
  const srcDir = path.join(PROJECT_ROOT, 'src')
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    if (!TOP_LEVEL_SRC_FILES.has(entry.name)) {
      addFinding(findings, path.join(srcDir, entry.name), 'new-top-level-src-file', 'Move new implementation files into a subsystem directory.')
    }
  }
}

/** @param {BoundaryFinding[]} findings */
function printFindings(findings) {
  const warnings = findings.filter((finding) => finding.warning)
  const errors = findings.filter((finding) => !finding.warning)
  if (warnings.length > 0) {
    console.warn('boundary warnings:')
    for (const finding of warnings) {
      console.warn(`${finding.filePath}: ${finding.reason}: ${finding.detail}`)
    }
  }
  if (errors.length > 0) {
    console.error('boundary violations:')
    for (const finding of errors) {
      console.error(`${finding.filePath}: ${finding.reason}: ${finding.detail}`)
    }
  }
}

/** @type {BoundaryFinding[]} */
const findings = []

for (const filePath of listSourceFiles(path.join(PROJECT_ROOT, 'src'))) {
  const source = fs.readFileSync(filePath, 'utf8')
  const imports = importsForSource(toProjectPath(filePath), source)
  if (toProjectPath(filePath) !== 'src/cli/nax.js' && imports.some(importsCliEntrypoint)) {
    addFinding(findings, filePath, 'src-imports-cli-entrypoint', 'src modules must not import the executable CLI entrypoint')
  }
  checkDashboardApi(filePath, imports, findings)
  checkDashboardWeb(filePath, imports, findings)
  checkCore(filePath, imports, findings)
}

checkTopLevelSrcInventory(findings)
printFindings(findings)

if (findings.some((finding) => !finding.warning)) {
  process.exit(1)
}

console.log('import direction ok')
