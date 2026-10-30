const fs = require('node:fs')
const path = require('node:path')

const { PACKAGE_KEY, normalizeConfig } = require('./config')
const { PRESETS } = require('./presets')
const { version } = require('../package.json')

const COMMAND = 'netlify-agent-kit'
const INSTALL = `${COMMAND} install`

/**
 * Chains our install onto an existing postinstall, guarded so installs that skip
 * devDependencies don't fail.
 * @param {string | undefined} existing
 */
function buildPostinstall(existing) {
  if (!existing || !existing.trim()) return `${INSTALL} || exit 0`
  if (existing.includes(COMMAND)) return existing
  return `${existing} && (${INSTALL} || exit 0)`
}

/**
 * Plans what `add` changes without writing anything.
 * @param {{
 *   cwd: string,
 *   preset?: string,
 *   options?: Record<string, string>,
 *   runFile?: import('./process').RunFile,
 * }} input
 * @returns {{
 *   packageJsonPath: string,
 *   packageJson: Record<string, unknown>,
 *   notes: string[],
 *   warnings: string[],
 *   errors: string[],
 *   isNewPackage: boolean,
 * }}
 */
function planAdd({ cwd, preset, options = {}, runFile }) {
  const packageJsonPath = path.join(cwd, 'package.json')
  const isNewPackage = !fs.existsSync(packageJsonPath)
  /** @type {Record<string, unknown> & { scripts?: Record<string, string>, devDependencies?: Record<string, string>, private?: boolean }} */
  const pkg = isNewPackage
    ? { name: path.basename(cwd), private: true }
    : JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const notes = []
  const warnings = []
  const fail = (/** @type {string} */ message) => ({
    packageJsonPath, packageJson: pkg, notes, warnings, errors: [message], isNewPackage,
  })

  if (!isNewPackage && pkg.private !== true) {
    warnings.push('package.json is not "private": true. If this package is published, its postinstall would run in every downstream install.')
  }

  const current = pkg[PACKAGE_KEY]
  /** @type {Record<string, unknown>} */
  const nextConfig = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}

  if (preset) {
    const definition = PRESETS[preset]
    if (!definition) return fail(`unknown preset "${preset}". Available: ${Object.keys(PRESETS).join(', ')}`)
    try {
      const detected = definition.detectOptions({ cwd, options, runFile })
      notes.push(...detected.notes)
      nextConfig[preset] = detected.options
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  const normalized = normalizeConfig(nextConfig, `package.json#${PACKAGE_KEY}`)
  pkg.scripts = { ...(pkg.scripts || {}), postinstall: buildPostinstall(pkg.scripts?.postinstall) }
  pkg.devDependencies = { ...(pkg.devDependencies || {}), [COMMAND]: `^${version}` }
  pkg[PACKAGE_KEY] = nextConfig

  return {
    packageJsonPath,
    packageJson: pkg,
    notes,
    warnings: [...warnings, ...normalized.warnings],
    errors: normalized.errors,
    isNewPackage,
  }
}

/**
 * Writes a plan from planAdd.
 * @param {ReturnType<typeof planAdd>} plan
 */
function applyAdd(plan) {
  fs.writeFileSync(plan.packageJsonPath, JSON.stringify(plan.packageJson, null, 2) + '\n')
}

module.exports = {
  applyAdd,
  buildPostinstall,
  planAdd,
}
